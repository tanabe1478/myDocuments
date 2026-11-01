import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMAT } from './format';
import { draftTitle, planStartup, restoreFromDraft } from './recovery';
import { isDirty } from './state';
import { draftOf } from './testKit';

const summary = (draftId: string, updatedAt: number, path: string | null = null) => ({ draftId, path, updatedAt });

describe('planStartup', () => {
  it('asks about the newest draft when there are drafts, and counts the others', () => {
    const plan = planStartup([summary('old', 1), summary('new', 9), summary('mid', 5)], { lastPath: '/last.md' });
    expect(plan).toEqual({ kind: 'ask-draft', draft: summary('new', 9), others: 2 });
  });

  it('reopens the last document when there is no draft', () => {
    expect(planStartup([], { lastPath: '/last.md' })).toEqual({ kind: 'reopen', path: '/last.md' });
  });

  it('does nothing without drafts and without a last document', () => {
    expect(planStartup([], { lastPath: null })).toEqual({ kind: 'nothing' });
    expect(planStartup([], null)).toEqual({ kind: 'nothing' });
  });

  it('a draft takes priority over the last document', () => {
    expect(planStartup([summary('d', 1)], { lastPath: '/last.md' }).kind).toBe('ask-draft');
  });
});

describe('draftTitle', () => {
  it('uses the file name, or the untitled label', () => {
    expect(draftTitle({ path: '/notes/a.md' }, '無題')).toBe('a.md');
    expect(draftTitle({ path: null }, '無題')).toBe('無題');
  });
});

describe('restoreFromDraft', () => {
  const disk = (text: string, revision: string) => ({ text, revision, format: DEFAULT_FORMAT });

  it('a draft without a path is restored as an unsaved untitled document', () => {
    const r = restoreFromDraft(draftOf({ draftId: 'd1', text: 'unsaved' }), null);
    expect(r.state).toMatchObject({ path: null, text: 'unsaved', savedText: '', diskRevision: null, draftId: 'd1' });
    expect(isDirty(r.state)).toBe(true);
    expect(r.external.kind).toBe('none');
  });

  it('restores as a normal unsaved document when the original is still at the draft base revision', () => {
    const draft = draftOf({ draftId: 'd1', path: '/a.md', text: 'base + mine', baseRevision: 'r0' });
    const r = restoreFromDraft(draft, disk('base', 'r0'));
    expect(r.state).toMatchObject({ path: '/a.md', text: 'base + mine', savedText: 'base', diskRevision: 'r0' });
    expect(isDirty(r.state)).toBe(true);
    expect(r.external.kind).toBe('none');
    expect(r.redundant).toBe(false);
  });

  it('treats a changed original as a conflict (the draft base revision is kept, so saving conflicts)', () => {
    const draft = draftOf({ draftId: 'd1', path: '/a.md', text: 'base + mine', baseRevision: 'r0' });
    const r = restoreFromDraft(draft, disk('edited elsewhere', 'r1'));
    expect(r.state).toMatchObject({ text: 'base + mine', savedText: 'edited elsewhere', diskRevision: 'r0' });
    expect(r.external).toMatchObject({ kind: 'conflict', keepMine: false, disk: { kind: 'changed', revision: 'r1', text: 'edited elsewhere' } });
    expect(isDirty(r.state)).toBe(true);
  });

  it('is redundant when the draft equals the disk content (nothing to recover)', () => {
    const draft = draftOf({ draftId: 'd1', path: '/a.md', text: 'same', baseRevision: 'r0' });
    const r = restoreFromDraft(draft, disk('same', 'r1'));
    expect(r.redundant).toBe(true);
    expect(isDirty(r.state)).toBe(false);
    expect(r.external.kind).toBe('none');
    expect(r.state.diskRevision).toBe('r1');
  });

  it('falls back to an untitled document when the original cannot be read', () => {
    const draft = draftOf({ draftId: 'd1', path: '/gone.md', text: 'precious', baseRevision: 'r0' });
    const r = restoreFromDraft(draft, null);
    expect(r.state).toMatchObject({ path: null, text: 'precious', diskRevision: null });
    expect(isDirty(r.state)).toBe(true);
  });
});
