import { describe, expect, it } from 'vitest';
import { BridgeError } from '../platform';
import { isDirty } from './state';
import { draftOf, rev, setup, LF } from './testKit';

/** /a.md を開いた状態。 */
async function opened(options: Parameters<typeof setup>[0] = {}) {
  const t = setup({ files: { '/a.md': 'base' }, ...options });
  await t.controller.openDocument();
  return t;
}

describe('external change: no unsaved changes', () => {
  it('reloads the new content and tells the user', async () => {
    const t = await opened();
    t.files.set('/a.md', 'edited elsewhere');

    await t.controller.checkExternal();

    expect(t.editor()).toBe('edited elsewhere');
    expect(t.controller.getState()).toMatchObject({
      text: 'edited elsewhere',
      savedText: 'edited elsewhere',
      diskRevision: rev('edited elsewhere'),
    });
    expect(isDirty(t.controller.getState())).toBe(false);
    expect(t.controller.getExternal().kind).toBe('none');
    expect(t.notices.at(-1)?.message).toContain('読み直しました');
  });

  it('does nothing when the disk is as the document last saw it', async () => {
    const t = await opened();
    await t.controller.checkExternal();
    await t.controller.checkExternal();
    expect(t.notices).toHaveLength(0);
    expect(t.bridge.openDocument).toHaveBeenCalledTimes(1);
  });

  it('our own save is not reported as an external change', async () => {
    const t = await opened();
    t.type('base + mine');
    await t.controller.save();
    const noticesAfterSave = t.notices.length;

    await t.controller.checkExternal();

    expect(t.notices).toHaveLength(noticesAfterSave);
    expect(t.editor()).toBe('base + mine');
    expect(t.bridge.openDocument).toHaveBeenCalledTimes(1);
  });

  it('a file that was deleted keeps its text and unsaved state, and says so', async () => {
    const t = await opened();
    t.files.delete('/a.md');

    await t.controller.checkExternal();

    expect(t.controller.getExternal().kind).toBe('deleted');
    expect(t.editor()).toBe('base');
    expect(t.notices.at(-1)?.message).toContain('削除');
    // 通知は繰り返さない。
    await t.controller.checkExternal();
    expect(t.notices).toHaveLength(1);
  });

  it('does nothing for an untitled document', async () => {
    const t = setup();
    await t.controller.checkExternal();
    expect(t.bridge.checkDocument).not.toHaveBeenCalled();
  });
});

