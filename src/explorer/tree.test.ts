import { describe, expect, it } from 'vitest';
import type { FolderEntry } from '../platform';
import {
  buildTree,
  flattenRows,
  navigate,
  sortEntries,
  type DirState,
  type TreeKey,
  type TreeRow,
} from './tree';

const file = (name: string, parent = '/r'): FolderEntry => ({ name, path: `${parent}/${name}`, kind: 'file' });
const dir = (name: string, parent = '/r'): FolderEntry => ({ name, path: `${parent}/${name}`, kind: 'dir' });
const link = (name: string, parent = '/r'): FolderEntry => ({ name, path: `${parent}/${name}`, kind: 'symlinkDir' });

const loaded = (entries: FolderEntry[], more = 0): DirState => ({ status: 'loaded', entries, more });

describe('sortEntries', () => {
  it('puts folders first, then sorts by natural order ignoring case', () => {
    const sorted = sortEntries([
      file('file10.md'),
      file('File2.md'),
      dir('zeta'),
      file('file1.md'),
      dir('Alpha'),
      dir('dir10'),
      dir('dir9'),
    ]);
    expect(sorted.map((e) => e.name)).toEqual(['Alpha', 'dir9', 'dir10', 'zeta', 'file1.md', 'File2.md', 'file10.md']);
  });

  it('treats a symlink to a folder as a folder for ordering', () => {
    expect(sortEntries([file('a.md'), link('z-link'), dir('b')]).map((e) => e.name)).toEqual(['b', 'z-link', 'a.md']);
  });

  it('sorts Japanese names and does not mutate the input', () => {
    const input = [file('第10章.md'), file('第2章.md'), file('あ.md')];
    const copy = [...input];
    expect(sortEntries(input).map((e) => e.name)).toEqual(['あ.md', '第2章.md', '第10章.md']);
    expect(input).toEqual(copy);
  });

  it('is deterministic for names that differ only in case', () => {
    expect(sortEntries([file('a.md'), file('A.md')]).map((e) => e.name)).toEqual(['A.md', 'a.md']);
    expect(sortEntries([file('A.md'), file('a.md')]).map((e) => e.name)).toEqual(['A.md', 'a.md']);
  });
});

