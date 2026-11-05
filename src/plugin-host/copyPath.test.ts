import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inWorker, settle } from './relayHarness';

// 同梱の段 2 の部品「パスをコピー」（src/features/copy-path/worker.js）のコードを、relay.js が作る Worker の前置きの上で動かす。
// 本体の側（権限、結果）は、このテストが偽物として返す。

const SOURCE = readFileSync(new URL('../features/copy-path/worker.js', import.meta.url), 'utf8');

function start() {
  const w = inWorker(SOURCE, 'copy-path');
  w.deliver({ kind: 'init' });
  return w;
}
const calls = (w: ReturnType<typeof start>) => w.posted.filter((m) => m.kind === 'call');

describe('the copy-path part code', () => {
  it('registers the command (Mod+Alt+C) and the tree menu item (パスをコピー) in its first run', () => {
    const w = inWorker(SOURCE, 'copy-path');
    expect(w.posted).toEqual([
      { kind: 'command', id: 'copy-current-path', title: '開いている文書のパスをコピー', shortcut: 'Mod+Alt+C', ignoreInTextEntry: true },
      { kind: 'menu', id: 'copy-path', title: 'パスをコピー', where: 'tree' },
    ]);
  });

  it('the command asks for the current path, then writes it to the clipboard, then finishes', async () => {
    const w = start();
    w.posted.length = 0;
    w.deliver({ kind: 'run', req: 1, command: 'copy-current-path' });
    await settle();
    expect(calls(w)).toEqual([{ kind: 'call', call: 1, method: 'currentPath' }]);
    w.deliver({ kind: 'result', call: 1, ok: true, value: '/docs/a.md' });
    await settle();
    expect(calls(w).at(-1)).toEqual({ kind: 'call', call: 2, method: 'clipboardWriteText', text: '/docs/a.md' });
    w.deliver({ kind: 'result', call: 2, ok: true, value: null });
    await settle();
    expect(w.posted.at(-1)).toEqual({ kind: 'done', req: 1 });
  });

  it('does nothing for an unsaved new document (the path is null): no clipboard call, and the run succeeds', async () => {
    const w = start();
    w.posted.length = 0;
    w.deliver({ kind: 'run', req: 1, command: 'copy-current-path' });
    await settle();
    w.deliver({ kind: 'result', call: 1, ok: true, value: null });
    await settle();
    expect(calls(w)).toHaveLength(1);
    expect(w.posted.at(-1)).toEqual({ kind: 'done', req: 1 });
  });

  it('the menu item writes the path of the row it was chosen on (a file and a folder)', async () => {
    const w = start();
    for (const [req, target, path] of [
      [1, 'file', '/work/a.md'],
      [2, 'folder', '/work/dir'],
    ] as const) {
      w.posted.length = 0;
      w.deliver({ kind: 'runMenu', req, item: 'copy-path', path, target });
      await settle();
      expect(calls(w)).toEqual([{ kind: 'call', call: req, method: 'clipboardWriteText', text: path }]);
      w.deliver({ kind: 'result', call: req, ok: true, value: null });
      await settle();
      expect(w.posted.at(-1)).toEqual({ kind: 'done', req });
    }
  });

  it('keeps running (done, not failed) when the host refuses: denied, a closed confirmation, or a failed write', async () => {
    const w = start();
    w.posted.length = 0;
    // 文書のパスを知る権限を断られた。
    w.deliver({ kind: 'run', req: 1, command: 'copy-current-path' });
    await settle();
    w.deliver({ kind: 'result', call: 1, ok: false, reason: '許可していません' });
    await settle();
    expect(w.posted.at(-1)).toEqual({ kind: 'done', req: 1 });
    // クリップボードに書く権限を断られた（メニューの項目）。
    w.deliver({ kind: 'runMenu', req: 2, item: 'copy-path', path: '/work/a.md', target: 'file' });
    await settle();
    w.deliver({ kind: 'result', call: 2, ok: false, reason: '許可していません' });
    await settle();
    expect(w.posted.at(-1)).toEqual({ kind: 'done', req: 2 });
    expect(w.posted.some((m) => m.kind === 'failed')).toBe(false);
  });

  it('ignores a path that is not a non-empty string', async () => {
    const w = start();
    w.posted.length = 0;
    w.deliver({ kind: 'run', req: 1, command: 'copy-current-path' });
    await settle();
    w.deliver({ kind: 'result', call: 1, ok: true, value: '' });
    await settle();
    expect(calls(w)).toHaveLength(1);
  });
});
