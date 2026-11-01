import { describe, expect, it, vi } from 'vitest';
import type { Notice } from '../document/controller';
import { BridgeError, type FolderEntry, type FolderListing, type SessionInfo } from '../platform';
import { ExplorerController, describeFolderError } from './controller';
import { buildTree, flattenRows } from './tree';

const file = (name: string, parent: string): FolderEntry => ({ name, path: `${parent}/${name}`, kind: 'file' });
const dir = (name: string, parent: string): FolderEntry => ({ name, path: `${parent}/${name}`, kind: 'dir' });

type Tree = Record<string, FolderEntry[]>;

function setup(tree: Tree, session: SessionInfo = { lastPath: null, lastFolder: null }) {
  const notices: Notice[] = [];
  let current = session;
  const listings = new Map<string, () => Promise<FolderListing>>();
  const bridge = {
    pickFolderPath: vi.fn(async (): Promise<string | null> => '/r'),
    openFolder: vi.fn(async (path: string) => {
      if (!(path in tree)) throw new BridgeError('not-found', 'no such folder');
    }),
    listFolder: vi.fn(async (path: string): Promise<FolderListing> => {
      const custom = listings.get(path);
      if (custom) return custom();
      const entries = tree[path];
      if (!entries) throw new BridgeError('not-found', 'no such folder');
      return { entries, total: entries.length };
    }),
    loadSession: vi.fn(async () => current),
    saveSession: vi.fn(async (patch: Partial<SessionInfo>) => {
      current = { ...current, ...patch };
    }),
  };
  const explorer = new ExplorerController({ bridge, notify: (n) => notices.push(n) });
  const rows = () => {
    const s = explorer.getState();
    return s.root === null ? [] : flattenRows(buildTree(s.root, s.dirs, s.expanded)).map((r) => r.label);
  };
  return { explorer, bridge, notices, rows, session: () => current, listings };
}