describe('external change: unsaved changes (conflict)', () => {
  async function conflicted() {
    const t = await opened();
    t.type('base + mine');
    t.files.set('/a.md', 'base + theirs');
    await t.controller.checkExternal();
    return t;
  }

  it('does not touch the text, and offers the choices', async () => {
    const t = await conflicted();
    expect(t.controller.getExternal()).toMatchObject({ kind: 'conflict', keepMine: false, disk: { kind: 'changed', text: 'base + theirs' } });
    expect(t.editor()).toBe('base + mine');
    expect(t.controller.getState().text).toBe('base + mine');
    expect(t.controller.getDiskTextForDiff()).toBe('base + theirs');
    expect(t.notices.at(-1)?.message).toContain('競合バー');
    // 同じ内容の再確認は、通知を増やさず、読み直しもしない。
    const opens = t.bridge.openDocument.mock.calls.length;
    await t.controller.checkExternal();
    expect(t.notices).toHaveLength(1);
    expect(t.bridge.openDocument).toHaveBeenCalledTimes(opens);
  });

  it('saving does not overwrite the disk', async () => {
    const t = await conflicted();
    expect(await t.controller.save()).toBe('conflict');
    expect(t.files.get('/a.md')).toBe('base + theirs');
    expect(t.backups).toHaveLength(0);
  });

  it('reload from disk: stashes my text as a new draft first, then loads the disk content', async () => {
    const t = await conflicted();

    await t.controller.reloadFromDisk();

    const stash = [...t.drafts.values()].find((d) => d.text === 'base + mine');
    expect(stash).toBeDefined();
    expect(stash?.draftId).not.toBe(t.controller.getState().draftId);
    expect(stash).toMatchObject({ path: '/a.md', baseRevision: rev('base') });
    expect(t.editor()).toBe('base + theirs');
    expect(isDirty(t.controller.getState())).toBe(false);
    expect(t.controller.getExternal().kind).toBe('none');
    expect(t.notices.at(-1)?.message).toContain(`/data/drafts/${stash?.draftId}.json`);
  });

  it('reload from disk is abandoned when my text cannot be stashed', async () => {
    const t = await conflicted();
    t.bridge.writeDraft.mockRejectedValueOnce(new BridgeError('io', 'disk full'));

    await t.controller.reloadFromDisk();

    expect(t.editor()).toBe('base + mine');
    expect(t.controller.getExternal().kind).toBe('conflict');
    expect(t.notices.at(-1)?.kind).toBe('error');
  });

  it('keep mine: the next save overwrites after backing up the disk version', async () => {
    const t = await conflicted();

    t.controller.keepMine();
    expect(t.controller.getExternal()).toMatchObject({ kind: 'conflict', keepMine: true });

    expect(await t.controller.save()).toBe('written');

    expect(t.files.get('/a.md')).toBe('base + mine');
    expect(t.backups).toEqual([{ path: '/backups/1.bak', text: 'base + theirs' }]);
    expect(t.bridge.saveDocument.mock.calls.at(-1)?.[3]).toMatchObject({ overwrite: true });
    expect(t.controller.getExternal().kind).toBe('none');
    expect(isDirty(t.controller.getState())).toBe(false);
    expect(t.notices.at(-1)?.message).toContain('/backups/1.bak');
  });

  it('keep mine is withdrawn if the disk changes again before the save', async () => {
    const t = await conflicted();
    t.controller.keepMine();
    t.files.set('/a.md', 'changed once more');
    await t.controller.checkExternal();
    expect(t.controller.getExternal()).toMatchObject({ kind: 'conflict', keepMine: false, disk: { text: 'changed once more' } });
    expect(await t.controller.save()).toBe('conflict');
    expect(t.files.get('/a.md')).toBe('changed once more');
  });

  it('a deleted file under unsaved changes is a conflict with a deleted disk', async () => {
    const t = await opened();
    t.type('base + mine');
    t.files.delete('/a.md');
    await t.controller.checkExternal();
    expect(t.controller.getExternal()).toMatchObject({ kind: 'conflict', disk: { kind: 'deleted' } });
    expect(t.editor()).toBe('base + mine');
  });
});

describe('save when the disk changed without any notification', () => {
  it('returns a conflict, does not write, and shows the conflict', async () => {
    const t = await opened();
    t.type('base + mine');
    t.files.set('/a.md', 'someone else wrote this');

    expect(await t.controller.save()).toBe('conflict');

    expect(t.files.get('/a.md')).toBe('someone else wrote this');
    expect(t.controller.getExternal()).toMatchObject({ kind: 'conflict', disk: { kind: 'changed', text: 'someone else wrote this' } });
    expect(isDirty(t.controller.getState())).toBe(true);
    expect(t.notices.at(-1)).toMatchObject({ kind: 'error' });
  });

  it('a save that fails because of a conflict does not close the document on "save" in the discard dialog', async () => {
    const t = await opened({ confirm: 'save', openPath: '/a.md' });
    t.type('base + mine');
    t.files.set('/a.md', 'someone else wrote this');
    await t.controller.newDocument();
    expect(t.editor()).toBe('base + mine');
    expect(t.controller.getState().path).toBe('/a.md');
  });
});

