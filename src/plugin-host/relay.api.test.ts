import { describe, expect, it } from 'vitest';
import { FakeWorker, bootRelay, inWorker, settle, startMessage } from './relayHarness';

// R6: relay.js の、呼び出し（call）・結果（result）・メニューの項目（menu、runMenu）と、Worker の中の API（api.clipboard など）。

describe('the API in the Worker (R6)', () => {
  const api = (self: Record<string, unknown>) =>
    self.api as {
      clipboard: { writeText(t: unknown): Promise<unknown> };
      document: { currentPath(): Promise<unknown> };
      registerContextMenuItem(r: unknown): void;
    };

  it('keeps the enumerable api as before (registerCommand only); the R6 members exist but are not enumerated; api is frozen', () => {
    const { self } = inWorker('');
    expect(Object.keys(self.api as object)).toEqual(['registerCommand']);
    expect(Object.getOwnPropertyNames(self.api as object).sort()).toEqual(['clipboard', 'document', 'registerCommand', 'registerContextMenuItem']);
    expect(Object.isFrozen(self.api)).toBe(true);
    expect(Object.isFrozen(api(self).clipboard)).toBe(true);
    expect(Object.isFrozen(api(self).document)).toBe(true);
  });

  it('sends a call with a number, and resolves with the value of the result (null for an unsaved document)', async () => {
    const { self, posted, deliver } = inWorker('');
    const promise = api(self).document.currentPath();
    expect(posted).toEqual([{ kind: 'call', call: 1, method: 'currentPath' }]);
    deliver({ kind: 'result', call: 1, ok: true, value: '/docs/a.md' });
    await expect(promise).resolves.toBe('/docs/a.md');
    const second = api(self).document.currentPath();
    expect(posted.at(-1)).toEqual({ kind: 'call', call: 2, method: 'currentPath' });
    deliver({ kind: 'result', call: 2, ok: true, value: null });
    await expect(second).resolves.toBeNull();
  });

  it('rejects a call with the reason of a failed result (the part is not stopped: it is a Promise rejection)', async () => {
    const { self, posted, deliver } = inWorker('');
    const promise = api(self).clipboard.writeText('x');
    expect(posted).toEqual([{ kind: 'call', call: 1, method: 'clipboardWriteText', text: 'x' }]);
    deliver({ kind: 'result', call: 1, ok: false, reason: '利用者が許可していません' });
    await expect(promise).rejects.toThrow('利用者が許可していません');
  });

  it('rejects locally (no message) for a bad argument: empty, not a string, over 100000 characters', async () => {
    const { self, posted } = inWorker('');
    // Worker は別の文脈（vm）なので、TypeError は名前で確かめる。
    for (const bad of ['', 5, null, undefined, 'x'.repeat(100001)]) await expect(api(self).clipboard.writeText(bad)).rejects.toMatchObject({ name: 'TypeError' });
    expect(posted).toEqual([]);
    // 上限ちょうどは送る。
    void api(self).clipboard.writeText('x'.repeat(100000));
    expect(posted).toHaveLength(1);
  });

  it('rejects a 17th call while 16 are waiting, and a result for a number nobody asked about changes nothing', async () => {
    const { self, posted, deliver } = inWorker('');
    const waiting = Array.from({ length: 16 }, () => api(self).document.currentPath());
    await expect(api(self).document.currentPath()).rejects.toThrow('多すぎます');
    expect(posted).toHaveLength(16);
    deliver({ kind: 'result', call: 999, ok: true, value: 'x' });
    deliver({ kind: 'result', call: 1, ok: true, value: 'a' });
    await expect(waiting[0]).resolves.toBe('a');
    // 空いたので、もう 1 つ送れる。
    void api(self).document.currentPath();
    expect(posted).toHaveLength(17);
  });

  it('registers a context menu item only in the first run, with a checked shape, and runs it with the target', async () => {
    const { self, posted, deliver } = inWorker(
      `api.registerContextMenuItem({ id: 'copy', title: 'コピー', where: 'tree', run: async (t) => { self.seen = t; } });`,
    );
    expect(posted).toEqual([{ kind: 'menu', id: 'copy', title: 'コピー', where: 'tree' }]);
    deliver({ kind: 'init' });
    expect(() => api(self).registerContextMenuItem({ id: 'late', title: 't', where: 'tree', run() {} })).toThrow('最初の実行');
    posted.length = 0;
    deliver({ kind: 'runMenu', req: 3, item: 'copy', path: '/work/a.md', target: 'file' });
    await settle();
    expect(self.seen).toEqual({ path: '/work/a.md', kind: 'file' });
    expect(posted).toEqual([{ kind: 'done', req: 3 }]);
  });

  it.each([
    ['a bad id', `{ id: 'Bad', title: 't', where: 'tree', run() {} }`],
    ['an empty title', `{ id: 'x', title: '', where: 'tree', run() {} }`],
    ['another place', `{ id: 'x', title: 't', where: 'editor', run() {} }`],
    ['no where', `{ id: 'x', title: 't', run() {} }`],
    ['no run', `{ id: 'x', title: 't', where: 'tree' }`],
    ['null', 'null'],
  ])('throws inside the Worker for %s (a part error, nothing is sent)', (_name, registration) => {
    expect(() => inWorker(`api.registerContextMenuItem(${registration})`)).toThrow();
  });

  it('allows 8 menu items and refuses the 9th and a repeated id', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `api.registerContextMenuItem({ id: 'i${i}', title: 't', where: 'tree', run() {} });`).join('\n');
    expect(inWorker(many(8)).posted).toHaveLength(8);
    expect(() => inWorker(many(9))).toThrow('多すぎます');
    expect(() => inWorker(`${many(1)}\n${many(1)}`)).toThrow('登録済み');
  });
});

