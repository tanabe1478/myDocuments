import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMAT, type DocumentFormat } from './format';
import {
  basename,
  documentTitle,
  isDirty,
  mixedEolNotice,
  needsDiscardConfirmation,
  newDocumentState,
  openedDocumentState,
  planSave,
  reloadedDocumentState,
  savedDocumentState,
  suggestedFileName,
  withText,
} from './state';

const crlfBom: DocumentFormat = { bom: true, eol: 'crlf', mixedEol: false };

/** 開いた文書の状態（revision は内容から決めた仮のもの）。 */
const opened = (path: string, text: string, format: DocumentFormat = DEFAULT_FORMAT) =>
  openedDocumentState({ path, text, format, revision: `rev:${text}` }, 'draft-1');

describe('document state', () => {
  it('a new document is untitled, clean, LF without BOM', () => {
    const s = newDocumentState('draft-1');
    expect(s.path).toBeNull();
    expect(s.format).toEqual(DEFAULT_FORMAT);
    expect(isDirty(s)).toBe(false);
    expect(documentTitle(s)).toBe('無題');
    expect(suggestedFileName(s)).toBe('無題.md');
  });

  it('an opened document is clean and keeps its format', () => {
    const s = opened('/notes/a.md', 'hello', crlfBom);
    expect(isDirty(s)).toBe(false);
    expect(s.format).toEqual(crlfBom);
    expect(documentTitle(s)).toBe('a.md');
  });

  it('dirty is derived from the comparison with savedText', () => {
    const s = opened('/a.md', 'abc', DEFAULT_FORMAT);
    const edited = withText(s, 'abcd');
    expect(isDirty(edited)).toBe(true);
    // 元に戻せば、未保存ではなくなる。
    expect(isDirty(withText(edited, 'abc'))).toBe(false);
  });

  it('withText returns the same object when nothing changed', () => {
    const s = opened('/a.md', 'abc', DEFAULT_FORMAT);
    expect(withText(s, 'abc')).toBe(s);
  });

  it('saving records savedText and path, and keeps text typed during the save', () => {
    const s = withText(newDocumentState('draft-1'), 'first');
    const typedMeanwhile = withText(s, 'first and more');
    const saved = savedDocumentState(typedMeanwhile, { path: '/x/b.md', text: 'first', format: s.format, revision: 'rev:first' });
    expect(saved.path).toBe('/x/b.md');
    expect(saved.savedText).toBe('first');
    expect(saved.text).toBe('first and more');
    expect(isDirty(saved)).toBe(true);
  });

  it('saving resolves mixedEol and keeps bom and eol', () => {
    const s = opened('/a.md', 'x', { bom: true, eol: 'crlf', mixedEol: true });
    const saved = savedDocumentState(s, { path: '/a.md', text: 'x', format: s.format, revision: 'rev:x' });
    expect(saved.format).toEqual({ bom: true, eol: 'crlf', mixedEol: false });
  });

  it('asks before discarding only when dirty', () => {
    const s = opened('/a.md', 'abc', DEFAULT_FORMAT);
    expect(needsDiscardConfirmation(s)).toBe(false);
    expect(needsDiscardConfirmation(withText(s, 'abcd'))).toBe(true);
    // 新規文書に入力しただけでも未保存。
    expect(needsDiscardConfirmation(withText(newDocumentState('draft-1'), 'x'))).toBe(true);
  });
});

describe('planSave', () => {
  it('chooses a path for an untitled document, even when empty', () => {
    expect(planSave(newDocumentState('draft-1'))).toEqual({ kind: 'choose-path' });
    expect(planSave(withText(newDocumentState('draft-1'), 'x'))).toEqual({ kind: 'choose-path' });
  });

  it('does nothing for a clean document with a path', () => {
    expect(planSave(opened('/a.md', 'abc', DEFAULT_FORMAT))).toEqual({ kind: 'noop' });
  });

  it('writes a dirty document to its path', () => {
    const s = withText(opened('/a.md', 'abc', DEFAULT_FORMAT), 'abcd');
    expect(planSave(s)).toEqual({
      kind: 'write',
      path: '/a.md',
      expectedRevision: 'rev:abc',
      overwrite: false,
      recreate: false,
    });
  });

  it('keep-mine overwrites; a deleted file is recreated even when nothing changed', () => {
    const dirty = withText(opened('/a.md', 'abc'), 'abcd');
    expect(planSave(dirty, 'overwrite')).toMatchObject({ kind: 'write', overwrite: true, recreate: false });
    // 変更がなければ、上書きする必要もない。
    expect(planSave(opened('/a.md', 'abc'), 'overwrite')).toEqual({ kind: 'noop' });
    // 削除されたファイルは、ファイルがない前提（expectedRevision なし）で書く。変更がなくても書く。
    expect(planSave(opened('/a.md', 'abc'), 'recreate')).toEqual({
      kind: 'write',
      path: '/a.md',
      expectedRevision: null,
      overwrite: false,
      recreate: true,
    });
  });
});

describe('disk revision', () => {
  it('is null for a new document, and set by open, save and reload', () => {
    expect(newDocumentState('d').diskRevision).toBeNull();
    const s = opened('/a.md', 'abc');
    expect(s.diskRevision).toBe('rev:abc');
    const saved = savedDocumentState(withText(s, 'abcd'), { path: '/a.md', text: 'abcd', format: s.format, revision: 'rev:abcd' });
    expect(saved.diskRevision).toBe('rev:abcd');
    const reloaded = reloadedDocumentState(withText(s, 'mine'), { path: '/a.md', text: 'disk', format: crlfBom, revision: 'rev:disk' });
    expect(reloaded).toMatchObject({ text: 'disk', savedText: 'disk', diskRevision: 'rev:disk', format: crlfBom, draftId: 'draft-1' });
    expect(isDirty(reloaded)).toBe(false);
  });
});

describe('helpers', () => {
  it('basename handles both separators', () => {
    expect(basename('/a/b/c.md')).toBe('c.md');
    expect(basename('C:\\Users\\me\\c.md')).toBe('c.md');
    expect(basename('c.md')).toBe('c.md');
  });

  it('mixedEolNotice names the majority eol, and is null otherwise', () => {
    expect(mixedEolNotice({ bom: false, eol: 'crlf', mixedEol: true })).toContain('CRLF');
    expect(mixedEolNotice({ bom: false, eol: 'lf', mixedEol: true })).toContain('LF');
    expect(mixedEolNotice({ bom: false, eol: 'lf', mixedEol: false })).toBeNull();
  });
});
