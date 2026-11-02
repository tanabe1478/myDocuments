import { describe, expect, it, vi } from 'vitest';
import type { Notice } from '../document/controller';
import { BridgeError, type FolderEntry, type FolderListing, type SessionInfo } from '../platform';
import { ExplorerController, type ExplorerDocuments, type TrashTarget } from './controller';
import { buildTree, flattenRows } from './tree';

const file = (name: string, parent: string): FolderEntry => ({ name, path: `${parent}/${name}`, kind: 'file' });
const dir = (name: string, parent: string): FolderEntry => ({ name, path: `${parent}/${name}`, kind: 'dir' });

type Tree = Record<string, FolderEntry[]>;

/** メモリ上のファイルシステム（フォルダ → 中身）を持つ bridge。作成・名前の変更・ゴミ箱は、その中身を書き換える。 */
function setup(initial: Tree, options: { confirm?: boolean; documentInside?: (path: string) => boolean } = {}) {
  const tree: Tree = structuredClone(initial);
  const notices: Notice[] = [];
  let session: SessionInfo = { lastPath: null, lastFolder: null };
  const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/'));
  const nameTaken = (parent: string, name: string) => (tree[parent] ?? []).some((e) => e.name === name);
  const add = (parent: string, entry: FolderEntry) => {
    tree[parent] = [...(tree[parent] ?? []), entry];
    if (entry.kind === 'dir') tree[entry.path] ??= [];
  };

  const bridge = {
    pickFolderPath: vi.fn(async (): Promise<string | null> => '/r'),
    openFolder: vi.fn(async (path: string) => {
      if (!(path in tree)) throw new BridgeError('not-found', 'no such folder');
    }),
    listFolder: vi.fn(async (path: string): Promise<FolderListing> => {
      const entries = tree[path];
      if (!entries) throw new BridgeError('not-found', 'no such folder');
      return { entries: structuredClone(entries), total: entries.length };
    }),
    loadSession: vi.fn(async () => session),
    saveSession: vi.fn(async (patch: Partial<SessionInfo>) => {
      session = { ...session, ...patch };
    }),
    createFile: vi.fn(async (parent: string, name: string) => {
      if (nameTaken(parent, name)) throw new BridgeError('already-exists', 'exists');
      add(parent, file(name, parent));
      return `${parent}/${name}`;
    }),
    createFolder: vi.fn(async (parent: string, name: string) => {
      if (nameTaken(parent, name)) throw new BridgeError('already-exists', 'exists');
      add(parent, dir(name, parent));
      return `${parent}/${name}`;
    }),
    renameEntry: vi.fn(async (path: string, newName: string) => {
      const parent = parentOf(path);
      if (nameTaken(parent, newName)) throw new BridgeError('already-exists', 'exists');
      const to = `${parent}/${newName}`;
      tree[parent] = tree[parent]!.map((e) => (e.path === path ? { ...e, name: newName, path: to } : e));
      for (const key of Object.keys(tree)) {
        if (key === path || key.startsWith(`${path}/`)) {
          const moved = `${to}${key.slice(path.length)}`;
          tree[moved] = tree[key]!.map((e) => ({ ...e, path: `${to}${e.path.slice(path.length)}` }));
          delete tree[key];
        }
      }
      return to;
    }),
    trashEntry: vi.fn(async (path: string) => {
      const parent = parentOf(path);
      tree[parent] = tree[parent]!.filter((e) => e.path !== path);
      for (const key of Object.keys(tree)) if (key === path || key.startsWith(`${path}/`)) delete tree[key];
    }),
    watchFolders: vi.fn(async (_paths: readonly string[]) => {}),
    onFolderChanged: vi.fn(async (_cb: (path: string) => void) => () => {}),
  };

  const documents = {
    isDocumentInside: vi.fn((path: string) => options.documentInside?.(path) ?? false),
    rename: vi.fn(async (_old: string, perform: () => Promise<string>): Promise<string | null> => perform()),
    checkExternal: vi.fn(async () => {}),
    open: vi.fn(async (_path: string) => true),
  } satisfies ExplorerDocuments;
  const confirmTrash = vi.fn(async (_target: TrashTarget) => options.confirm ?? true);

  const explorer = new ExplorerController({ bridge, notify: (n) => notices.push(n), confirmTrash, documents });
  const rows = () => {
    const s = explorer.getState();
    return s.root === null ? [] : flattenRows(buildTree(s.root, s.dirs, s.expanded)).map((r) => r.label);
  };
  return { explorer, bridge, documents, confirmTrash, notices, rows, tree };
}