const TREE: Tree = {
  '/r': [dir('docs', '/r'), dir('more', '/r'), file('b.md', '/r'), file('a.md', '/r')],
  '/r/docs': [file('x.md', '/r/docs')],
  '/r/more': [file('y.txt', '/r/more')],
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('choosing a folder', () => {
  it('opens the folder, lists only its top level, sorts it and remembers it in the session', async () => {
    const t = setup(TREE);
    await t.explorer.chooseFolder();
    expect(t.explorer.getState().root).toBe('/r');
    expect(t.rows()).toEqual(['docs', 'more', 'a.md', 'b.md']);
    expect(t.bridge.openFolder).toHaveBeenCalledWith('/r');
    expect(t.bridge.listFolder.mock.calls).toEqual([['/r']]);
    expect(t.session().lastFolder).toBe('/r');
  });

  it('does nothing when the dialog is cancelled', async () => {
    const t = setup(TREE);
    t.bridge.pickFolderPath.mockResolvedValueOnce(null);
    await t.explorer.chooseFolder();
    expect(t.explorer.getState().root).toBeNull();
    expect(t.bridge.openFolder).not.toHaveBeenCalled();
    expect(t.notices).toEqual([]);
  });

  it('keeps the current folder and reports an error when the new one cannot be opened', async () => {
    const t = setup(TREE);
    await t.explorer.chooseFolder();
    t.bridge.pickFolderPath.mockResolvedValueOnce('/gone');
    await t.explorer.chooseFolder();
    expect(t.explorer.getState().root).toBe('/r');
    expect(t.session().lastFolder).toBe('/r');
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toMatchObject({ kind: 'error' });
    expect(t.notices[0]?.message).toContain('フォルダが見つかりません');
  });

  it('resets the expansion when another folder is opened', async () => {
    const t = setup({ ...TREE, '/other': [file('o.md', '/other')] });
    await t.explorer.chooseFolder();
    t.explorer.expand('/r/docs');
    await flush();
    t.bridge.pickFolderPath.mockResolvedValueOnce('/other');
    await t.explorer.chooseFolder();
    expect(t.rows()).toEqual(['o.md']);
    expect(t.explorer.getState().expanded.size).toBe(0);
  });

  it('shows a slow folder only after its listing arrives, and drops the result of an older choice', async () => {
    const t = setup({ ...TREE, '/slow': [file('s.md', '/slow')] });
    let release: () => void = () => {};
    t.listings.set('/slow', () => new Promise((resolve) => (release = () => resolve({ entries: [file('s.md', '/slow')], total: 1 }))));
    t.bridge.pickFolderPath.mockResolvedValueOnce('/slow');
    const slow = t.explorer.chooseFolder();
    await flush();
    await t.explorer.chooseFolder(); // 後から選んだ /r
    release();
    await slow;
    expect(t.explorer.getState().root).toBe('/r');
    expect(t.session().lastFolder).toBe('/r');
  });
});

describe('restoring the last folder', () => {
  it('opens the folder saved in the session', async () => {
    const t = setup(TREE, { lastPath: null, lastFolder: '/r' });
    await t.explorer.restore();
    expect(t.explorer.getState().root).toBe('/r');
    expect(t.rows()).toEqual(['docs', 'more', 'a.md', 'b.md']);
    expect(t.notices).toEqual([]);
  });

  it('stays unselected when the session has no folder, including a session saved before folders existed', async () => {
    const t = setup(TREE, { lastPath: '/a.md' });
    await t.explorer.restore();
    expect(t.explorer.getState().root).toBeNull();
    expect(t.bridge.openFolder).not.toHaveBeenCalled();
    expect(t.notices).toEqual([]);
  });

  it('falls back to unselected with a short error when the folder is gone, and forgets it', async () => {
    const t = setup(TREE, { lastPath: '/a.md', lastFolder: '/vanished' });
    await t.explorer.restore();
    expect(t.explorer.getState().root).toBeNull();
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]?.message).toContain('前回のフォルダを開けませんでした');
    expect(t.session()).toEqual({ lastPath: '/a.md', lastFolder: null });
  });

  it('falls back to unselected when the folder opens but cannot be read', async () => {
    const t = setup(TREE, { lastPath: null, lastFolder: '/r' });
    t.bridge.listFolder.mockRejectedValueOnce(new BridgeError('permission-denied', 'x'));
    await t.explorer.restore();
    expect(t.explorer.getState().root).toBeNull();
    expect(t.notices[0]?.message).toContain('権限');
  });

  it('runs only once', async () => {
    const t = setup(TREE, { lastPath: null, lastFolder: '/r' });
    await t.explorer.restore();
    await t.explorer.restore();
    expect(t.bridge.openFolder).toHaveBeenCalledTimes(1);
  });
});

describe('lazy loading and expansion', () => {
  it('reads a folder only when it is expanded, and only once', async () => {
    const t = setup(TREE);
    await t.explorer.chooseFolder();
    expect(t.bridge.listFolder).toHaveBeenCalledTimes(1);

    t.explorer.expand('/r/docs');
    expect(t.rows()).toEqual(['docs', '読み込み中…', 'more', 'a.md', 'b.md']);
    await flush();
    expect(t.rows()).toEqual(['docs', 'x.md', 'more', 'a.md', 'b.md']);

    t.explorer.collapse('/r/docs');
    expect(t.rows()).toEqual(['docs', 'more', 'a.md', 'b.md']);
    t.explorer.expand('/r/docs');
    expect(t.rows()).toEqual(['docs', 'x.md', 'more', 'a.md', 'b.md']);
    expect(t.bridge.listFolder.mock.calls.map((c) => c[0])).toEqual(['/r', '/r/docs']);
  });

  it('toggles', async () => {
    const t = setup(TREE);
    await t.explorer.chooseFolder();
    t.explorer.toggle('/r/more');
    await flush();
    expect(t.explorer.getState().expanded.has('/r/more')).toBe(true);
    t.explorer.toggle('/r/more');
    expect(t.explorer.getState().expanded.has('/r/more')).toBe(false);
  });

  it('shows an error row and a toast when a folder cannot be read, and retries on the next expansion', async () => {
    const t = setup(TREE);
    await t.explorer.chooseFolder();
    t.bridge.listFolder.mockRejectedValueOnce(new BridgeError('permission-denied', 'x'));
    t.explorer.expand('/r/docs');
    await flush();
    expect(t.rows()).toEqual(['docs', 'フォルダを読む権限がありません。', 'more', 'a.md', 'b.md']);
    expect(t.notices).toHaveLength(1);

    t.explorer.collapse('/r/docs');
    t.explorer.expand('/r/docs');
    await flush();
    expect(t.rows()).toEqual(['docs', 'x.md', 'more', 'a.md', 'b.md']);
  });

  it('reports how many entries were cut off', async () => {
    const t = setup(TREE);
    t.listings.set('/r', async () => ({ entries: [file('a.md', '/r')], total: 5003 }));
    await t.explorer.chooseFolder();
    expect(t.rows()).toEqual(['a.md', 'ほか 5,002 件']);
  });

  it('ignores a listing that arrives after another folder was opened', async () => {
    const t = setup({ ...TREE, '/other': [file('o.md', '/other')] });
    await t.explorer.chooseFolder();
    let release: () => void = () => {};
    t.listings.set('/r/docs', () => new Promise((resolve) => (release = () => resolve({ entries: [file('x.md', '/r/docs')], total: 1 }))));
    t.explorer.expand('/r/docs');
    t.bridge.pickFolderPath.mockResolvedValueOnce('/other');
    await t.explorer.chooseFolder();
    release();
    await flush();
    expect(t.rows()).toEqual(['o.md']);
    expect(t.explorer.getState().dirs.has('/r/docs')).toBe(false);
  });
});