describe('relay.js: calls, results, and menu items between the Worker and the parent', () => {
  const boot = () => {
    const r = bootRelay();
    r.fromMain(startMessage('a'));
    r.fromMain(startMessage('b'));
    const [a, b] = FakeWorker.all as [FakeWorker, FakeWorker];
    return { ...r, a, b };
  };

  it('forwards a call with the plugin id, and returns the result to the Worker only for a number that is waiting', () => {
    const r = boot();
    r.a.emit({ kind: 'call', call: 4, method: 'clipboardWriteText', text: '/p' });
    r.a.emit({ kind: 'call', call: 5, method: 'currentPath' });
    expect(r.sent().slice(1)).toEqual([
      { kind: 'call', plugin: 'a', call: 4, method: 'clipboardWriteText', text: '/p', v: 0 },
      { kind: 'call', plugin: 'a', call: 5, method: 'currentPath', v: 0 },
    ]);
    r.fromMain({ v: 0, kind: 'result', plugin: 'a', call: 4, ok: true, value: null });
    r.fromMain({ v: 0, kind: 'result', plugin: 'a', call: 5, ok: false, reason: 'no' });
    expect(r.a.sent).toEqual([{ kind: 'init' }, { kind: 'result', call: 4, ok: true, value: null }, { kind: 'result', call: 5, ok: false, reason: 'no' }]);
    // もう待っていない番号、別の部品の番号、形が違う結果は、通さない。
    const before = r.a.sent.length;
    r.fromMain({ v: 0, kind: 'result', plugin: 'a', call: 4, ok: true, value: null });
    r.fromMain({ v: 0, kind: 'result', plugin: 'b', call: 5, ok: true, value: null });
    r.a.emit({ kind: 'call', call: 6, method: 'currentPath' });
    r.fromMain({ v: 0, kind: 'result', plugin: 'a', call: 6, ok: true });
    r.fromMain({ v: 0, kind: 'result', plugin: 'a', call: 6, ok: true, value: 'x', reason: 'y' });
    r.fromMain({ v: 0, kind: 'result', plugin: 'a', call: 6, ok: false, reason: '' });
    r.fromMain({ v: 0, kind: 'result', plugin: 'a', call: 6, ok: true, value: 'x'.repeat(4097) });
    r.fromMain({ v: 0, kind: 'result', plugin: 'a', call: 6, ok: true, value: 5 });
    r.fromMain({ v: 0, kind: 'result', plugin: 'a', call: 6, ok: 'yes', value: 'x' });
    r.fromMain({ v: 0, kind: 'result', plugin: 'a', call: 6, ok: true, value: 'x', extra: 1 });
    expect(r.a.sent).toHaveLength(before);
    expect(r.a.terminated).toBe(0);
  });

  it.each([
    ['an unknown method', { kind: 'call', call: 1, method: 'readClipboard' }],
    ['a method with the wrong fields (text for currentPath)', { kind: 'call', call: 1, method: 'currentPath', text: 'x' }],
    ['a write without text', { kind: 'call', call: 1, method: 'clipboardWriteText' }],
    ['an empty text', { kind: 'call', call: 1, method: 'clipboardWriteText', text: '' }],
    ['a text over 100000 characters', { kind: 'call', call: 1, method: 'clipboardWriteText', text: 'x'.repeat(100001) }],
    ['a text that is not a string', { kind: 'call', call: 1, method: 'clipboardWriteText', text: 5 }],
    ['a zero number', { kind: 'call', call: 0, method: 'currentPath' }],
    ['a fractional number', { kind: 'call', call: 1.5, method: 'currentPath' }],
    ['a string number', { kind: 'call', call: '1', method: 'currentPath' }],
    ['an extra field', { kind: 'call', call: 1, method: 'currentPath', extra: true }],
    ['a menu item in another place', { kind: 'menu', id: 'x', title: 't', where: 'editor' }],
    ['a menu item with a bad id', { kind: 'menu', id: 'X', title: 't', where: 'tree' }],
    ['a menu item with a long title', { kind: 'menu', id: 'x', title: 't'.repeat(201), where: 'tree' }],
    ['a menu item with an extra field', { kind: 'menu', id: 'x', title: 't', where: 'tree', run: 'x' }],
  ])('stops the part on %s (an invalid call or menu message)', (_name, message) => {
    const r = boot();
    r.a.emit(message);
    expect(r.a.terminated).toBe(1);
    expect(r.sent().at(-1)).toMatchObject({ kind: 'stopped', plugin: 'a' });
    expect(String(r.sent().at(-1)!.reason)).toContain('不正なメッセージ');
    expect(r.b.terminated).toBe(0);
  });

  it('stops the part that repeats a waiting call number, or has 17 waiting calls', () => {
    const dup = boot();
    dup.a.emit({ kind: 'call', call: 1, method: 'currentPath' });
    dup.a.emit({ kind: 'call', call: 1, method: 'currentPath' });
    expect(dup.a.terminated).toBe(1);
    const many = boot();
    for (let i = 1; i <= 17; i++) many.a.emit({ kind: 'call', call: i, method: 'currentPath' });
    expect(many.a.terminated).toBe(1);
    expect(many.sent().filter((m) => m.kind === 'call')).toHaveLength(16);
  });

  it('allows calls before ready, but a call after the part is stopped passes nothing', () => {
    const r = boot();
    r.a.emit({ kind: 'call', call: 1, method: 'currentPath' });
    expect(r.sent().at(-1)).toMatchObject({ kind: 'call', plugin: 'a', call: 1 });
    r.fromMain({ v: 0, kind: 'stop', plugin: 'a' });
    const count = r.sent().length;
    r.a.emit({ kind: 'call', call: 2, method: 'currentPath' });
    expect(r.sent()).toHaveLength(count);
  });

  it('forwards a menu item registration (only before ready, at most 8, no repeated id) and runs it with the target', () => {
    const r = boot();
    r.a.emit({ kind: 'menu', id: 'copy', title: 'コピー', where: 'tree' });
    expect(r.sent().at(-1)).toEqual({ kind: 'menu', plugin: 'a', id: 'copy', title: 'コピー', where: 'tree', v: 0 });
    r.a.emit({ kind: 'ready' });
    r.fromMain({ v: 0, kind: 'runMenu', plugin: 'a', req: 2, item: 'copy', path: '/work/a.md', targetKind: 'file' });
    expect(r.a.sent.at(-1)).toEqual({ kind: 'runMenu', req: 2, item: 'copy', path: '/work/a.md', target: 'file' });
    r.a.emit({ kind: 'done', req: 2 });
    expect(r.sent().at(-1)).toEqual({ kind: 'done', plugin: 'a', req: 2, v: 0 });
    // 登録のない項目、不正な形は、何も起こさない。
    const before = r.a.sent.length;
    r.fromMain({ v: 0, kind: 'runMenu', plugin: 'a', req: 3, item: 'other', path: '/p', targetKind: 'file' });
    r.fromMain({ v: 0, kind: 'runMenu', plugin: 'a', req: 3, item: 'copy', path: '/p', targetKind: 'other' });
    r.fromMain({ v: 0, kind: 'runMenu', plugin: 'a', req: 3, item: 'copy', path: '', targetKind: 'file' });
    r.fromMain({ v: 0, kind: 'runMenu', plugin: 'a', req: 3, item: 'copy', path: 'x'.repeat(4097), targetKind: 'file' });
    r.fromMain({ v: 0, kind: 'runMenu', plugin: 'a', req: 0, item: 'copy', path: '/p', targetKind: 'file' });
    r.fromMain({ v: 0, kind: 'runMenu', plugin: 'a', req: 3, item: 'copy', path: '/p', targetKind: 'file', extra: 1 });
    expect(r.a.sent).toHaveLength(before);

    const late = boot();
    late.a.emit({ kind: 'ready' });
    late.a.emit({ kind: 'menu', id: 'x', title: 't', where: 'tree' });
    expect(late.a.terminated).toBe(1);

    const dup = boot();
    dup.a.emit({ kind: 'menu', id: 'x', title: 't', where: 'tree' });
    dup.a.emit({ kind: 'menu', id: 'x', title: 't', where: 'tree' });
    expect(dup.a.terminated).toBe(1);

    const many = boot();
    for (let i = 0; i < 9; i++) many.a.emit({ kind: 'menu', id: `i${i}`, title: 't', where: 'tree' });
    expect(many.a.terminated).toBe(1);
    expect(many.sent().filter((m) => m.kind === 'menu')).toHaveLength(8);
  });

  it('does not run a menu item before ready', () => {
    const r = boot();
    r.a.emit({ kind: 'menu', id: 'copy', title: 'コピー', where: 'tree' });
    r.fromMain({ v: 0, kind: 'runMenu', plugin: 'a', req: 2, item: 'copy', path: '/work/a.md', targetKind: 'file' });
    expect(r.a.sent).toEqual([{ kind: 'init' }]);
  });
});