const TREE: Tree = {
  '/r': [dir('docs', '/r'), dir('empty', '/r'), file('a.md', '/r'), file('b.md', '/r'), file('c.md', '/r')],
  '/r/docs': [dir('deep', '/r/docs'), file('x.md', '/r/docs'), file('y.md', '/r/docs')],
  '/r/docs/deep': [file('z.md', '/r/docs/deep')],
  '/r/empty': [],
};

const flush = () => new Promise((r) => setTimeout(r, 0));

async function opened(options?: Parameters<typeof setup>[1]) {
  const t = setup(TREE, options);
  await t.explorer.chooseFolder();
  return t;
}

describe('creating', () => {
  it('creates in the root when nothing is selected, in the selected folder, or in the parent of a selected file', async () => {
    const t = await opened();
    t.explorer.beginCreate('file');
    expect(t.explorer.getState().edit).toMatchObject({ mode: 'create-file', parentPath: '/r', initial: '' });
    t.explorer.cancelEdit();

    t.explorer.select('/r/docs');
    t.explorer.beginCreate('folder');
    expect(t.explorer.getState().edit).toMatchObject({ mode: 'create-folder', parentPath: '/r/docs' });
    t.explorer.cancelEdit();

    t.explorer.expand('/r/docs');
    await flush();
    t.explorer.select('/r/docs/x.md');
    t.explorer.beginCreate('file');
    expect(t.explorer.getState().edit).toMatchObject({ parentPath: '/r/docs' });
  });

  it('expands a closed target folder so the input appears inside it', async () => {
    const t = await opened();
    t.explorer.select('/r/docs');
    t.explorer.beginCreate('file');
    await flush();
    expect(t.explorer.getState().expanded.has('/r/docs')).toBe(true);
    expect(t.rows()).toContain('x.md');
  });

  it('adds .md to a file name without an extension, creates it, selects it and opens it', async () => {
    const t = await opened();
    t.explorer.beginCreate('file');
    await t.explorer.commitEdit('idea');
    expect(t.bridge.createFile).toHaveBeenCalledWith('/r', 'idea.md');
    expect(t.documents.open).toHaveBeenCalledWith('/r/idea.md');
    expect(t.explorer.getState().edit).toBeNull();
    expect(t.explorer.getState().selected).toBe('/r/idea.md');
    expect(t.rows()).toContain('idea.md');
  });

  it('keeps a given extension', async () => {
    const t = await opened();
    t.explorer.beginCreate('file');
    await t.explorer.commitEdit('plain.txt');
    expect(t.bridge.createFile).toHaveBeenCalledWith('/r', 'plain.txt');
  });

  it('creates a folder, expands it and selects it without opening a document', async () => {
    const t = await opened();
    t.explorer.beginCreate('folder');
    await t.explorer.commitEdit('ideas');
    expect(t.bridge.createFolder).toHaveBeenCalledWith('/r', 'ideas');
    expect(t.documents.open).not.toHaveBeenCalled();
    await flush();
    expect(t.explorer.getState().selected).toBe('/r/ideas');
    expect(t.explorer.getState().expanded.has('/r/ideas')).toBe(true);
    expect(t.rows()).toContain('ideas');
  });

  it.each(['', '   ', 'a/b', 'a\\b', '.', '..', '.hidden', 'a:b', 'a.', 'a '])('refuses %j, keeps the input and explains why', async (name) => {
    const t = await opened();
    t.explorer.beginCreate('file');
    await t.explorer.commitEdit(name);
    const edit = t.explorer.getState().edit;
    expect(edit?.error).toEqual(expect.any(String));
    expect(edit?.error?.length).toBeGreaterThan(0);
    expect(t.bridge.createFile).not.toHaveBeenCalled();
  });

  it('refuses an existing name, also after .md is added', async () => {
    const t = await opened();
    t.explorer.beginCreate('file');
    await t.explorer.commitEdit('a.md');
    expect(t.explorer.getState().edit?.error).toContain('同じ名前');
    await t.explorer.commitEdit('a');
    expect(t.explorer.getState().edit?.error).toContain('同じ名前');
    expect(t.bridge.createFile).not.toHaveBeenCalled();
  });

  it('shows the native refusal (a name that differs only in letter case) in the input and lets the user retry', async () => {
    const t = await opened();
    t.explorer.beginCreate('file');
    t.bridge.createFile.mockRejectedValueOnce(new BridgeError('already-exists', 'exists'));
    await t.explorer.commitEdit('A.MD');
    expect(t.explorer.getState().edit).toMatchObject({ busy: false, error: expect.stringContaining('同じ名前') });
    t.explorer.clearEditError();
    expect(t.explorer.getState().edit?.error).toBeNull();
    await t.explorer.commitEdit('other.md');
    expect(t.explorer.getState().edit).toBeNull();
  });

  it('does not commit twice while the first commit is running', async () => {
    const t = await opened();
    t.explorer.beginCreate('file');
    let release: () => void = () => {};
    t.bridge.createFile.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve('/r/slow.md'))));
    const first = t.explorer.commitEdit('slow');
    await t.explorer.commitEdit('slow');
    expect(t.bridge.createFile).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('does nothing without an opened folder', () => {
    const t = setup(TREE);
    t.explorer.beginCreate('file');
    expect(t.explorer.getState().edit).toBeNull();
  });
});

