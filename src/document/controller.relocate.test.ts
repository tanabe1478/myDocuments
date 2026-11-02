import { describe, expect, it } from 'vitest';
import { BridgeError } from '../platform';
import { rev, setup } from './testKit';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 名前の変更を、メモリ上のディスクで行う（ファイル、またはフォルダの中身を移す）。 */
function mover(files: Map<string, string>, from: string, to: string) {
  return async () => {
    for (const key of [...files.keys()]) {
      if (key === from || key.startsWith(`${from}/`)) {
        files.set(`${to}${key.slice(from.length)}`, files.get(key)!);
        files.delete(key);
      }
    }
    return to;
  };
}

async function openDoc(path = '/d/a.md', text = 'hello', extra: Record<string, string> = {}) {
  const t = setup({ files: { [path]: text, ...extra } });
  expect(await t.controller.openPath(path)).toBe(true);
  t.bridge.watchDocument.mockClear();
  t.bridge.saveSession.mockClear();
  return t;
}

describe('renaming the open document from the explorer', () => {
  it('moves the document to the new path: path, watch, session and title', async () => {
    const t = await openDoc();
    const result = await t.controller.renameEntry('/d/a.md', mover(t.files, '/d/a.md', '/d/b.md'));
    expect(result).toBe('/d/b.md');
    expect(t.controller.getState().path).toBe('/d/b.md');
    // 名前を変える前に監視を外し、変えた後に新しいパスで監視し直す。
    expect(t.bridge.watchDocument.mock.calls).toEqual([[null], ['/d/b.md']]);
    expect(t.bridge.saveSession).toHaveBeenCalledWith({ lastPath: '/d/b.md' });
    expect(t.session().lastPath).toBe('/d/b.md');
  });

  it('unwatches before the rename runs (so the old path is not reported as deleted)', async () => {
    const t = await openDoc();
    const order: string[] = [];
    t.bridge.watchDocument.mockImplementation(async (p: string | null) => void order.push(`watch:${p}`));
    await t.controller.renameEntry('/d/a.md', async () => {
      order.push('rename');
      return mover(t.files, '/d/a.md', '/d/b.md')();
    });
    expect(order).toEqual(['watch:null', 'rename', 'watch:/d/b.md']);
  });

  it('keeps the unsaved text, the saved text and the disk revision; does not treat the old path as deleted', async () => {
    const t = await openDoc();
    t.type('hello, edited');
    const before = t.controller.getState();
    await t.controller.renameEntry('/d/a.md', mover(t.files, '/d/a.md', '/d/b.md'));
    await flush();
    const after = t.controller.getState();
    expect(after).toMatchObject({
      path: '/d/b.md',
      text: 'hello, edited',
      savedText: 'hello',
      diskRevision: before.diskRevision,
      draftId: before.draftId,
    });
    expect(t.controller.getExternal()).toEqual({ kind: 'none' });
    // 古いパスは、もう確かめない。
    expect(t.bridge.checkDocument).toHaveBeenCalledWith('/d/b.md');
    expect(t.bridge.checkDocument).not.toHaveBeenCalledWith('/d/a.md');
    expect(t.notices.filter((n) => n.message.includes('削除'))).toEqual([]);
  });

  it('rewrites the draft right away with the new path when there are unsaved changes', async () => {
    const t = await openDoc();
    t.type('hello, edited');
    t.timers.advance(2000);
    await t.settle();
    expect(t.drafts.get(t.controller.getState().draftId)?.path).toBe('/d/a.md');

    await t.controller.renameEntry('/d/a.md', mover(t.files, '/d/a.md', '/d/b.md'));
    await t.settle();
    const draft = t.drafts.get(t.controller.getState().draftId);
    expect(draft).toMatchObject({ path: '/d/b.md', text: 'hello, edited' });
  });

  it('writes no draft for a document without unsaved changes', async () => {
    const t = await openDoc();
    await t.controller.renameEntry('/d/a.md', mover(t.files, '/d/a.md', '/d/b.md'));
    await t.settle();
    expect(t.bridge.writeDraft).not.toHaveBeenCalled();
  });

  it('saves to the new path afterwards', async () => {
    const t = await openDoc();
    t.type('changed');
    await t.controller.renameEntry('/d/a.md', mover(t.files, '/d/a.md', '/d/b.md'));
    await flush(); // 名前の変更の直後の、ディスクの確認が終わるのを待つ。
    await t.controller.save();
    expect(t.bridge.saveDocument.mock.calls.at(-1)?.[0]).toBe('/d/b.md');
    expect(t.files.get('/d/b.md')).toBe('changed');
    expect(t.files.has('/d/a.md')).toBe(false);
  });

  it('follows a rename of the folder that contains the document', async () => {
    const t = await openDoc('/d/sub/a.md', 'hello', { '/d/sub/other.md': 'x' });
    t.type('hello!');
    const result = await t.controller.renameEntry('/d/sub', mover(t.files, '/d/sub', '/d/renamed'));
    expect(result).toBe('/d/renamed');
    expect(t.controller.getState()).toMatchObject({ path: '/d/renamed/a.md', text: 'hello!', savedText: 'hello' });
    expect(t.bridge.watchDocument.mock.calls).toEqual([[null], ['/d/renamed/a.md']]);
  });

  it('keeps an unresolved conflict as it is', async () => {
    const t = await openDoc();
    t.type('mine');
    t.files.set('/d/a.md', 'theirs');
    await t.controller.checkExternal();
    expect(t.controller.getExternal().kind).toBe('conflict');
    await t.controller.renameEntry('/d/a.md', mover(t.files, '/d/a.md', '/d/b.md'));
    await flush();
    expect(t.controller.getExternal()).toMatchObject({ kind: 'conflict', keepMine: false, disk: { kind: 'changed', revision: rev('theirs') } });
    expect(t.controller.getState().text).toBe('mine');
  });

  it('leaves the document at the old path, and watches it again, when the rename fails', async () => {
    const t = await openDoc();
    t.type('mine');
    await expect(
      t.controller.renameEntry('/d/a.md', async () => {
        throw new BridgeError('already-exists', 'exists');
      }),
    ).rejects.toMatchObject({ kind: 'already-exists' });
    expect(t.controller.getState()).toMatchObject({ path: '/d/a.md', text: 'mine' });
    expect(t.bridge.watchDocument.mock.calls).toEqual([[null], ['/d/a.md']]);
  });

  it('does not touch the document for an unrelated item, even one whose name starts the same', async () => {
    const t = await openDoc('/d/note.md');
    const result = await t.controller.renameEntry('/d/note.md.bak', async () => '/d/other.bak');
    expect(result).toBe('/d/other.bak');
    expect(t.controller.getState().path).toBe('/d/note.md');
    expect(t.bridge.watchDocument).not.toHaveBeenCalled();
    const folder = await t.controller.renameEntry('/d/no', async () => '/d/nope');
    expect(folder).toBe('/d/nope');
    expect(t.controller.getState().path).toBe('/d/note.md');
  });

  it('renames while no document is open', async () => {
    const t = setup();
    expect(await t.controller.renameEntry('/d/x.md', async () => '/d/y.md')).toBe('/d/y.md');
    expect(t.bridge.watchDocument).not.toHaveBeenCalled();
  });

  it('does nothing and returns null while another document operation is running', async () => {
    const t = await openDoc('/d/a.md', 'hello', { '/d/c.md': 'other' });
    let release: () => void = () => {};
    t.bridge.openDocument.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ path: '/d/c.md', text: 'other', format: { bom: false, eol: 'lf', mixedEol: false }, revision: rev('other') }))),
    );
    const opening = t.controller.openPath('/d/c.md');
    await flush();
    let performed = false;
    const result = await t.controller.renameEntry('/d/a.md', async () => {
      performed = true;
      return '/d/b.md';
    });
    expect(result).toBeNull();
    expect(performed).toBe(false);
    release();
    await opening;
  });

  it('relocate ignores a path that is not the open document', async () => {
    const t = await openDoc();
    t.controller.relocate('/d/other.md', '/d/x.md');
    expect(t.controller.getState().path).toBe('/d/a.md');
  });

  it('knows whether the open document is inside a path', async () => {
    const t = await openDoc('/d/sub/a.md');
    expect(t.controller.isDocumentInside('/d/sub/a.md')).toBe(true);
    expect(t.controller.isDocumentInside('/d/sub')).toBe(true);
    expect(t.controller.isDocumentInside('/d/su')).toBe(false);
    expect(t.controller.isDocumentInside('/d/sub/a.md.bak')).toBe(false);
  });
});

describe('a document that is moved to the trash', () => {
  it('shows the existing "deleted" handling when checked right after (no unsaved changes)', async () => {
    const t = await openDoc();
    t.files.delete('/d/a.md');
    await t.controller.checkExternal();
    expect(t.controller.getExternal()).toEqual({ kind: 'deleted' });
    expect(t.notices.at(-1)?.message).toContain('削除されました');
  });

  it('becomes a conflict when there are unsaved changes', async () => {
    const t = await openDoc();
    t.type('mine');
    t.files.delete('/d/a.md');
    await t.controller.checkExternal();
    expect(t.controller.getExternal()).toMatchObject({ kind: 'conflict', disk: { kind: 'deleted' } });
    expect(t.controller.getState().text).toBe('mine');
  });
});
