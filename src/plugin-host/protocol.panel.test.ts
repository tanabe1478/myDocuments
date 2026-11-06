import { describe, expect, it } from 'vitest';
import { LIMITS, docMessage, parseRelayMessage, selectionMessage } from './protocol';

// R7: 仲介 → 本体のメッセージ（panel、items）の形と上限の検査と、本体 → 仲介のメッセージ（doc、selection）の作り方。relay.js の検査と同じ規則。

const ok = (data: unknown) => parseRelayMessage(data);
const item = (over: object = {}) => ({ text: '見出し', depth: 0, offset: 0, ...over });
const items = (over: object = {}) => ({ v: 0, kind: 'items', plugin: 'a', panel: 'outline', version: 1, items: [item()], current: null, empty: null, ...over });

describe('parseRelayMessage: panel', () => {
  it('accepts the exact shape', () => {
    expect(ok({ v: 0, kind: 'panel', plugin: 'a', id: 'outline', title: 'アウトライン' })).toEqual({ ok: true, message: { kind: 'panel', plugin: 'a', id: 'outline', title: 'アウトライン' } });
  });
  it.each([
    ['an uppercase id', { id: 'Outline' }],
    ['an empty id', { id: '' }],
    ['an empty title', { title: '' }],
    ['a title over the limit', { title: 'x'.repeat(LIMITS.titleLength + 1) }],
    ['a non-string title', { title: 1 }],
    ['an extra field', { html: '<b>x</b>' }],
    ['a bad plugin id', { plugin: 'A b' }],
  ])('rejects %s', (_n, over) => {
    expect(ok({ v: 0, kind: 'panel', plugin: 'a', id: 'outline', title: 't', ...over }).ok).toBe(false);
  });
});

describe('parseRelayMessage: items', () => {
  it('accepts the exact shape, and copies the items (only text, depth, offset)', () => {
    const parsed = ok(items({ items: [item(), item({ text: 'b', depth: 7, offset: LIMITS.offsetMax })], current: 1, empty: '空です' }));
    expect(parsed).toEqual({
      ok: true,
      message: { kind: 'items', plugin: 'a', panel: 'outline', version: 1, items: [item(), item({ text: 'b', depth: 7, offset: LIMITS.offsetMax })], current: 1, empty: '空です' },
    });
  });

  it('accepts an empty list (with or without a current of null)', () => {
    expect(ok(items({ items: [], current: null })).ok).toBe(true);
  });

  it('accepts strings that look like HTML as text (they are drawn as text by the host)', () => {
    expect(ok(items({ items: [item({ text: '<img src=x onerror=alert(1)>' })] })).ok).toBe(true);
  });

  it('accepts the limits exactly: 1000 items, 200 characters, depth 7', () => {
    expect(ok(items({ items: Array.from({ length: LIMITS.panelItems }, () => item({ text: 'x'.repeat(LIMITS.panelTextLength), depth: LIMITS.panelMaxDepth })) })).ok).toBe(true);
    expect(ok(items({ empty: 'x'.repeat(LIMITS.panelTextLength) })).ok).toBe(true);
  });

  it.each([
    ['more than 1000 items', { items: Array.from({ length: LIMITS.panelItems + 1 }, () => item()) }],
    ['a text over 200 characters', { items: [item({ text: 'x'.repeat(LIMITS.panelTextLength + 1) })] }],
    ['an empty text', { items: [item({ text: '' })] }],
    ['a non-string text', { items: [item({ text: 5 })] }],
    ['a depth over 7', { items: [item({ depth: LIMITS.panelMaxDepth + 1 })] }],
    ['a negative depth', { items: [item({ depth: -1 })] }],
    ['a fractional depth', { items: [item({ depth: 0.5 })] }],
    ['a negative offset', { items: [item({ offset: -1 })] }],
    ['a fractional offset', { items: [item({ offset: 1.5 })] }],
    ['an offset over the limit', { items: [item({ offset: LIMITS.offsetMax + 1 })] }],
    ['an offset of NaN', { items: [item({ offset: Number.NaN })] }],
    ['an extra field on an item (a URL, a style, an id)', { items: [item({ href: 'javascript:alert(1)' })] }],
    ['a missing field on an item', { items: [{ text: 'a', depth: 0 }] }],
    ['an item that is not an object', { items: ['a'] }],
    ['items that are not an array', { items: 'a' }],
    ['a current out of range', { items: [item()], current: 1 }],
    ['a negative current', { items: [item()], current: -1 }],
    ['a current for an empty list', { items: [], current: 0 }],
    ['a missing current', { current: undefined }],
    ['an empty text for no items', { empty: '' }],
    ['an empty text over the limit', { empty: 'x'.repeat(LIMITS.panelTextLength + 1) }],
    ['a negative version', { version: -1 }],
    ['a fractional version', { version: 1.5 }],
    ['a string version', { version: '1' }],
    ['a bad panel id', { panel: 'A' }],
    ['an extra field', { extra: 1 }],
  ])('rejects %s', (_n, over) => {
    const data: Record<string, unknown> = items(over);
    for (const key of Object.keys(data)) if (data[key] === undefined) delete data[key];
    expect(ok(data).ok).toBe(false);
  });
});

describe('the messages from the host', () => {
  it('builds doc and selection with the protocol version and the plugin id', () => {
    expect(docMessage('outline', 4, 'markdown', '# a')).toEqual({ v: 0, kind: 'doc', plugin: 'outline', version: 4, textKind: 'markdown', text: '# a' });
    expect(selectionMessage('outline', 4, 1, 3)).toEqual({ v: 0, kind: 'selection', plugin: 'outline', version: 4, anchor: 1, head: 3 });
  });
  it('never travels from the relay: doc and selection are not accepted as messages from the iframe', () => {
    expect(ok({ v: 0, kind: 'doc', plugin: 'a', version: 1, textKind: 'markdown', text: 'x' }).ok).toBe(false);
    expect(ok({ v: 0, kind: 'selection', plugin: 'a', version: 1, anchor: 0, head: 0 }).ok).toBe(false);
  });
});