describe('renaming', () => {
  it('selects the name up to the extension and renames through the documents port', async () => {
    const t = await opened();
    t.explorer.beginRename('/r/a.md');
    expect(t.explorer.getState().edit).toMatchObject({ mode: 'rename', targetPath: '/r/a.md', initial: 'a.md', selection: [0, 1] });
    await t.explorer.commitEdit('renamed.md');
    expect(t.documents.rename).toHaveBeenCalledWith('/r/a.md', expect.any(Function));
    expect(t.bridge.renameEntry).toHaveBeenCalledWith('/r/a.md', 'renamed.md');
    expect(t.explorer.getState().edit).toBeNull();
    expect(t.explorer.getState().selected).toBe('/r/renamed.md');
    expect(t.rows()).toContain('renamed.md');
    expect(t.rows()).not.toContain('a.md');
  });

  it('allows the current name and a change of letter case only; refuses another existing name', async () => {
    const t = await opened();
    t.explorer.beginRename('/r/a.md');
    await t.explorer.commitEdit('b.md');
    expect(t.explorer.getState().edit?.error).toContain('同じ名前');
    expect(t.bridge.renameEntry).not.toHaveBeenCalled();

    await t.explorer.commitEdit('A.md');
    expect(t.bridge.renameEntry).toHaveBeenCalledWith('/r/a.md', 'A.md');

    t.explorer.beginRename('/r/b.md');
    await t.explorer.commitEdit('b.md');
    expect(t.explorer.getState().edit).toBeNull();
    expect(t.bridge.renameEntry).toHaveBeenCalledTimes(1);
  });

  it('keeps the expansion and the selection under a renamed folder', async () => {
    const t = await opened();
    t.explorer.expand('/r/docs');
    await flush();
    t.explorer.expand('/r/docs/deep');
    await flush();
    t.explorer.beginRename('/r/docs');
    await t.explorer.commitEdit('manuscripts');
    const state = t.explorer.getState();
    expect([...state.expanded].sort()).toEqual(['/r/manuscripts', '/r/manuscripts/deep']);
    expect(state.selected).toBe('/r/manuscripts');
    expect(t.rows()).toContain('z.md');
    expect(t.rows()).toContain('manuscripts');
    expect(t.rows()).not.toContain('docs');
    expect(state.dirs.has('/r/docs')).toBe(false);
    expect(state.dirs.has('/r/manuscripts/deep')).toBe(true);
  });

  it('shows the failure in the input when the rename fails, and leaves the tree as it was', async () => {
    const t = await opened();
    t.explorer.beginRename('/r/a.md');
    t.bridge.renameEntry.mockRejectedValueOnce(new BridgeError('permission-denied', 'x'));
    await t.explorer.commitEdit('z.md');
    expect(t.explorer.getState().edit).toMatchObject({ busy: false, error: expect.stringContaining('権限') });
    expect(t.rows()).toContain('a.md');
  });

  it('says so when a document operation is running (the documents port returns null)', async () => {
    const t = await opened();
    t.documents.rename.mockResolvedValueOnce(null);
    t.explorer.beginRename('/r/a.md');
    await t.explorer.commitEdit('z.md');
    expect(t.explorer.getState().edit?.error).toContain('文書の操作');
    expect(t.bridge.renameEntry).not.toHaveBeenCalled();
  });

  it('ignores rows without an entry (notes) and unknown paths', async () => {
    const t = await opened();
    t.explorer.expand('/r/empty');
    await flush();
    t.explorer.beginRename('/r/empty\u0000note:empty');
    t.explorer.beginRename('/r/unknown');
    expect(t.explorer.getState().edit).toBeNull();
  });

  it('cancels', async () => {
    const t = await opened();
    t.explorer.beginRename('/r/a.md');
    t.explorer.cancelEdit();
    expect(t.explorer.getState().edit).toBeNull();
  });
});