describe('refresh', () => {
  it('re-reads the folder and the expanded folders, and keeps the expansion', async () => {
    const tree: Tree = { ...TREE };
    const t = setup(tree);
    await t.explorer.chooseFolder();
    t.explorer.expand('/r/docs');
    await flush();
    tree['/r'] = [...tree['/r']!, file('new.md', '/r')];
    tree['/r/docs'] = [file('x.md', '/r/docs'), file('added.md', '/r/docs')];
    await t.explorer.refresh();
    expect(t.rows()).toEqual(['docs', 'added.md', 'x.md', 'more', 'a.md', 'b.md', 'new.md']);
    expect([...t.explorer.getState().expanded]).toEqual(['/r/docs']);
  });

  it('forgets the listing of collapsed folders so they are read fresh next time', async () => {
    const tree: Tree = { ...TREE };
    const t = setup(tree);
    await t.explorer.chooseFolder();
    t.explorer.expand('/r/more');
    await flush();
    t.explorer.collapse('/r/more');
    tree['/r/more'] = [file('changed.txt', '/r/more')];
    await t.explorer.refresh();
    expect(t.explorer.getState().dirs.has('/r/more')).toBe(false);
    t.explorer.expand('/r/more');
    await flush();
    expect(t.rows()).toContain('changed.txt');
  });

  it('collapses a folder that no longer exists', async () => {
    const tree: Tree = { ...TREE };
    const t = setup(tree);
    await t.explorer.chooseFolder();
    t.explorer.expand('/r/docs');
    await flush();
    delete tree['/r/docs'];
    tree['/r'] = tree['/r']!.filter((e) => e.name !== 'docs');
    await t.explorer.refresh();
    expect(t.rows()).toEqual(['more', 'a.md', 'b.md']);
    expect(t.explorer.getState().expanded.size).toBe(0);
  });

  it('keeps the current view and says so when the root cannot be read', async () => {
    const t = setup(TREE);
    await t.explorer.chooseFolder();
    t.bridge.listFolder.mockRejectedValueOnce(new BridgeError('permission-denied', 'x'));
    await t.explorer.refresh();
    expect(t.rows()).toEqual(['docs', 'more', 'a.md', 'b.md']);
    expect(t.notices.at(-1)?.message).toContain('再読み込みできませんでした');
  });

  it('does nothing without a folder', async () => {
    const t = setup(TREE);
    await t.explorer.refresh();
    expect(t.bridge.listFolder).not.toHaveBeenCalled();
  });
});

describe('describeFolderError', () => {
  it('maps every bridge error kind to a short sentence', () => {
    for (const kind of ['not-found', 'permission-denied', 'not-utf8', 'not-allowed', 'invalid-input', 'io'] as const) {
      expect(describeFolderError(new BridgeError(kind, 'detail')).length).toBeGreaterThan(0);
    }
    expect(describeFolderError(new Error('boom'))).toContain('boom');
  });
});
