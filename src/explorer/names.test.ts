import { describe, expect, it } from 'vitest';
import {
  NAME_PROBLEM_MESSAGES,
  checkName,
  createTargetDir,
  isSameOrInside,
  joinPath,
  parentOf,
  relocatePath,
  renameSelection,
  separatorOf,
  withDefaultExtension,
} from './names';

describe('checkName', () => {
  it('accepts ordinary names, including Japanese names and names with spaces inside', () => {
    for (const name of ['a.md', 'メモ.md', 'my notes', 'a.b.c', 'x', 'a (1).txt']) {
      expect(checkName(name, [])).toEqual({ ok: true, name });
    }
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['\t', 'empty'],
    ['a/b', 'separator'],
    ['a\\b', 'separator'],
    ['.', 'dot'],
    ['..', 'dot'],
    ['.hidden', 'hidden'],
    ['.md', 'hidden'],
    ['a:b', 'invalid-char'],
    ['a<b', 'invalid-char'],
    ['a>b', 'invalid-char'],
    ['a"b', 'invalid-char'],
    ['a|b', 'invalid-char'],
    ['a?b', 'invalid-char'],
    ['a*b', 'invalid-char'],
    ['a\nb', 'invalid-char'],
    ['a\u0000b', 'invalid-char'],
    ['a.', 'trailing'],
    ['a ', 'trailing'],
  ] as const)('rejects %j (%s) with a reason', (name, problem) => {
    const result = checkName(name, []);
    expect(result).toEqual({ ok: false, problem, message: NAME_PROBLEM_MESSAGES[problem] });
  });

  it('rejects a name that already exists in the folder, but leaves a difference of letter case to the filesystem', () => {
    expect(checkName('a.md', ['a.md', 'b.md'])).toMatchObject({ ok: false, problem: 'duplicate' });
    expect(checkName('A.md', ['a.md'])).toEqual({ ok: true, name: 'A.md' });
  });
});

describe('withDefaultExtension', () => {
  it('adds .md only when there is no extension (the same judgement as fileKinds)', () => {
    expect(withDefaultExtension('note')).toBe('note.md');
    expect(withDefaultExtension('メモ')).toBe('メモ.md');
    expect(withDefaultExtension('note.md')).toBe('note.md');
    expect(withDefaultExtension('note.txt')).toBe('note.txt');
    expect(withDefaultExtension('data.json')).toBe('data.json');
    expect(withDefaultExtension('v1.2')).toBe('v1.2');
  });
});

describe('paths', () => {
  it('joins, finds the parent and keeps the separator of the path', () => {
    expect(joinPath('/a/b', 'c.md')).toBe('/a/b/c.md');
    expect(joinPath('/', 'c.md')).toBe('/c.md');
    expect(joinPath('C:\\work', 'c.md')).toBe('C:\\work\\c.md');
    expect(separatorOf('C:\\work\\x')).toBe('\\');
    expect(separatorOf('/a/b')).toBe('/');
    expect(parentOf('/a/b/c.md')).toBe('/a/b');
    expect(parentOf('C:\\work\\c.md')).toBe('C:\\work');
    expect(parentOf('/a')).toBeNull();
  });

  it('compares by whole components', () => {
    expect(isSameOrInside('/a/b', '/a/b')).toBe(true);
    expect(isSameOrInside('/a/b/c.md', '/a/b')).toBe(true);
    expect(isSameOrInside('/a/bc/c.md', '/a/b')).toBe(false);
    expect(isSameOrInside('/a', '/a/b')).toBe(false);
    expect(isSameOrInside('C:\\w\\d\\x.md', 'C:\\w\\d')).toBe(true);
    expect(isSameOrInside('C:\\w\\dd\\x.md', 'C:\\w\\d')).toBe(false);
  });

  it('moves a path with the renamed ancestor', () => {
    expect(relocatePath('/r/a.md', '/r/a.md', '/r/b.md')).toBe('/r/b.md');
    expect(relocatePath('/r/dir/deep/a.md', '/r/dir', '/r/renamed')).toBe('/r/renamed/deep/a.md');
    expect(relocatePath('/r/other/a.md', '/r/dir', '/r/renamed')).toBeNull();
    expect(relocatePath('/r/dirx/a.md', '/r/dir', '/r/renamed')).toBeNull();
  });
});

describe('renameSelection', () => {
  it('selects the name up to the extension; folders and names without an extension are selected whole', () => {
    expect(renameSelection('note.md', false)).toEqual([0, 4]);
    expect(renameSelection('a.b.md', false)).toEqual([0, 3]);
    expect(renameSelection('note', false)).toEqual([0, 4]);
    expect(renameSelection('v1.2', true)).toEqual([0, 4]);
  });
});

describe('createTargetDir', () => {
  const rows = [
    { id: '/r/docs', parentId: null, kind: 'dir' },
    { id: '/r/docs/x.md', parentId: '/r/docs', kind: 'file' },
    { id: '/r/docs\u0000note:empty', parentId: '/r/docs', kind: 'note' },
    { id: '/r/link', parentId: null, kind: 'symlinkDir' },
    { id: '/r/a.md', parentId: null, kind: 'file' },
  ];

  it('is the selected folder, the parent of a selected file, or the root when nothing (or something unknown) is selected', () => {
    expect(createTargetDir('/r', rows, '/r/docs')).toBe('/r/docs');
    expect(createTargetDir('/r', rows, '/r/docs/x.md')).toBe('/r/docs');
    expect(createTargetDir('/r', rows, '/r/a.md')).toBe('/r');
    expect(createTargetDir('/r', rows, '/r/link')).toBe('/r');
    expect(createTargetDir('/r', rows, null)).toBe('/r');
    expect(createTargetDir('/r', rows, '/r/gone')).toBe('/r');
  });

  it('treats a note row (an empty folder, loading) as part of its folder', () => {
    expect(createTargetDir('/r', rows, '/r/docs\u0000note:empty')).toBe('/r/docs');
  });
});
