import { describe, expect, it, vi } from 'vitest';
import { DRAFT_DELAY_MS, DraftKeeper, buildDraft } from './drafts';
import { openedDocumentState, withText } from './state';
import { LF } from './testKit';

function fixture() {
  let now = 5000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const bridge = { writeDraft: vi.fn(async (_d: unknown) => 'loc'), deleteDraft: vi.fn(async (_id: string) => {}) };
  const onError = vi.fn();
  const keeper = new DraftKeeper({
    bridge,
    onError,
    now: () => now,
    setTimer: (fn, ms) => {
      timers.set(next, { at: now + ms, fn });
      return next++;
    },
    clearTimer: (h) => void timers.delete(h as number),
  });
  const advance = (ms: number) => {
    const target = now + ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= target) {
        timers.delete(id);
        now = t.at;
        t.fn();
      }
    }
    now = target;
  };
  return { keeper, bridge, onError, advance, pending: () => timers.size };
}

const base = openedDocumentState({ path: '/a.md', text: 'base', format: LF, revision: 'r0' }, 'doc-1');

describe('DraftKeeper', () => {
  it('writes nothing while the document is clean', async () => {
    const f = fixture();
    f.keeper.observe(base);
    f.advance(60_000);
    await f.keeper.idle();
    expect(f.bridge.writeDraft).not.toHaveBeenCalled();
    expect(f.bridge.deleteDraft).not.toHaveBeenCalled();
  });

  it('writes the draft once input has been quiet for 2 seconds', async () => {
    expect(DRAFT_DELAY_MS).toBe(2000);
    const f = fixture();
    f.keeper.observe(withText(base, 'base + a'));
    f.advance(1999);
    await f.keeper.idle();
    expect(f.bridge.writeDraft).not.toHaveBeenCalled();
    f.advance(1);
    await f.keeper.idle();
    expect(f.bridge.writeDraft).toHaveBeenCalledTimes(1);
    expect(f.bridge.writeDraft).toHaveBeenCalledWith({
      draftId: 'doc-1',
      path: '/a.md',
      text: 'base + a',
      format: LF,
      baseRevision: 'r0',
      updatedAt: 5000 + 2000,
    });
  });

  it('debounces: every keystroke restarts the wait, and the latest text is written', async () => {
    const f = fixture();
    f.keeper.observe(withText(base, 'b1'));
    f.advance(1500);
    f.keeper.observe(withText(base, 'b12'));
    f.advance(1500);
    await f.keeper.idle();
    expect(f.bridge.writeDraft).not.toHaveBeenCalled();
    f.advance(500);
    await f.keeper.idle();
    expect(f.bridge.writeDraft).toHaveBeenCalledTimes(1);
    expect(f.bridge.writeDraft.mock.calls[0]?.[0]).toMatchObject({ text: 'b12' });
  });

  it('removes the draft when the document is no longer dirty (saved, or edited back)', async () => {
    const f = fixture();
    f.keeper.observe(withText(base, 'changed'));
    f.advance(2000);
    await f.keeper.idle();
    f.keeper.observe(base);
    await f.keeper.idle();
    expect(f.bridge.deleteDraft).toHaveBeenCalledWith('doc-1');
    // 重ねて消さない。
    f.keeper.observe(base);
    await f.keeper.idle();
    expect(f.bridge.deleteDraft).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending write when the document becomes clean first, and does not touch the disk', async () => {
    const f = fixture();
    f.keeper.observe(withText(base, 'x'));
    f.keeper.observe(base);
    expect(f.pending()).toBe(0);
    f.advance(10_000);
    await f.keeper.idle();
    expect(f.bridge.writeDraft).not.toHaveBeenCalled();
    expect(f.bridge.deleteDraft).not.toHaveBeenCalled();
  });

  it('switching to another document drops the previous draft and its pending write', async () => {
    const f = fixture();
    f.keeper.observe(withText(base, 'old doc edits'));
    f.advance(2000);
    f.keeper.observe(withText(base, 'old doc more'));
    const other = openedDocumentState({ path: '/b.md', text: 'b', format: LF, revision: 'rb' }, 'doc-2');
    f.keeper.observe(other);
    f.advance(10_000);
    await f.keeper.idle();
    expect(f.bridge.writeDraft).toHaveBeenCalledTimes(1);
    expect(f.bridge.deleteDraft).toHaveBeenCalledWith('doc-1');
  });

  it('an adopted (recovered) draft is removed once the document is clean', async () => {
    const f = fixture();
    f.keeper.adopt('doc-1');
    f.keeper.observe(base);
    await f.keeper.idle();
    expect(f.bridge.deleteDraft).toHaveBeenCalledWith('doc-1');
  });

  it('discard removes the draft right away and cancels the pending write', async () => {
    const f = fixture();
    f.keeper.observe(withText(base, 'x'));
    f.advance(2000);
    f.keeper.observe(withText(base, 'xy'));
    await f.keeper.discard('doc-1');
    f.advance(10_000);
    await f.keeper.idle();
    expect(f.bridge.writeDraft).toHaveBeenCalledTimes(1);
    expect(f.bridge.deleteDraft).toHaveBeenCalledWith('doc-1');
  });

  it('reports a failure once, until a write succeeds', async () => {
    const f = fixture();
    f.bridge.writeDraft.mockRejectedValueOnce(new Error('disk full')).mockRejectedValueOnce(new Error('disk full'));
    f.keeper.observe(withText(base, 'a'));
    f.advance(2000);
    await f.keeper.idle();
    f.keeper.observe(withText(base, 'ab'));
    f.advance(2000);
    await f.keeper.idle();
    expect(f.onError).toHaveBeenCalledTimes(1);
  });
});

describe('buildDraft', () => {
  it('captures the text, format and the revision the draft is based on', () => {
    const s = withText(base, 'edited');
    expect(buildDraft(s, 42)).toEqual({
      draftId: 'doc-1',
      path: '/a.md',
      text: 'edited',
      format: LF,
      baseRevision: 'r0',
      updatedAt: 42,
    });
  });
});
