import { describe, expect, it, vi } from 'vitest';
import type { Notice } from '../document/controller';
import { BridgeError, type FolderEntry, type FolderListing, type MoveConflict, type SessionInfo } from '../platform';
import { ExplorerController, type ExplorerDocuments, type MoveConflictChoice, type MoveConflictInfo } from './controller';
import { buildTree, flattenRows } from './tree';

const file = (name: string, parent: string): FolderEntry => ({ name, path: `${parent}/${name}`, kind: 'file' });
const dir = (name: string, parent: string): FolderEntry => ({ name, path: `${parent}/${name}`, kind: 'dir' });

type Tree = Record<string, FolderEntry[]>;

const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/'));

/**
 * メモリ上のファイルシステム（フォルダ → 中身）を持つ bridge。moveEntry は、Rust 側（entries.rs の move_entry）と同じ規則の要点
 * （同じ名前は大文字小文字を区別せず、fail は already-exists、replace は既存を trashed へ、keep-both は番号付き）を再現する。
 */
function setup(
  initial: Tree,
  options: {
    choice?: MoveConflictChoice;
    documentInside?: (path: string) => boolean;
    renameResult?: 'busy';
    failMove?: BridgeError;
  } = {},
) {
  const tree: Tree = structuredClone(initial);
  const notices: Notice[] = [];
  const trashed: string[] = [];
  const failures: Array<{ conflict: MoveConflict; error: unknown }> = [];
  let session: SessionInfo = { lastPath: null, lastFolder: null };

  const find = (parent: string, name: string) => (tree[parent] ?? []).find((e) => e.name.toLowerCase() === name.toLowerCase());
  const remove = (path: string) => {
    const parent = parentOf(path);
    tree[parent] = (tree[parent] ?? []).filter((e) => e.path !== path);
    for (const key of Object.keys(tree)) if (key === path || key.startsWith(`${path}/`)) delete tree[key];
  };
  const place = (entry: FolderEntry, destDir: string, name: string) => {
    const to = `${destDir}/${name}`;
    const moved: FolderEntry = { ...entry, name, path: to };
    for (const key of Object.keys(tree)) {
      if (key === entry.path || key.startsWith(`${entry.path}/`)) {
        const next = `${to}${key.slice(entry.path.length)}`;
        tree[next] = tree[key]!.map((e) => ({ ...e, path: `${to}${e.path.slice(entry.path.length)}` }));
        delete tree[key];
      }
    }
    tree[parentOf(entry.path)] = tree[parentOf(entry.path)]!.filter((e) => e.path !== entry.path);
    tree[destDir] = [...(tree[destDir] ?? []), moved];
    return to;
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
    createFile: vi.fn(async (parent: string, name: string) => `${parent}/${name}`),
    createFolder: vi.fn(async (parent: string, name: string) => `${parent}/${name}`),
    renameEntry: vi.fn(async (path: string, name: string) => `${parentOf(path)}/${name}`),
    trashEntry: vi.fn(async (path: string) => {
      remove(path);
    }),
    moveEntry: vi.fn(async (path: string, destDir: string, conflict: MoveConflict) => {
      if (options.failMove) throw options.failMove;
      const entry = (tree[parentOf(path)] ?? []).find((e) => e.path === path);
      if (!entry) throw new BridgeError('not-found', 'no such item');
      const name = entry.name;
      const existing = find(destDir, name);
      if (!existing) return place(entry, destDir, name);
      if (conflict === 'fail') throw new BridgeError('already-exists', 'exists');
      if (conflict === 'replace') {
        trashed.push(existing.path);
        remove(existing.path);
        return place(entry, destDir, name);
      }
      const dot = name.lastIndexOf('.');
      for (let n = 2; n < 1000; n++) {
        const candidate = dot > 0 && entry.kind === 'file' ? `${name.slice(0, dot)} ${n}${name.slice(dot)}` : `${name} ${n}`;
        if (!find(destDir, candidate)) return place(entry, destDir, candidate);
      }
      throw new BridgeError('already-exists', 'no free name');
    }),
    watchFolders: vi.fn(async (_paths: readonly string[]) => {}),
    onFolderChanged: vi.fn(async (_cb: (path: string) => void) => () => {}),
  };

  const documents = {
    isDocumentInside: vi.fn((path: string) => options.documentInside?.(path) ?? false),
    rename: vi.fn(async (_old: string, perform: () => Promise<string>): Promise<string | null> =>
      options.renameResult === 'busy' ? null : perform(),
    ),
    checkExternal: vi.fn(async () => {}),
    open: vi.fn(async (_path: string) => true),
  } satisfies ExplorerDocuments;
  const confirmMove = vi.fn(async (_info: MoveConflictInfo) => options.choice ?? 'keep-both');

  const explorer = new ExplorerController({
    bridge,
    notify: (n) => notices.push(n),
    confirmMove,
    documents,
    onMoveFailed: (conflict, error) => failures.push({ conflict, error }),
  });
  const rows = () => {
    const s = explorer.getState();
    return s.root === null ? [] : flattenRows(buildTree(s.root, s.dirs, s.expanded));
  };
  const labels = () => rows().map((r) => `${' '.repeat(r.level - 1)}${r.label}`);
  return { explorer, bridge, documents, confirmMove, notices, failures, tree, trashed, rows, labels };
}