describe('deleted file', () => {
  it('saving asks first, and recreates the file when confirmed', async () => {
    const t = await opened({ recreate: true });
    t.files.delete('/a.md');
    await t.controller.checkExternal();
    t.type('base + mine');

    expect(await t.controller.save()).toBe('written');

    expect(t.confirmRecreate).toHaveBeenCalledWith('a.md');
    expect(t.files.get('/a.md')).toBe('base + mine');
    expect(t.controller.getExternal().kind).toBe('none');
  });

  it('recreating works for a document without unsaved changes', async () => {
    const t = await opened({ recreate: true });
    t.files.delete('/a.md');
    await t.controller.checkExternal();

    expect(await t.controller.save()).toBe('written');
    expect(t.files.get('/a.md')).toBe('base');
  });

  it('cancelling the confirmation writes nothing and keeps the state', async () => {
    const t = await opened({ recreate: false });
    t.files.delete('/a.md');
    await t.controller.checkExternal();

    expect(await t.controller.save()).toBe('cancelled');

    expect(t.files.has('/a.md')).toBe(false);
    expect(t.controller.getExternal().kind).toBe('deleted');
  });

  it('a file that someone created in the meantime is not overwritten', async () => {
    const t = await opened({ recreate: true });
    t.files.delete('/a.md');
    await t.controller.checkExternal();
    t.type('base + mine');
    t.files.set('/a.md', 'a new file by someone else');

    expect(await t.controller.save()).toBe('conflict');
    expect(t.files.get('/a.md')).toBe('a new file by someone else');
  });
});

describe('checks that arrive while an operation is running', () => {
  it('are run after it finishes, instead of being dropped', async () => {
    const t = await opened();
    t.type('base + mine');
    let release: () => void = () => {};
    t.bridge.saveDocument.mockImplementationOnce(async (path, text) => {
      await new Promise<void>((r) => (release = r));
      t.files.set(path, text);
      return { kind: 'saved', outcome: 'written', revision: rev(text), backup: null };
    });
    const saving = t.controller.save();
    await t.settle();

    // 保存中に、別のプロセスが書いた通知が来る。
    const checks = t.bridge.checkDocument.mock.calls.length;
    await t.controller.checkExternal();
    expect(t.bridge.checkDocument).toHaveBeenCalledTimes(checks);

    release();
    await saving;
    await t.settle();
    expect(t.bridge.checkDocument.mock.calls.length).toBeGreaterThan(checks);
  });
});

describe('watching and session', () => {
  it('watches the open document and follows it; remembers it as the last document', async () => {
    const t = setup({ files: { '/a.md': 'base' } });
    await t.controller.openDocument();
    expect(t.bridge.watchDocument).toHaveBeenLastCalledWith('/a.md');
    expect(t.session()).toEqual({ lastPath: '/a.md' });

    await t.controller.newDocument();
    expect(t.bridge.watchDocument).toHaveBeenLastCalledWith(null);
    // 新規文書にしても、前回の文書の記録は消さない。
    expect(t.session()).toEqual({ lastPath: '/a.md' });
  });

  it('save as switches the watch and the last document', async () => {
    const t = setup({ savePath: '/b.md' });
    t.type('x');
    await t.controller.save();
    expect(t.bridge.watchDocument).toHaveBeenLastCalledWith('/b.md');
    expect(t.session()).toEqual({ lastPath: '/b.md' });
  });
});