describe('moving to the trash', () => {
  it('asks every time and does nothing when cancelled', async () => {
    const t = await opened({ confirm: false });
    await t.explorer.requestTrash('/r/a.md');
    expect(t.confirmTrash).toHaveBeenCalledWith({ name: 'a.md', kind: 'file' });
    expect(t.bridge.trashEntry).not.toHaveBeenCalled();
    expect(t.rows()).toContain('a.md');
  });

  it('describes a folder as a folder', async () => {
    const t = await opened({ confirm: false });
    await t.explorer.requestTrash('/r/docs');
    expect(t.confirmTrash).toHaveBeenCalledWith({ name: 'docs', kind: 'folder' });
  });

  it('moves the item, selects the next one and drops the expansion under a trashed folder', async () => {
    const t = await opened();
    t.explorer.expand('/r/docs');
    await flush();
    t.explorer.select('/r/a.md');
    await t.explorer.requestTrash('/r/a.md');
    expect(t.bridge.trashEntry).toHaveBeenCalledWith('/r/a.md');
    expect(t.explorer.getState().selected).toBe('/r/b.md');
    expect(t.rows()).not.toContain('a.md');

    await t.explorer.requestTrash('/r/docs');
    expect(t.explorer.getState().expanded.size).toBe(0);
    expect(t.explorer.getState().dirs.has('/r/docs')).toBe(false);
    expect(t.rows()).toEqual(['empty', 'b.md', 'c.md']);
    expect(t.explorer.getState().selected).toBe('/r/empty');
  });

  it('uses the selected item by default', async () => {
    const t = await opened();
    t.explorer.select('/r/c.md');
    await t.explorer.requestTrash();
    expect(t.bridge.trashEntry).toHaveBeenCalledWith('/r/c.md');
    expect(t.explorer.getState().selected).toBe('/r/b.md');
  });

  it('checks the open document right after moving it, or the folder that contains it, without waiting for a notification', async () => {
    const t = await opened({ documentInside: (p) => '/r/docs/x.md'.startsWith(p) });
    await t.explorer.requestTrash('/r/docs');
    expect(t.documents.checkExternal).toHaveBeenCalledTimes(1);
    expect(t.bridge.trashEntry.mock.invocationCallOrder[0]!).toBeLessThan(t.documents.checkExternal.mock.invocationCallOrder[0]!);

    await t.explorer.requestTrash('/r/a.md');
    expect(t.documents.checkExternal).toHaveBeenCalledTimes(1);
  });

  it('keeps everything and reports an error when the move fails', async () => {
    const t = await opened();
    t.bridge.trashEntry.mockRejectedValueOnce(new BridgeError('io', 'the trash is not available'));
    await t.explorer.requestTrash('/r/a.md');
    expect(t.notices.at(-1)?.message).toContain('ゴミ箱に移せませんでした');
    expect(t.documents.checkExternal).not.toHaveBeenCalled();
    expect(t.rows()).toContain('a.md');
  });

  it('never moves without a confirmation function', async () => {
    const t = setup(TREE);
    const bare = new ExplorerController({ bridge: t.bridge, notify: () => {} });
    await bare.chooseFolder();
    await bare.requestTrash('/r/a.md');
    expect(t.bridge.trashEntry).not.toHaveBeenCalled();
  });
});