const TREE: Tree = {
  '/r': [dir('docs', '/r'), dir('empty', '/r'), dir('more', '/r'), file('a.md', '/r'), file('b.md', '/r')],
  '/r/docs': [dir('deep', '/r/docs'), file('x.md', '/r/docs')],
  '/r/docs/deep': [file('d.md', '/r/docs/deep')],
  '/r/empty': [],
  '/r/more': [file('a.md', '/r/more'), file('y.txt', '/r/more')],
};

const flush = () => new Promise((r) => setTimeout(r, 0));

async function opened(tree: Tree = TREE, options: Parameters<typeof setup>[1] = {}) {
  const t = setup(tree, options);
  await t.explorer.chooseFolder();
  return t;
}

describe('where an item is dropped or pasted', () => {
  it('a folder row means inside it, a file row its parent, and no row the root', async () => {
    const t = await opened();
    t.explorer.expand('/r/docs');
    await flush();
    expect(t.explorer.dropDirFor('/r/docs')).toBe('/r/docs');
    expect(t.explorer.dropDirFor('/r/a.md')).toBe('/r');
    expect(t.explorer.dropDirFor('/r/docs/x.md')).toBe('/r/docs');
    expect(t.explorer.dropDirFor(null)).toBe('/r');
    expect(t.explorer.dropDirFor('/r/not-a-row')).toBe('/r');
  });

  it('a note row (empty folder, loading) is part of its folder, and a link to a folder is not a folder to drop into', async () => {
    const t = await opened({
      ...TREE,
      '/r': [...TREE['/r']!, { name: 'link', path: '/r/link', kind: 'symlinkDir' }],
    });
    t.explorer.expand('/r/empty');
    await flush();
    const note = t.rows().find((r) => r.kind === 'note' && r.parentId === '/r/empty');
    expect(note).toBeDefined();
    expect(t.explorer.dropDirFor(note!.id)).toBe('/r/empty');
    expect(t.explorer.dropDirFor('/r/link')).toBe('/r');
  });

  it('is nothing before a folder is opened', () => {
    const t = setup(TREE);
    expect(t.explorer.dropDirFor(null)).toBeNull();
    expect(t.explorer.canDrop('/r/a.md', null)).toBe(false);
  });
});