describe('startup', () => {
  const draft = draftOf({ draftId: '0f8fad5b-d9cb-469f-a165-70867728950e', path: '/a.md', text: 'base + draft', baseRevision: rev('base'), updatedAt: 1_700_000_000_000 });

  it('asks about a draft, and restores it as an unsaved document', async () => {
    const t = setup({ files: { '/a.md': 'base' }, drafts: [draft], recovery: 'restore', session: { lastPath: '/a.md' } });

    await t.controller.start();

    expect(t.askRecovery).toHaveBeenCalledWith(expect.objectContaining({ draftId: draft.draftId, path: '/a.md', updatedAt: 1_700_000_000_000 }), 0);
    expect(t.editor()).toBe('base + draft');
    expect(t.controller.getState()).toMatchObject({ path: '/a.md', text: 'base + draft', savedText: 'base', draftId: draft.draftId });
    expect(isDirty(t.controller.getState())).toBe(true);
    expect(t.controller.getExternal().kind).toBe('none');
    // 復旧した草稿は、保存されるまで残る。
    expect(t.drafts.has(draft.draftId)).toBe(true);
    // 草稿があるときは、前回の文書を別に開き直さない。
    expect(t.bridge.openDocument).toHaveBeenCalledTimes(1);
  });

  it('the recovered draft is removed once the document is saved', async () => {
    const t = setup({ files: { '/a.md': 'base' }, drafts: [draft], recovery: 'restore' });
    await t.controller.start();
    await t.controller.save();
    await t.settle();
    expect(t.files.get('/a.md')).toBe('base + draft');
    expect(t.drafts.has(draft.draftId)).toBe(false);
  });

  it('restoring a draft whose original changed since is a conflict, and saving does not overwrite', async () => {
    const t = setup({ files: { '/a.md': 'edited elsewhere' }, drafts: [draft], recovery: 'restore' });
    await t.controller.start();
    expect(t.controller.getExternal()).toMatchObject({ kind: 'conflict', disk: { kind: 'changed', text: 'edited elsewhere' } });
    expect(t.editor()).toBe('base + draft');
    expect(await t.controller.save()).toBe('conflict');
    expect(t.files.get('/a.md')).toBe('edited elsewhere');
  });

  it('restoring an untitled draft gives an unsaved untitled document', async () => {
    const untitled = draftOf({ draftId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', text: 'not saved anywhere yet' });
    const t = setup({ drafts: [untitled], recovery: 'restore' });
    await t.controller.start();
    expect(t.editor()).toBe('not saved anywhere yet');
    expect(t.controller.getState().path).toBeNull();
    expect(isDirty(t.controller.getState())).toBe(true);
  });

  it('a draft whose original file is gone is restored as an untitled document', async () => {
    const t = setup({ files: {}, drafts: [draft], recovery: 'restore' });
    await t.controller.start();
    expect(t.editor()).toBe('base + draft');
    expect(t.controller.getState().path).toBeNull();
    expect(t.notices.at(-1)?.message).toContain('保存先のない文書');
  });

  it('discard deletes the draft and leaves an empty untitled document', async () => {
    const t = setup({ files: { '/a.md': 'base' }, drafts: [draft], recovery: 'discard', session: { lastPath: '/a.md' } });
    await t.controller.start();
    expect(t.drafts.size).toBe(0);
    expect(t.editor()).toBe('');
    expect(t.controller.getState().path).toBeNull();
  });

  it('later keeps the draft and changes nothing', async () => {
    const t = setup({ files: { '/a.md': 'base' }, drafts: [draft], recovery: 'later' });
    await t.controller.start();
    expect(t.drafts.has(draft.draftId)).toBe(true);
    expect(t.editor()).toBe('');
    expect(t.controller.getState().path).toBeNull();
  });

  it('reopens the last document when there is no draft', async () => {
    const t = setup({ files: { '/last.md': 'last time' }, session: { lastPath: '/last.md' } });
    await t.controller.start();
    expect(t.askRecovery).not.toHaveBeenCalled();
    expect(t.editor()).toBe('last time');
    expect(t.controller.getState().path).toBe('/last.md');
    expect(isDirty(t.controller.getState())).toBe(false);
  });

  it('does nothing, quietly, when the last document no longer exists', async () => {
    const t = setup({ files: {}, session: { lastPath: '/gone.md' } });
    await t.controller.start();
    expect(t.notices).toHaveLength(0);
    expect(t.controller.getState().path).toBeNull();
  });

  it('does not replace text that the user already typed', async () => {
    const t = setup({ files: { '/last.md': 'last time' }, session: { lastPath: '/last.md' } });
    t.type('typing already');
    await t.controller.start();
    expect(t.editor()).toBe('typing already');
  });

  it('runs only once', async () => {
    const t = setup({ files: { '/last.md': 'x' }, session: { lastPath: '/last.md' } });
    await t.controller.start();
    await t.controller.start();
    expect(t.bridge.listDrafts).toHaveBeenCalledTimes(1);
  });

  it('survives a failing draft list or session', async () => {
    const t = setup();
    t.bridge.listDrafts.mockRejectedValueOnce(new Error('x'));
    t.bridge.loadSession.mockRejectedValueOnce(new Error('x'));
    await expect(t.controller.start()).resolves.toBeUndefined();
  });
});

describe('draft autosave through the controller', () => {
  it('writes a draft 2 seconds after typing stops, and removes it when saved', async () => {
    const t = await opened();
    t.type('base + a');
    t.timers.advance(1900);
    await t.settle();
    expect(t.bridge.writeDraft).not.toHaveBeenCalled();

    t.timers.advance(100);
    await t.settle();
    expect(t.bridge.writeDraft).toHaveBeenCalledTimes(1);
    expect([...t.drafts.values()][0]).toMatchObject({ path: '/a.md', text: 'base + a', baseRevision: rev('base') });

    await t.controller.save();
    await t.settle();
    expect(t.drafts.size).toBe(0);
    // 保存した後のファイルそのものは、草稿の書き込みの影響を受けない。
    expect(t.files.get('/a.md')).toBe('base + a');
  });

  it('never writes a draft to the original file', async () => {
    const t = await opened();
    t.type('base + a');
    t.timers.advance(5000);
    await t.settle();
    expect(t.bridge.saveDocument).not.toHaveBeenCalled();
    expect(t.files.get('/a.md')).toBe('base');
  });

  it('discarding changes when opening another document removes the old draft', async () => {
    const t = await opened({ confirm: 'discard', files: { '/a.md': 'base', '/b.md': 'other' } });
    t.type('base + a');
    t.timers.advance(2000);
    await t.settle();
    expect(t.drafts.size).toBe(1);

    t.bridge.pickOpenPath.mockResolvedValueOnce('/b.md');
    await t.controller.openDocument();
    await t.settle();
    expect(t.drafts.size).toBe(0);
  });
});

describe('closing the app', () => {
  it('closes without asking when there are no unsaved changes', async () => {
    const t = await opened();
    await t.controller.requestClose();
    expect(t.confirmDiscard).not.toHaveBeenCalled();
    expect(t.bridge.closeApp).toHaveBeenCalledTimes(1);
  });

  it('asks when there are unsaved changes, and cancel keeps the app open', async () => {
    const t = await opened({ confirm: 'cancel' });
    t.type('base + a');
    await t.controller.requestClose();
    expect(t.confirmDiscard).toHaveBeenCalledWith('a.md');
    expect(t.bridge.closeApp).not.toHaveBeenCalled();
  });

  it('save: saves and then closes', async () => {
    const t = await opened({ confirm: 'save' });
    t.type('base + a');
    await t.controller.requestClose();
    expect(t.files.get('/a.md')).toBe('base + a');
    expect(t.bridge.closeApp).toHaveBeenCalledTimes(1);
  });

  it('save: does not close when the save fails or conflicts', async () => {
    const t = await opened({ confirm: 'save' });
    t.type('base + a');
    t.files.set('/a.md', 'edited elsewhere');
    await t.controller.requestClose();
    expect(t.bridge.closeApp).not.toHaveBeenCalled();
    expect(t.files.get('/a.md')).toBe('edited elsewhere');
  });

  it('discard: removes the draft and closes without saving', async () => {
    const t = await opened({ confirm: 'discard' });
    t.type('base + a');
    t.timers.advance(2000);
    await t.settle();
    expect(t.drafts.size).toBe(1);

    await t.controller.requestClose();

    expect(t.drafts.size).toBe(0);
    expect(t.files.get('/a.md')).toBe('base');
    expect(t.bridge.closeApp).toHaveBeenCalledTimes(1);
  });

  it('a second request while the dialog is open is ignored', async () => {
    const t = await opened();
    t.type('x');
    let answer: (c: 'cancel') => void = () => {};
    t.confirmDiscard.mockImplementationOnce(() => new Promise((r) => (answer = r as typeof answer)) as never);
    const first = t.controller.requestClose();
    await t.controller.requestClose();
    expect(t.confirmDiscard).toHaveBeenCalledTimes(1);
    answer('cancel');
    await first;
  });
});

describe('format is kept through recovery', () => {
  it('restores the format recorded in the draft', async () => {
    const crlf = { bom: true, eol: 'crlf', mixedEol: false } as const;
    const d = draftOf({ draftId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', text: 'x', format: crlf });
    const t = setup({ drafts: [d], recovery: 'restore' });
    await t.controller.start();
    expect(t.controller.getState().format).toEqual(crlf);
    expect(LF).not.toEqual(crlf);
  });
});