describe('external changes (folder-changed)', () => {
  it('re-reads only the changed folder and keeps the expansion and the selection', async () => {
    const t = await opened();
    t.explorer.expand('/r/docs');
    await flush();
    t.explorer.select('/r/docs/x.md');
    const before = t.bridge.listFolder.mock.calls.length;
    t.tree['/r/docs'] = [...t.tree['/r/docs']!, file('new.md', '/r/docs')];
    t.explorer.handleFolderChanged('/r/docs');
    await flush();
    expect(t.bridge.listFolder.mock.calls.slice(before).map((c) => c[0])).toEqual(['/r/docs']);
    expect(t.rows()).toContain('new.md');
    expect(t.explorer.getState().expanded.has('/r/docs')).toBe(true);
    expect(t.explorer.getState().selected).toBe('/r/docs/x.md');
    expect(t.notices).toEqual([]);
  });

  it('reads the root and ignores folders that are neither the root nor expanded', async () => {
    const t = await opened();
    t.tree['/r'] = [...t.tree['/r']!, file('added.md', '/r')];
    t.explorer.handleFolderChanged('/r');
    await flush();
    expect(t.rows()).toContain('added.md');

    const before = t.bridge.listFolder.mock.calls.length;
    t.explorer.handleFolderChanged('/r/docs');
    t.explorer.handleFolderChanged('/elsewhere');
    await flush();
    expect(t.bridge.listFolder.mock.calls.length).toBe(before);
  });

  it('stops expanding a folder that was removed, with everything inside it', async () => {
    const t = await opened();
    t.explorer.expand('/r/docs');
    await flush();
    t.explorer.expand('/r/docs/deep');
    await flush();
    t.tree['/r'] = t.tree['/r']!.filter((e) => e.name !== 'docs');
    delete t.tree['/r/docs'];
    delete t.tree['/r/docs/deep'];
    t.explorer.handleFolderChanged('/r');
    await flush();
    expect(t.explorer.getState().expanded.size).toBe(0);
    expect(t.explorer.getState().dirs.has('/r/docs')).toBe(false);
    expect(t.rows()).toEqual(['empty', 'a.md', 'b.md', 'c.md']);
  });

  it('collapses an expanded folder whose own listing is gone, quietly', async () => {
    const t = await opened();
    t.explorer.expand('/r/docs');
    await flush();
    delete t.tree['/r/docs'];
    t.explorer.handleFolderChanged('/r/docs');
    await flush();
    expect(t.explorer.getState().expanded.size).toBe(0);
    expect(t.notices).toEqual([]);
  });

  it('keeps the view when the root cannot be read, without a toast for a notification', async () => {
    const t = await opened();
    t.bridge.listFolder.mockRejectedValueOnce(new BridgeError('permission-denied', 'x'));
    t.explorer.handleFolderChanged('/r');
    await flush();
    expect(t.rows()).toContain('a.md');
    expect(t.notices).toEqual([]);
  });

  it('does not let an older read overwrite a newer one', async () => {
    const t = await opened();
    let releaseFirst: () => void = () => {};
    const stale: FolderListing = { entries: [file('stale.md', '/r')], total: 1 };
    t.bridge.listFolder.mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = () => resolve(stale))));
    t.explorer.handleFolderChanged('/r');
    t.tree['/r'] = [file('fresh.md', '/r')];
    t.explorer.handleFolderChanged('/r');
    await flush();
    releaseFirst();
    await flush();
    expect(t.rows()).toEqual(['fresh.md']);
  });

  it('subscribes through the bridge and returns the unsubscribe function', async () => {
    const t = setup(TREE);
    const off = vi.fn();
    t.bridge.onFolderChanged.mockResolvedValueOnce(off);
    const unsubscribe = await t.explorer.attach();
    expect(t.bridge.onFolderChanged).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(off).toHaveBeenCalled();
  });
});

describe('watching the visible folders', () => {
  it('watches the root and the expanded folders, and updates the list when they change', async () => {
    const t = setup(TREE);
    expect(t.bridge.watchFolders).not.toHaveBeenCalled();
    await t.explorer.chooseFolder();
    await flush();
    expect(t.bridge.watchFolders).toHaveBeenLastCalledWith(['/r']);

    t.explorer.expand('/r/docs');
    await flush();
    expect(t.bridge.watchFolders).toHaveBeenLastCalledWith(['/r', '/r/docs']);

    t.explorer.collapse('/r/docs');
    await flush();
    expect(t.bridge.watchFolders).toHaveBeenLastCalledWith(['/r']);
  });

  it('does not call again for an unchanged list, and calls one at a time', async () => {
    const t = setup(TREE);
    let running = 0;
    let overlapped = false;
    t.bridge.watchFolders.mockImplementation(async () => {
      running++;
      overlapped ||= running > 1;
      await flush();
      running--;
    });
    await t.explorer.chooseFolder();
    t.explorer.expand('/r/docs');
    t.explorer.expand('/r/empty');
    await flush();
    await flush();
    await flush();
    expect(overlapped).toBe(false);
    expect(t.bridge.watchFolders).toHaveBeenLastCalledWith(['/r', '/r/docs', '/r/empty']);
    const calls = t.bridge.watchFolders.mock.calls.length;
    t.explorer.handleFolderChanged('/r');
    await flush();
    expect(t.bridge.watchFolders.mock.calls.length).toBe(calls);
  });

  it('tells the user once when watching fails', async () => {
    const t = setup(TREE);
    t.bridge.watchFolders.mockRejectedValue(new BridgeError('io', 'no more watches'));
    await t.explorer.chooseFolder();
    t.explorer.expand('/r/docs');
    await flush();
    expect(t.notices.filter((n) => n.message.includes('監視できませんでした'))).toHaveLength(1);
  });
});