describe('buildTree', () => {
  const dirs = new Map<string, DirState>([
    ['/r', loaded([dir('docs'), dir('empty'), link('linked'), file('a.md'), file('b.png'), file('c.TXT')])],
    ['/r/docs', loaded([dir('deep', '/r/docs'), file('x.md', '/r/docs')])],
    ['/r/docs/deep', loaded([file('y.text', '/r/docs/deep')])],
    ['/r/empty', loaded([])],
  ]);

  it('shows only the top level when nothing is expanded', () => {
    const tree = buildTree('/r', dirs, new Set());
    expect(tree.map((n) => [n.row.label, n.row.level, n.row.expanded])).toEqual([
      ['docs', 1, false],
      ['empty', 1, false],
      ['linked', 1, false],
      ['a.md', 1, false],
      ['b.png', 1, false],
      ['c.TXT', 1, false],
    ]);
    expect(tree.every((n) => n.children.length === 0)).toBe(true);
  });

  it('marks openable files by extension, case-insensitively, and nothing else', () => {
    const rows = flattenRows(buildTree('/r', dirs, new Set()));
    const openable = Object.fromEntries(rows.map((r) => [r.label, r.openable]));
    expect(openable).toEqual({ docs: false, empty: false, linked: false, 'a.md': true, 'b.png': false, 'c.TXT': true });
  });

  it('expands folders with their level and parent', () => {
    const rows = flattenRows(buildTree('/r', dirs, new Set(['/r/docs', '/r/docs/deep'])));
    expect(rows.map((r) => [r.label, r.level, r.parentId])).toEqual([
      ['docs', 1, null],
      ['deep', 2, '/r/docs'],
      ['y.text', 3, '/r/docs/deep'],
      ['x.md', 2, '/r/docs'],
      ['empty', 1, null],
      ['linked', 1, null],
      ['a.md', 1, null],
      ['b.png', 1, null],
      ['c.TXT', 1, null],
    ]);
  });

  it('never expands a symlink to a folder, even when its path is in the expanded set', () => {
    const rows = flattenRows(buildTree('/r', dirs, new Set(['/r/linked'])));
    const linked = rows.find((r) => r.label === 'linked')!;
    expect(linked.expandable).toBe(false);
    expect(linked.expanded).toBe(false);
  });

  it('shows a note for an empty folder, a loading folder and an error', () => {
    const state = new Map<string, DirState>([
      ['/r', loaded([dir('empty'), dir('busy'), dir('bad')])],
      ['/r/empty', loaded([])],
      ['/r/busy', { status: 'loading' }],
      ['/r/bad', { status: 'error', message: '読めません' }],
    ]);
    const rows = flattenRows(buildTree('/r', state, new Set(['/r/empty', '/r/busy', '/r/bad'])));
    const notes = rows.filter((r) => r.kind === 'note').map((r) => [r.note, r.label, r.level, r.openable]);
    expect(notes).toEqual([
      ['empty', '空のフォルダ', 2, false],
      ['loading', '読み込み中…', 2, false],
      ['error', '読めません', 2, false],
    ]);
  });

  it('shows the not-yet-loaded root as loading', () => {
    const rows = flattenRows(buildTree('/r', new Map(), new Set()));
    expect(rows.map((r) => r.note)).toEqual(['loading']);
  });

  it('ends a truncated folder with a "more" row', () => {
    const rows = flattenRows(buildTree('/r', new Map([['/r', loaded([file('a.md')], 12345)]]), new Set()));
    expect(rows.map((r) => [r.kind, r.label])).toEqual([
      ['file', 'a.md'],
      ['note', 'ほか 12,345 件'],
    ]);
    expect(rows[1]!.openable).toBe(false);
  });

  it('gives every row a distinct id', () => {
    const rows = flattenRows(buildTree('/r', dirs, new Set(['/r/docs', '/r/empty'])));
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
});

describe('navigate', () => {
  const dirs = new Map<string, DirState>([
    ['/r', loaded([dir('docs'), dir('empty'), link('linked'), file('a.md'), file('b.png')])],
    ['/r/docs', loaded([file('x.md', '/r/docs'), file('z.png', '/r/docs')])],
    ['/r/empty', loaded([])],
  ]);
  const rowsFor = (...expanded: string[]): TreeRow[] => flattenRows(buildTree('/r', dirs, new Set(expanded)));
  const press = (rows: TreeRow[], from: string | null, key: TreeKey) => navigate(rows, from, key);

  it('returns null for an empty tree', () => {
    expect(navigate([], null, 'ArrowDown')).toBeNull();
  });

  it('moves down and up, and stops at both ends', () => {
    const rows = rowsFor();
    expect(press(rows, '/r/docs', 'ArrowDown')).toEqual({ focusId: '/r/empty', action: null });
    expect(press(rows, '/r/empty', 'ArrowUp')).toEqual({ focusId: '/r/docs', action: null });
    expect(press(rows, '/r/docs', 'ArrowUp')).toEqual({ focusId: '/r/docs', action: null });
    expect(press(rows, '/r/b.png', 'ArrowDown')).toEqual({ focusId: '/r/b.png', action: null });
  });

  it('jumps to the first and last row with Home and End', () => {
    const rows = rowsFor('/r/docs');
    expect(press(rows, '/r/a.md', 'Home')?.focusId).toBe('/r/docs');
    expect(press(rows, '/r/docs', 'End')?.focusId).toBe('/r/b.png');
  });

  it('starts from the first row when the active row is unknown', () => {
    const rows = rowsFor();
    expect(press(rows, null, 'ArrowDown')?.focusId).toBe('/r/empty');
    expect(press(rows, '/gone', 'ArrowDown')?.focusId).toBe('/r/empty');
  });

  it('expands a collapsed folder with ArrowRight, then moves to its first child', () => {
    expect(press(rowsFor(), '/r/docs', 'ArrowRight')).toEqual({ focusId: '/r/docs', action: 'expand' });
    expect(press(rowsFor('/r/docs'), '/r/docs', 'ArrowRight')).toEqual({ focusId: '/r/docs/x.md', action: null });
  });

  it('does nothing on ArrowRight for files, links and expanded empty folders', () => {
    expect(press(rowsFor(), '/r/a.md', 'ArrowRight')).toEqual({ focusId: '/r/a.md', action: null });
    expect(press(rowsFor(), '/r/linked', 'ArrowRight')).toEqual({ focusId: '/r/linked', action: null });
  });

  it('moves into the note row of an expanded empty folder', () => {
    const rows = rowsFor('/r/empty');
    const next = press(rows, '/r/empty', 'ArrowRight')!;
    expect(rows.find((r) => r.id === next.focusId)?.note).toBe('empty');
  });

  it('collapses an expanded folder with ArrowLeft, otherwise goes to the parent', () => {
    const rows = rowsFor('/r/docs');
    expect(press(rows, '/r/docs', 'ArrowLeft')).toEqual({ focusId: '/r/docs', action: 'collapse' });
    expect(press(rows, '/r/docs/z.png', 'ArrowLeft')).toEqual({ focusId: '/r/docs', action: null });
    expect(press(rowsFor(), '/r/empty', 'ArrowLeft')).toEqual({ focusId: '/r/empty', action: null });
  });

  it('opens an openable file and toggles a folder with Enter and Space', () => {
    const rows = rowsFor('/r/docs');
    expect(press(rows, '/r/a.md', 'Enter')).toEqual({ focusId: '/r/a.md', action: 'open' });
    expect(press(rows, '/r/docs/x.md', ' ')).toEqual({ focusId: '/r/docs/x.md', action: 'open' });
    expect(press(rows, '/r/docs', 'Enter')).toEqual({ focusId: '/r/docs', action: 'toggle' });
  });

  it('does not open files that cannot be opened, links, or note rows', () => {
    const rows = rowsFor('/r/empty');
    expect(press(rows, '/r/b.png', 'Enter')).toEqual({ focusId: '/r/b.png', action: null });
    expect(press(rows, '/r/linked', 'Enter')).toEqual({ focusId: '/r/linked', action: null });
    const note = rows.find((r) => r.kind === 'note')!;
    expect(press(rows, note.id, 'Enter')).toEqual({ focusId: note.id, action: null });
  });
});
