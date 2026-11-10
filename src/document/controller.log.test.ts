import { describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../platform';
import { draftOf, setup } from './testKit';

// アプリのログ（ADR-007）: 開く、保存、別名保存、草稿の書き込みの失敗を、操作の名前とエラーの種類だけで記録する。
// 本文とパスは記録しない。通知（トースト）は、記録の有無によらず従来どおり。

const SECRET_TEXT = 'SECRET-BODY-9f3a';
const SECRET_PATH = '/Users/alice/Documents/secret-note.md';

function logged() {
  const log = vi.fn();
  return { log, calls: () => log.mock.calls as Array<[string, string, Record<string, string>]> };
}

describe('document failures are logged by the operation name and the error kind only', () => {
  it('open (from the dialog): open-failed with the BridgeError kind', async () => {
    const l = logged();
    const t = setup({ log: l.log, files: { [SECRET_PATH]: SECRET_TEXT }, openPath: SECRET_PATH });
    t.bridge.openDocument.mockRejectedValueOnce(new BridgeError('not-utf8', `cannot read ${SECRET_PATH}`));
    await t.controller.openDocument();
    expect(l.calls()).toEqual([['error', 'open-failed', { op: 'open', error: 'BridgeError', kind: 'not-utf8' }]]);
    expect(t.notices).toHaveLength(1);
  });

  it('open from a path (explorer) and the startup reopen of a missing file both log open-failed', async () => {
    const l = logged();
    const t = setup({ log: l.log, files: {} });
    await t.controller.openPath('/missing.md');
    expect(l.calls()).toEqual([['error', 'open-failed', { op: 'open', error: 'BridgeError', kind: 'not-found' }]]);
    const startup = logged();
    const s = setup({ log: startup.log, files: {}, session: { lastPath: '/gone.md' } });
    await s.controller.start();
    expect(startup.calls().map((c) => [c[1], c[2].kind])).toEqual([['open-failed', 'not-found']]);
    // 通知は出さない（従来どおり。記録だけが残る）。
    expect(s.notices).toEqual([]);
  });

  it('save: save-failed', async () => {
    const l = logged();
    const t = setup({ log: l.log, files: { '/a.md': 'old' } });
    await t.controller.openDocument();
    t.type(SECRET_TEXT);
    t.bridge.saveDocument.mockRejectedValueOnce(new BridgeError('permission-denied', `denied: ${SECRET_PATH}`));
    expect(await t.controller.save()).toBe('failed');
    expect(l.calls()).toEqual([['error', 'save-failed', { op: 'save', error: 'BridgeError', kind: 'permission-denied' }]]);
  });

  it('save as: save-as-failed, for both the dialog and the write', async () => {
    const l = logged();
    const t = setup({ log: l.log });
    t.type(SECRET_TEXT);
    t.bridge.saveDocumentAs.mockRejectedValueOnce(new BridgeError('io', `disk full ${SECRET_PATH}`));
    expect(await t.controller.saveAs()).toBe('failed');
    t.bridge.pickSavePath.mockRejectedValueOnce(new Error('dialog failed'));
    expect(await t.controller.saveAs()).toBe('failed');
    expect(l.calls()).toEqual([
      ['error', 'save-as-failed', { op: 'save-as', error: 'BridgeError', kind: 'io' }],
      ['error', 'save-as-failed', { op: 'save-as', error: 'Error' }],
    ]);
  });

  it('draft write: draft-write-failed (the autosave of the draft)', async () => {
    const l = logged();
    const t = setup({ log: l.log });
    t.bridge.writeDraft.mockRejectedValueOnce(new BridgeError('io', `no space ${SECRET_PATH}`));
    t.type(SECRET_TEXT);
    t.timers.advance(2500);
    await t.settle();
    expect(l.calls()).toEqual([['error', 'draft-write-failed', { op: 'draft-write', error: 'BridgeError', kind: 'io' }]]);
    expect(t.notices.some((n) => n.kind === 'error')).toBe(true);
  });

  it('never carries the body text, the path or the error message', async () => {
    const l = logged();
    const t = setup({ log: l.log, files: { [SECRET_PATH]: 'x' }, openPath: SECRET_PATH });
    t.bridge.openDocument.mockRejectedValueOnce(new BridgeError('io', `fail ${SECRET_PATH} ${SECRET_TEXT}`));
    await t.controller.openDocument();
    t.type(SECRET_TEXT);
    t.bridge.saveDocumentAs.mockRejectedValueOnce(new BridgeError('io', SECRET_PATH));
    await t.controller.saveAs();
    const dump = JSON.stringify(l.log.mock.calls);
    expect(dump).not.toContain('SECRET');
    expect(dump).not.toContain('alice');
    expect(dump).not.toContain('/Users');
    expect(dump).not.toContain('.md');
  });

  it('does not log successes, conflicts or a cancelled dialog', async () => {
    const l = logged();
    const t = setup({ log: l.log, files: { '/a.md': 'old' } });
    await t.controller.openDocument();
    t.type('new');
    await t.controller.save();
    const cancelled = setup({ log: l.log, savePath: null });
    cancelled.type('x');
    await cancelled.controller.saveAs();
    t.files.set('/a.md', 'changed elsewhere');
    t.type('mine');
    await t.controller.save();
    expect(l.log).not.toHaveBeenCalled();
  });

  it('a throwing log function does not change the outcome or the notice', async () => {
    const t = setup({
      files: { '/a.md': 'old' },
      log: () => {
        throw new Error('log is broken');
      },
    });
    await t.controller.openDocument();
    t.type('new');
    t.bridge.saveDocument.mockRejectedValueOnce(new BridgeError('io', 'x'));
    expect(await t.controller.save()).toBe('failed');
    expect(t.notices.at(-1)?.kind).toBe('error');
  });

  it('works without a log function (the default)', async () => {
    const t = setup({ files: { '/a.md': 'old' }, drafts: [draftOf({ draftId: 'd' })] });
    await t.controller.openDocument();
    t.type('new');
    t.bridge.saveDocument.mockRejectedValueOnce(new BridgeError('io', 'x'));
    expect(await t.controller.save()).toBe('failed');
  });
});