describe('what can be moved where', () => {
  it('refuses the same folder and a folder into itself or into its own descendant, and allows everything else', async () => {
    const t = await opened();
    t.explorer.expand('/r/docs');
    await flush();
    t.explorer.expand('/r/docs/deep');
    await flush();
    expect(t.explorer.moveVerdict('/r/a.md', '/r')).toBe('same-folder');
    expect(t.explorer.moveVerdict('/r/docs/x.md', '/r/docs')).toBe('same-folder');
    expect(t.explorer.moveVerdict('/r/docs', '/r/docs')).toBe('into-itself');
    expect(t.explorer.moveVerdict('/r/docs', '/r/docs/deep')).toBe('into-itself');
    expect(t.explorer.moveVerdict('/r/a.md', '/r/docs')).toBe('ok');
    expect(t.explorer.moveVerdict('/r/docs/deep', '/r')).toBe('ok');
    expect(t.explorer.moveVerdict('/r/gone.md', '/r/docs')).toBe('unknown');

    // 行に対応する判断（落とせるか）。
    expect(t.explorer.canDrop('/r/a.md', '/r/docs')).toBe(true);
    expect(t.explorer.canDrop('/r/a.md', '/r/b.md')).toBe(false);
    expect(t.explorer.canDrop('/r/a.md', null)).toBe(false);
    expect(t.explorer.canDrop('/r/docs', '/r/docs/x.md')).toBe(false);
    expect(t.explorer.canDrop('/r/docs/x.md', null)).toBe(true);
  });

  it('does not call the bridge for a move that is refused, and tells about a folder into itself', async () => {
    const t = await opened();
    t.explorer.expand('/r/docs');
    await flush();
    expect(await t.explorer.move('/r/a.md', '/r')).toBe(false);
    expect(await t.explorer.move('/r/docs', '/r/docs')).toBe(false);
    expect(t.bridge.moveEntry).not.toHaveBeenCalled();
    expect(t.notices).toEqual([{ kind: 'info', message: 'フォルダは、自分自身の中には移せません。' }]);
  });
});

describe('moving', () => {
  it('moves into a folder, opens it, selects the moved item and re-reads both folders', async () => {
    const t = await opened();
    t.explorer.select('/r/b.md');
    const before = t.bridge.listFolder.mock.calls.length;
    expect(await t.explorer.move('/r/a.md', '/r/docs')).toBe(true);
    expect(t.bridge.moveEntry).toHaveBeenCalledWith('/r/a.md', '/r/docs', 'fail');
    expect(t.labels()).toEqual(['docs', ' deep', ' a.md', ' x.md', 'empty', 'more', 'b.md']);
    const state = t.explorer.getState();
    expect(state.expanded.has('/r/docs')).toBe(true);
    expect(state.selected).toBe('/r/docs/a.md');
    expect(t.bridge.listFolder.mock.calls.slice(before).map((c) => c[0]).sort()).toEqual(['/r', '/r/docs']);
    expect(t.notices).toEqual([]);
  });

  it('moves to the root when no destination is given', async () => {
    const t = await opened();
    t.explorer.expand('/r/docs');
    await flush();
    expect(await t.explorer.move('/r/docs/x.md')).toBe(true);
    expect(t.bridge.moveEntry).toHaveBeenCalledWith('/r/docs/x.md', '/r', 'fail');
    expect(t.tree['/r']!.map((e) => e.name)).toContain('x.md');
    expect(t.tree['/r/docs']!.map((e) => e.name)).toEqual(['deep']);
    expect(t.explorer.getState().selected).toBe('/r/x.md');
  });

  it('keeps the expansion of a moved folder and of the folders inside it, under the new paths', async () => {
    const t = await opened();
    t.explorer.expand('/r/docs');
    await flush();
    t.explorer.expand('/r/docs/deep');
    await flush();
    t.explorer.select('/r/docs/deep/d.md');
    expect(await t.explorer.move('/r/docs', '/r/more')).toBe(true);
    const state = t.explorer.getState();
    expect([...state.expanded].sort()).toEqual(['/r/more', '/r/more/docs', '/r/more/docs/deep']);
    // 選択は、移した項目に移る（中の項目の選択は引き継がない）。
    expect(state.selected).toBe('/r/more/docs');
    expect(state.dirs.has('/r/docs')).toBe(false);
    expect(t.labels()).toEqual(['empty', 'more', ' docs', '  deep', '   d.md', '  x.md', ' a.md', ' y.txt', 'a.md', 'b.md']);
  });

  it('moves through the document controller, so that an open document follows (the same path as a rename)', async () => {
    const t = await opened();
    await t.explorer.move('/r/a.md', '/r/docs');
    expect(t.documents.rename).toHaveBeenCalledTimes(1);
    expect(t.documents.rename.mock.calls[0]![0]).toBe('/r/a.md');
  });

  it('says it was busy, and moves nothing, when the document controller cannot take the move now', async () => {
    const t = await opened(TREE, { renameResult: 'busy' });
    expect(await t.explorer.move('/r/a.md', '/r/docs')).toBe(false);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]!.kind).toBe('error');
    expect(t.notices[0]!.message).toContain('文書の操作の実行中です');
    expect(t.bridge.moveEntry).not.toHaveBeenCalled();
    expect(t.explorer.getState().root).toBe('/r');
  });

  it('moves without a document controller', async () => {
    const t = setup(TREE);
    const bare = new ExplorerController({ bridge: t.bridge, notify: () => {} });
    await bare.chooseFolder();
    expect(await bare.move('/r/a.md', '/r/docs')).toBe(true);
    expect(t.tree['/r/docs']!.map((e) => e.name)).toContain('a.md');
  });

  it('shows a toast with the usual wording, and tells the log hook the conflict and the error, when the move fails', async () => {
    const t = await opened(TREE, { failMove: new BridgeError('io', 'cross-device link at /Users/someone/secret.md') });
    expect(await t.explorer.move('/r/a.md', '/r/docs')).toBe(false);
    expect(t.notices).toEqual([
      { kind: 'error', message: '移動できませんでした。操作に失敗しました（cross-device link at /Users/someone/secret.md）。' },
    ]);
    // ログへ渡すのは、conflict の値と、エラーそのもの（種類だけを記録するのは受け取る側。パスと名前は渡さない）。
    expect(t.failures).toHaveLength(1);
    expect(t.failures[0]!.conflict).toBe('fail');
    expect(t.failures[0]!.error).toBeInstanceOf(BridgeError);
    expect(t.explorer.getState().selected).toBeNull();
    expect(t.labels()).toContain('a.md');
  });

  it('uses the same wording for not-allowed as the other operations', async () => {
    const t = await opened(TREE, { failMove: new BridgeError('not-allowed', 'x') });
    await t.explorer.move('/r/a.md', '/r/docs');
    expect(t.notices[0]!.message).toBe('移動できませんでした。この場所では操作できません。');
  });

  it('does nothing for a note row, an unknown path or before a folder is opened', async () => {
    const t = setup(TREE);
    expect(await t.explorer.move('/r/a.md', '/r/docs')).toBe(false);
    await t.explorer.chooseFolder();
    expect(await t.explorer.move('/r/unknown.md', '/r/docs')).toBe(false);
    expect(t.bridge.moveEntry).not.toHaveBeenCalled();
  });
});

