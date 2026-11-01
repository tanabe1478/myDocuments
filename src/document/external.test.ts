import { describe, expect, it } from 'vitest';
import {
  NO_EXTERNAL_CHANGE,
  diskTextForDiff,
  isDeleted,
  isUnresolvedConflict,
  keepMine,
  observeDisk,
  savePolicy,
  type ChangedOnDisk,
  type ExternalState,
} from './external';
import { DEFAULT_FORMAT } from './format';
import { openedDocumentState, withText } from './state';

const clean = openedDocumentState({ path: '/a.md', text: 'base', format: DEFAULT_FORMAT, revision: 'r0' }, 'd1');
const dirty = withText(clean, 'base + mine');

const changed = (revision: string, text = `disk ${revision}`): ChangedOnDisk => ({
  kind: 'changed',
  revision,
  text,
  format: DEFAULT_FORMAT,
});

describe('observeDisk: unchanged', () => {
  it('clears any external state (the disk is back to what the document last saw)', () => {
    for (const current of [
      NO_EXTERNAL_CHANGE,
      { kind: 'deleted' } as ExternalState,
      { kind: 'conflict', disk: changed('r1'), keepMine: false } as ExternalState,
    ]) {
      expect(observeDisk(dirty, current, { kind: 'unchanged' })).toEqual({ next: NO_EXTERNAL_CHANGE, effect: 'none' });
    }
  });
});

describe('observeDisk: changed', () => {
  it('reloads automatically when there are no unsaved changes', () => {
    const disk = changed('r1');
    expect(observeDisk(clean, NO_EXTERNAL_CHANGE, disk)).toEqual({
      next: { kind: 'changed', disk },
      effect: 'reload',
    });
  });

  it('becomes a conflict, and announces it, when there are unsaved changes', () => {
    const disk = changed('r1');
    expect(observeDisk(dirty, NO_EXTERNAL_CHANGE, disk)).toEqual({
      next: { kind: 'conflict', disk, keepMine: false },
      effect: 'announce-conflict',
    });
  });

  it('does not announce the same conflict twice, and keeps the user choice', () => {
    const disk = changed('r1');
    const chosen: ExternalState = { kind: 'conflict', disk, keepMine: true };
    const result = observeDisk(dirty, chosen, disk);
    expect(result.effect).toBe('none');
    expect(result.next).toBe(chosen);
  });

  it('updates an unresolved conflict silently when the disk changes again', () => {
    const current: ExternalState = { kind: 'conflict', disk: changed('r1'), keepMine: false };
    const next = changed('r2');
    expect(observeDisk(dirty, current, next)).toEqual({
      next: { kind: 'conflict', disk: next, keepMine: false },
      effect: 'none',
    });
  });

  it('keep-mine is withdrawn, and announced again, when the disk changes after the choice', () => {
    const current: ExternalState = { kind: 'conflict', disk: changed('r1'), keepMine: true };
    const next = changed('r2');
    expect(observeDisk(dirty, current, next)).toEqual({
      next: { kind: 'conflict', disk: next, keepMine: false },
      effect: 'announce-conflict',
    });
  });
});

describe('observeDisk: deleted', () => {
  it('a clean document becomes deleted, with a notice', () => {
    expect(observeDisk(clean, NO_EXTERNAL_CHANGE, { kind: 'deleted' })).toEqual({
      next: { kind: 'deleted' },
      effect: 'announce-deleted',
    });
  });

  it('a dirty document becomes a conflict with a deleted disk', () => {
    expect(observeDisk(dirty, NO_EXTERNAL_CHANGE, { kind: 'deleted' })).toEqual({
      next: { kind: 'conflict', disk: { kind: 'deleted' }, keepMine: false },
      effect: 'announce-deleted',
    });
  });

  it('does not announce a deletion twice', () => {
    const current: ExternalState = { kind: 'deleted' };
    expect(observeDisk(clean, current, { kind: 'deleted' })).toEqual({ next: current, effect: 'none' });
    const conflict: ExternalState = { kind: 'conflict', disk: { kind: 'deleted' }, keepMine: false };
    expect(observeDisk(dirty, conflict, { kind: 'deleted' })).toEqual({ next: conflict, effect: 'none' });
  });

  it('a changed disk turns into a deletion when the file then disappears', () => {
    const current: ExternalState = { kind: 'conflict', disk: changed('r1'), keepMine: false };
    expect(observeDisk(dirty, current, { kind: 'deleted' })).toEqual({
      next: { kind: 'conflict', disk: { kind: 'deleted' }, keepMine: false },
      effect: 'announce-deleted',
    });
  });

  it('a deleted file that reappears with new content reloads a clean document', () => {
    const disk = changed('r9');
    expect(observeDisk(clean, { kind: 'deleted' }, disk)).toEqual({ next: { kind: 'changed', disk }, effect: 'reload' });
  });
});

describe('helpers', () => {
  it('savePolicy: deleted recreates, keep-mine overwrites, otherwise normal', () => {
    expect(savePolicy(NO_EXTERNAL_CHANGE)).toBe('normal');
    expect(savePolicy({ kind: 'deleted' })).toBe('recreate');
    expect(savePolicy({ kind: 'conflict', disk: { kind: 'deleted' }, keepMine: false })).toBe('recreate');
    expect(savePolicy({ kind: 'conflict', disk: changed('r1'), keepMine: false })).toBe('normal');
    expect(savePolicy({ kind: 'conflict', disk: changed('r1'), keepMine: true })).toBe('overwrite');
  });

  it('keepMine only applies to a conflict with a changed disk', () => {
    const conflict: ExternalState = { kind: 'conflict', disk: changed('r1'), keepMine: false };
    expect(keepMine(conflict)).toEqual({ ...conflict, keepMine: true });
    expect(keepMine(NO_EXTERNAL_CHANGE)).toBe(NO_EXTERNAL_CHANGE);
    const deleted: ExternalState = { kind: 'conflict', disk: { kind: 'deleted' }, keepMine: false };
    expect(keepMine(deleted)).toBe(deleted);
  });

  it('predicates and the diff text', () => {
    const conflict: ExternalState = { kind: 'conflict', disk: changed('r1', 'on disk'), keepMine: false };
    expect(isUnresolvedConflict(conflict)).toBe(true);
    expect(isUnresolvedConflict(keepMine(conflict))).toBe(false);
    expect(isDeleted({ kind: 'deleted' })).toBe(true);
    expect(isDeleted(conflict)).toBe(false);
    expect(diskTextForDiff(conflict)).toBe('on disk');
    expect(diskTextForDiff(NO_EXTERNAL_CHANGE)).toBeNull();
    expect(diskTextForDiff({ kind: 'conflict', disk: { kind: 'deleted' }, keepMine: false })).toBeNull();
  });
});