describe('a name that is already taken', () => {
  it('first tries with fail, and asks with the names and the kinds when the name is taken', async () => {
    const t = await opened(TREE, { choice: 'cancel' });
    expect(await t.explorer.move('/r/a.md', '/r/more')).toBe(false);
    expect(t.bridge.moveEntry).toHaveBeenCalledTimes(1);
    expect(t.bridge.moveEntry).toHaveBeenCalledWith('/r/a.md', '/r/more', 'fail');
    expect(t.confirmMove).toHaveBeenCalledWith({
      name: 'a.md',
      destName: 'more',
      movingKind: 'file',
      existingKind: 'file',
      replaceBlockedReason: null,
    });
    // 中止は何も変えない（通知もしない）。
    expect(t.notices).toEqual([]);
    expect(t.tree['/r']!.map((e) => e.name)).toContain('a.md');
    expect(t.explorer.getState().selected).toBeNull();
  });

  it('names the root folder when the destination is the root, and tells when the kinds differ', async () => {
    const t = await opened(
      {
        '/r': [dir('x', '/r'), file('y.md', '/r')],
        '/r/x': [file('x', '/r/x'), dir('y.md', '/r/x')],
        '/r/x/y.md': [],
      },
      { choice: 'cancel' },
    );
    t.explorer.expand('/r/x');
    await flush();
    await t.explorer.move('/r/x/y.md');
    expect(t.confirmMove).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'y.md', destName: 'r', movingKind: 'folder', existingKind: 'file' }),
    );
    await t.explorer.move('/r/x/x');
    expect(t.confirmMove).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'x', destName: 'r', movingKind: 'file', existingKind: 'folder' }),
    );
  });

  it('replace: tries again with replace, the existing item goes to the trash, and the state is carried over', async () => {
    const t = await opened(TREE, { choice: 'replace' });
    t.explorer.expand('/r/more');
    await flush();
    expect(await t.explorer.move('/r/a.md', '/r/more')).toBe(true);
    expect(t.bridge.moveEntry.mock.calls.map((c) => c[2])).toEqual(['fail', 'replace']);
    expect(t.trashed).toEqual(['/r/more/a.md']);
    expect(t.labels()).toEqual(['docs', 'empty', 'more', ' a.md', ' y.txt', 'b.md']);
    expect(t.explorer.getState().selected).toBe('/r/more/a.md');
  });

  it('replace of a folder drops what the explorer knew about the replaced folder, and keeps the moved folder expansion', async () => {
    const t = await opened(
      {
        '/r': [dir('a', '/r'), dir('p', '/r')],
        '/r/a': [dir('same', '/r/a')],
        '/r/a/same': [file('new.md', '/r/a/same')],
        '/r/p': [dir('same', '/r/p')],
        '/r/p/same': [file('old.md', '/r/p/same')],
      },
      { choice: 'replace' },
    );
    t.explorer.expand('/r/a');
    await flush();
    t.explorer.expand('/r/a/same');
    await flush();
    t.explorer.expand('/r/p');
    await flush();
    t.explorer.expand('/r/p/same');
    await flush();
    expect(await t.explorer.move('/r/a/same', '/r/p')).toBe(true);
    expect(t.trashed).toEqual(['/r/p/same']);
    expect(t.labels()).toEqual(['a', ' 空のフォルダ', 'p', ' same', '  new.md']);
    expect([...t.explorer.getState().expanded].sort()).toEqual(['/r/a', '/r/p', '/r/p/same']);
  });

  it('keep both: tries again with keep-both and selects the numbered item', async () => {
    const t = await opened(TREE, { choice: 'keep-both' });
    expect(await t.explorer.move('/r/a.md', '/r/more')).toBe(true);
    expect(t.bridge.moveEntry.mock.calls.map((c) => c[2])).toEqual(['fail', 'keep-both']);
    expect(t.trashed).toEqual([]);
    expect(t.tree['/r/more']!.map((e) => e.name)).toEqual(['a.md', 'y.txt', 'a 2.md']);
    expect(t.explorer.getState().selected).toBe('/r/more/a 2.md');
    expect(t.labels()).toContain(' a 2.md');
  });

  it('cannot replace the open document (or a folder that holds it), and gives the reason', async () => {
    const t = await opened(TREE, { choice: 'cancel', documentInside: (p) => p === '/r/more/a.md' });
    await t.explorer.move('/r/a.md', '/r/more');
    expect(t.confirmMove.mock.calls[0]![0].replaceBlockedReason).toBe('開いている文書を置き換えることになるため、選べません。');

    const folder = await opened(
      { '/r': [dir('d', '/r'), dir('s', '/r')], '/r/d': [dir('s', '/r/d')], '/r/d/s': [file('doc.md', '/r/d/s')], '/r/s': [] },
      { choice: 'cancel', documentInside: (p) => '/r/d/s/doc.md'.startsWith(p) },
    );
    folder.explorer.expand('/r/d');
    await flush();
    await folder.explorer.move('/r/s', '/r/d');
    expect(folder.confirmMove.mock.calls[0]![0].replaceBlockedReason).toContain('開いている文書');
  });

  it('cannot replace a folder that holds the item to move, and gives the reason', async () => {
    const t = await opened(
      { '/r': [dir('docs', '/r')], '/r/docs': [dir('mid', '/r/docs')], '/r/docs/mid': [dir('docs', '/r/docs/mid')], '/r/docs/mid/docs': [] },
      { choice: 'keep-both' },
    );
    t.explorer.expand('/r/docs');
    await flush();
    t.explorer.expand('/r/docs/mid');
    await flush();
    await t.explorer.move('/r/docs/mid/docs');
    expect(t.confirmMove.mock.calls[0]![0].replaceBlockedReason).toBe('移す項目が、置き換える項目の中にあるため、選べません。');
    expect(t.tree['/r']!.map((e) => e.name)).toEqual(['docs', 'docs 2']);
  });

  it('finds the existing item with a different letter case (the file system ignores case) to decide what replace may do', async () => {
    const t = await opened(
      { '/r': [dir('d', '/r'), file('note.md', '/r')], '/r/d': [file('NOTE.md', '/r/d')] },
      { choice: 'cancel', documentInside: (p) => p === '/r/d/NOTE.md' },
    );
    // この bridge は大文字小文字を区別せず、同じ名前として扱う。
    await t.explorer.move('/r/note.md', '/r/d');
    expect(t.confirmMove.mock.calls[0]![0].replaceBlockedReason).toContain('開いている文書');
  });

  it('is cancelled when no confirmation function is given', async () => {
    const t = setup(TREE);
    const bare = new ExplorerController({ bridge: t.bridge, notify: () => {} });
    await bare.chooseFolder();
    expect(await bare.move('/r/a.md', '/r/more')).toBe(false);
    expect(t.bridge.moveEntry).toHaveBeenCalledTimes(1);
  });

  it('reports a failure of the retry (for example, the trash was not available) and logs the conflict that failed', async () => {
    const t = await opened(TREE, { choice: 'replace' });
    t.bridge.moveEntry.mockImplementationOnce(async () => {
      throw new BridgeError('already-exists', 'exists');
    });
    t.bridge.moveEntry.mockImplementationOnce(async () => {
      throw new BridgeError('io', 'the trash is not available');
    });
    expect(await t.explorer.move('/r/a.md', '/r/more')).toBe(false);
    expect(t.notices[0]!.message).toBe('移動できませんでした。操作に失敗しました（the trash is not available）。');
    expect(t.failures.map((f) => f.conflict)).toEqual(['replace']);
  });
});

describe('cut and paste', () => {
  it('marks the selected (or the given) item, and the mark can be removed', async () => {
    const t = await opened();
    t.explorer.select('/r/a.md');
    t.explorer.cut();
    expect(t.explorer.getState().cut).toBe('/r/a.md');
    t.explorer.cut('/r/b.md');
    expect(t.explorer.getState().cut).toBe('/r/b.md');
    t.explorer.cancelCut();
    expect(t.explorer.getState().cut).toBeNull();
  });

  it('does not mark a note row, an unknown path or anything before a folder is opened', async () => {
    const t = setup(TREE);
    t.explorer.cut('/r/a.md');
    expect(t.explorer.getState().cut).toBeNull();
    await t.explorer.chooseFolder();
    t.explorer.expand('/r/empty');
    await flush();
    t.explorer.cut(t.rows().find((r) => r.kind === 'note')!.id);
    t.explorer.cut('/r/unknown.md');
    expect(t.explorer.getState().cut).toBeNull();
  });

  it('pastes into the selected folder, into the parent of a selected file, or into the root, and removes the mark', async () => {
    const t = await opened();
    t.explorer.expand('/r/docs');
    await flush();
    t.explorer.cut('/r/a.md');
    t.explorer.select('/r/docs');
    expect(await t.explorer.paste()).toBe(true);
    expect(t.bridge.moveEntry).toHaveBeenLastCalledWith('/r/a.md', '/r/docs', 'fail');
    expect(t.explorer.getState().cut).toBeNull();

    t.explorer.cut('/r/b.md');
    expect(await t.explorer.paste('/r/docs/x.md')).toBe(true);
    expect(t.bridge.moveEntry).toHaveBeenLastCalledWith('/r/b.md', '/r/docs', 'fail');

    t.explorer.cut('/r/docs/a.md');
    expect(await t.explorer.paste(null)).toBe(true);
    expect(t.bridge.moveEntry).toHaveBeenLastCalledWith('/r/docs/a.md', '/r', 'fail');
    expect(t.tree['/r']!.map((e) => e.name)).toContain('a.md');
  });

  it('does nothing without a mark', async () => {
    const t = await opened();
    expect(await t.explorer.paste('/r/docs')).toBe(false);
    expect(t.bridge.moveEntry).not.toHaveBeenCalled();
  });

  it('keeps the mark when the paste moves nothing (the same folder, a cancelled confirmation, a failure)', async () => {
    const t = await opened(TREE, { choice: 'cancel' });
    t.explorer.cut('/r/a.md');
    expect(await t.explorer.paste(null)).toBe(false);
    expect(t.explorer.getState().cut).toBe('/r/a.md');
    expect(await t.explorer.paste('/r/more')).toBe(false);
    expect(t.explorer.getState().cut).toBe('/r/a.md');
    t.bridge.moveEntry.mockRejectedValueOnce(new BridgeError('io', 'x'));
    expect(await t.explorer.paste('/r/docs')).toBe(false);
    expect(t.explorer.getState().cut).toBe('/r/a.md');
  });

  it('refuses a folder pasted into itself, with a message, and keeps the mark', async () => {
    const t = await opened();
    t.explorer.cut('/r/docs');
    expect(await t.explorer.paste('/r/docs')).toBe(false);
    expect(t.notices).toEqual([{ kind: 'info', message: 'フォルダは、自分自身の中には移せません。' }]);
    expect(t.explorer.getState().cut).toBe('/r/docs');
  });

  it('removes the mark when the item is gone from a re-read folder (an external delete, the trash), and when another folder is opened', async () => {
    const t = await opened();
    t.explorer.cut('/r/a.md');
    t.tree['/r'] = t.tree['/r']!.filter((e) => e.name !== 'a.md');
    t.explorer.handleFolderChanged('/r');
    await flush();
    expect(t.explorer.getState().cut).toBeNull();

    t.explorer.cut('/r/b.md');
    await t.explorer.refresh();
    expect(t.explorer.getState().cut).toBe('/r/b.md');
    t.tree['/r'] = t.tree['/r']!.filter((e) => e.name !== 'b.md');
    await t.explorer.refresh();
    expect(t.explorer.getState().cut).toBeNull();

    t.explorer.expand('/r/more');
    await flush();
    t.explorer.cut('/r/more/y.txt');
    t.tree['/r/more'] = [];
    t.explorer.handleFolderChanged('/r/more');
    await flush();
    expect(t.explorer.getState().cut).toBeNull();

    t.explorer.cut('/r/docs');
    t.tree['/other'] = [file('o.md', '/other')];
    t.bridge.pickFolderPath.mockResolvedValueOnce('/other');
    await t.explorer.chooseFolder();
    expect(t.explorer.getState().cut).toBeNull();
  });

  it('removes the mark when the marked item (or the folder that holds it) is moved to the trash', async () => {
    const t = await opened();
    const confirm = new ExplorerController({
      bridge: t.bridge,
      notify: () => {},
      confirmTrash: async () => true,
    });
    await confirm.chooseFolder();
    confirm.expand('/r/docs');
    await flush();
    confirm.cut('/r/docs/x.md');
    await confirm.requestTrash('/r/docs');
    expect(confirm.getState().cut).toBeNull();
  });

  it('follows a rename of the marked item', async () => {
    const t = await opened();
    t.explorer.cut('/r/a.md');
    t.explorer.beginRename('/r/a.md');
    t.bridge.renameEntry.mockImplementationOnce(async (path: string, name: string) => {
      t.tree['/r'] = t.tree['/r']!.map((e) => (e.path === path ? { ...e, name, path: `/r/${name}` } : e));
      return `/r/${name}`;
    });
    await t.explorer.commitEdit('renamed.md');
    expect(t.explorer.getState().cut).toBe('/r/renamed.md');
  });

  it('keeps the mark on an item that is inside a moved folder, under the new path', async () => {
    const t = await opened();
    t.explorer.expand('/r/docs');
    await flush();
    t.explorer.cut('/r/docs/x.md');
    expect(await t.explorer.move('/r/docs', '/r/more')).toBe(true);
    expect(t.explorer.getState().cut).toBe('/r/more/docs/x.md');
  });
});
