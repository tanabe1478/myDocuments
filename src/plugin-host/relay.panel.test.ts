import { describe, expect, it } from 'vitest';
import { FakeWorker, bootRelay, inWorker, startMessage } from './relayHarness';

// R7: relay.js の、パネル（panel、items）、本文とカーソルの位置（doc、selection）と、Worker の中の API（api.registerPanel、api.document.onDidChange など）。

type Api = {
  registerPanel(r: unknown): { setItems(items: unknown, options?: unknown): void };
  document: { onDidChange(cb: unknown): void; onDidChangeSelection(cb: unknown): void };
};
const api = (self: Record<string, unknown>) => self.api as Api;
const item = (over: object = {}) => ({ text: 'a', depth: 0, offset: 0, ...over });

describe('the API in the Worker (R7)', () => {
  it('registers a panel in the first run; the panel has only setItems (no way to move the cursor); the objects are frozen', () => {
    const { self, posted } = inWorker(`self.panel = api.registerPanel({ id: 'outline', title: 'アウトライン' });`);
    expect(posted).toEqual([{ kind: 'panel', id: 'outline', title: 'アウトライン' }]);
    const panel = self.panel as Record<string, unknown>;
    expect(Object.keys(panel)).toEqual(['setItems']);
    expect(Object.isFrozen(panel)).toBe(true);
    expect(Object.keys(self.api as object)).not.toEqual(expect.arrayContaining(['moveCursor', 'goTo', 'setSelection']));
    expect(Object.isFrozen(api(self).document)).toBe(true);
    expect(Object.keys(api(self).document)).toEqual(['currentPath', 'onDidChange', 'onDidChangeSelection']);
  });

  it.each([
    ['a bad id', `{ id: 'Bad', title: 't' }`],
    ['an empty title', `{ id: 'x', title: '' }`],
    ['a title over 200 characters', `{ id: 'x', title: 'x'.repeat(201) }`],
    ['null', 'null'],
  ])('throws inside the Worker for %s (nothing is sent)', (_n, registration) => {
    const w = () => inWorker(`api.registerPanel(${registration})`);
    expect(w).toThrow();
  });

  it('allows one panel per part, and registration only before init', () => {
    expect(() => inWorker(`api.registerPanel({ id: 'a', title: 't' }); api.registerPanel({ id: 'b', title: 't' });`)).toThrow('1 つまで');
    const { self, deliver } = inWorker('');
    deliver({ kind: 'init' });
    expect(() => api(self).registerPanel({ id: 'late', title: 't' })).toThrow('最初の実行');
    expect(() => api(self).document.onDidChange(() => {})).toThrow('最初の実行');
    expect(() => api(self).document.onDidChangeSelection(() => {})).toThrow('最初の実行');
  });

  it('sends the items with a copy of each item (text, depth, offset), the version, current and emptyText', () => {
    const { self, posted } = inWorker(`self.panel = api.registerPanel({ id: 'p', title: 't' });`);
    posted.length = 0;
    const panel = self.panel as { setItems(items: unknown, options?: unknown): void };
    panel.setItems([{ text: 'a', depth: 1, offset: 2, href: 'javascript:x' }, item({ text: 'b' })], { version: 7, current: 1, emptyText: '空' });
    expect(posted).toEqual([{ kind: 'items', panel: 'p', version: 7, items: [{ text: 'a', depth: 1, offset: 2 }, item({ text: 'b' })], current: 1, empty: '空' }]);
    panel.setItems([], { version: 8 });
    expect(posted.at(-1)).toEqual({ kind: 'items', panel: 'p', version: 8, items: [], current: null, empty: null });
  });

  it.each([
    ['items that are not an array', 'a', { version: 1 }],
    ['no options', [], undefined],
    ['no version', [], {}],
    ['a negative version', [], { version: -1 }],
    ['a fractional version', [], { version: 1.5 }],
    ['a non-object item', ['a'], { version: 1 }],
    ['an empty text', [{ text: '', depth: 0, offset: 0 }], { version: 1 }],
    ['a text over 200 characters', [{ text: 'x'.repeat(201), depth: 0, offset: 0 }], { version: 1 }],
    ['a depth over 7', [{ text: 'a', depth: 8, offset: 0 }], { version: 1 }],
    ['a negative offset', [{ text: 'a', depth: 0, offset: -1 }], { version: 1 }],
    ['a fractional offset', [{ text: 'a', depth: 0, offset: 0.5 }], { version: 1 }],
    ['a current out of range', [item()], { version: 1, current: 1 }],
    ['an empty emptyText', [], { version: 1, emptyText: '' }],
  ])('throws inside the Worker for setItems with %s (nothing is sent)', (_n, items, options) => {
    const { self, posted } = inWorker(`self.panel = api.registerPanel({ id: 'p', title: 't' });`);
    posted.length = 0;
    expect(() => (self.panel as { setItems(a: unknown, b?: unknown): void }).setItems(items, options)).toThrow();
    expect(posted).toEqual([]);
  });

  it('throws for 1001 items, and accepts 1000', () => {
    const { self, posted } = inWorker(`self.panel = api.registerPanel({ id: 'p', title: 't' });`);
    posted.length = 0;
    const panel = self.panel as { setItems(a: unknown, b?: unknown): void };
    expect(() => panel.setItems(Array.from({ length: 1001 }, () => item()), { version: 1 })).toThrow('多すぎます');
    panel.setItems(Array.from({ length: 1000 }, () => item()), { version: 1 });
    expect(posted).toHaveLength(1);
  });

  it('calls the listeners with a frozen snapshot of the document and of the selection', () => {
    const { self, deliver } = inWorker(`
      self.docs = []; self.sels = [];
      api.document.onDidChange((d) => self.docs.push(d));
      api.document.onDidChangeSelection((s) => self.sels.push(s));`);
    deliver({ kind: 'init' });
    deliver({ kind: 'doc', version: 3, textKind: 'plain', text: 'hello' });
    deliver({ kind: 'selection', version: 3, anchor: 1, head: 4 });
    expect(self.docs).toEqual([{ text: 'hello', kind: 'plain', version: 3 }]);
    expect(self.sels).toEqual([{ anchor: 1, head: 4, version: 3 }]);
    expect(Object.isFrozen((self.docs as unknown[])[0])).toBe(true);
    expect(Object.isFrozen((self.sels as unknown[])[0])).toBe(true);
  });

  it('refuses a non-function listener and the 9th listener', () => {
    expect(() => inWorker(`api.document.onDidChange(5)`)).toThrow('関数');
    expect(() => inWorker(Array.from({ length: 9 }, () => `api.document.onDidChange(() => {});`).join('\n'))).toThrow('多すぎます');
  });

  it('a throwing listener is an uncaught error in the Worker (the relay stops the part on the Worker error event)', () => {
    const { deliver } = inWorker(`api.document.onDidChange(() => { throw new Error('boom'); });`);
    deliver({ kind: 'init' });
    expect(() => deliver({ kind: 'doc', version: 1, textKind: 'markdown', text: 'x' })).toThrow('boom');
  });
});

describe('relay.js: panel and items from the Worker', () => {
  const boot = () => {
    const r = bootRelay();
    r.fromMain(startMessage('a'));
    r.fromMain(startMessage('b'));
    const [a, b] = FakeWorker.all as [FakeWorker, FakeWorker];
    return { ...r, a, b };
  };
  const stopped = (r: ReturnType<typeof boot>) => r.sent().filter((m) => m.kind === 'stopped');

  it('forwards panel and items with the plugin id (items copied to the three fields)', () => {
    const r = boot();
    r.a.emit({ kind: 'panel', id: 'p', title: 'T' });
    r.a.emit({ kind: 'items', panel: 'p', version: 2, items: [item()], current: 0, empty: null });
    expect(r.sent().slice(1)).toEqual([
      { kind: 'panel', plugin: 'a', id: 'p', title: 'T', v: 0 },
      { kind: 'items', plugin: 'a', panel: 'p', version: 2, items: [item()], current: 0, empty: null, v: 0 },
    ]);
  });

  it('allows items while the part is still starting (before ready) and after', () => {
    const r = boot();
    r.a.emit({ kind: 'panel', id: 'p', title: 'T' });
    r.a.emit({ kind: 'items', panel: 'p', version: 0, items: [], current: null, empty: null });
    r.a.emit({ kind: 'ready' });
    r.a.emit({ kind: 'items', panel: 'p', version: 1, items: [], current: null, empty: null });
    expect(stopped(r)).toEqual([]);
    expect(r.sent().filter((m) => m.kind === 'items')).toHaveLength(2);
  });

  it.each([
    ['a panel after ready', [{ kind: 'ready' }, { kind: 'panel', id: 'p', title: 'T' }]],
    ['a second panel', [{ kind: 'panel', id: 'p', title: 'T' }, { kind: 'panel', id: 'q', title: 'T' }]],
    ['a bad panel id', [{ kind: 'panel', id: 'P', title: 'T' }]],
    ['an empty panel title', [{ kind: 'panel', id: 'p', title: '' }]],
    ['an extra field on panel', [{ kind: 'panel', id: 'p', title: 'T', html: 'x' }]],
    ['items for a panel that was not registered', [{ kind: 'items', panel: 'p', version: 1, items: [], current: null, empty: null }]],
    ['items for another panel id', [{ kind: 'panel', id: 'p', title: 'T' }, { kind: 'items', panel: 'q', version: 1, items: [], current: null, empty: null }]],
    ['items with 1001 entries', [{ kind: 'panel', id: 'p', title: 'T' }, { kind: 'items', panel: 'p', version: 1, items: Array.from({ length: 1001 }, () => item()), current: null, empty: null }]],
    ['an item with a text over 200 characters', [{ kind: 'panel', id: 'p', title: 'T' }, { kind: 'items', panel: 'p', version: 1, items: [item({ text: 'x'.repeat(201) })], current: null, empty: null }]],
    ['an item with a depth over 7', [{ kind: 'panel', id: 'p', title: 'T' }, { kind: 'items', panel: 'p', version: 1, items: [item({ depth: 8 })], current: null, empty: null }]],
    ['an item with an offset over the limit', [{ kind: 'panel', id: 'p', title: 'T' }, { kind: 'items', panel: 'p', version: 1, items: [item({ offset: 2147483648 })], current: null, empty: null }]],
    ['an item with an extra field (a URL)', [{ kind: 'panel', id: 'p', title: 'T' }, { kind: 'items', panel: 'p', version: 1, items: [item({ href: 'javascript:x' })], current: null, empty: null }]],
    ['a current out of range', [{ kind: 'panel', id: 'p', title: 'T' }, { kind: 'items', panel: 'p', version: 1, items: [item()], current: 1, empty: null }]],
    ['items without current', [{ kind: 'panel', id: 'p', title: 'T' }, { kind: 'items', panel: 'p', version: 1, items: [] , empty: null }]],
    ['an empty string as the empty text', [{ kind: 'panel', id: 'p', title: 'T' }, { kind: 'items', panel: 'p', version: 1, items: [], current: null, empty: '' }]],
    ['a version of -1', [{ kind: 'panel', id: 'p', title: 'T' }, { kind: 'items', panel: 'p', version: -1, items: [], current: null, empty: null }]],
  ])('stops the part for %s (a message the Worker cannot have been built to send by the API)', (_n, messages) => {
    const r = boot();
    for (const m of messages) r.a.emit(m);
    expect(stopped(r)).toHaveLength(1);
    expect(stopped(r)[0]).toMatchObject({ plugin: 'a' });
    expect(String(stopped(r)[0]!.reason)).toContain('不正なメッセージ');
    expect(r.a.terminated).toBe(1);
    expect(r.b.terminated).toBe(0);
  });

  it('stops the part that sends setItems more than 30 times in a second, and only that part', () => {
    const r = boot();
    r.a.emit({ kind: 'panel', id: 'p', title: 'T' });
    r.b.emit({ kind: 'panel', id: 'p', title: 'T' });
    const items = { kind: 'items', panel: 'p', version: 1, items: [], current: null, empty: null };
    for (let i = 0; i < 30; i++) r.a.emit(items);
    expect(stopped(r)).toEqual([]);
    r.a.emit(items);
    expect(stopped(r)).toHaveLength(1);
    expect(String(stopped(r)[0]!.reason)).toContain('setItems が多すぎます');
    expect(r.a.terminated).toBe(1);
    // ほかの部品は動き続ける。
    r.b.emit(items);
    expect(r.b.terminated).toBe(0);
    expect(r.sent().filter((m) => m.kind === 'items' && m.plugin === 'b')).toHaveLength(1);
    // 止めたあとのメッセージは通さない。
    const before = r.sent().length;
    r.a.emit(items);
    expect(r.sent()).toHaveLength(before);
  });

  it('counts the limit over a sliding window of one second: it resets as time passes', () => {
    let now = 1_000_000;
    const r = bootRelay(() => now);
    r.fromMain(startMessage('a'));
    const worker = FakeWorker.all[0]!;
    worker.emit({ kind: 'panel', id: 'p', title: 'T' });
    const items = { kind: 'items', panel: 'p', version: 1, items: [], current: null, empty: null };
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 30; i++) worker.emit(items);
      now += 1000;
    }
    expect(r.sent().filter((m) => m.kind === 'stopped')).toEqual([]);
    expect(r.sent().filter((m) => m.kind === 'items')).toHaveLength(90);
  });
});

describe('relay.js: doc and selection from the host', () => {
  const boot = (ready = true) => {
    const r = bootRelay();
    r.fromMain(startMessage('a'));
    r.fromMain(startMessage('b'));
    const [a, b] = FakeWorker.all as [FakeWorker, FakeWorker];
    if (ready) {
      a.emit({ kind: 'ready' });
      b.emit({ kind: 'ready' });
    }
    return { ...r, a, b };
  };
  const doc = (over: object = {}) => ({ v: 0, kind: 'doc', plugin: 'a', version: 1, textKind: 'markdown', text: '# a', ...over });
  const selection = (over: object = {}) => ({ v: 0, kind: 'selection', plugin: 'a', version: 1, anchor: 0, head: 2, ...over });

  it('passes a doc and a selection only to the Worker of the named part', () => {
    const r = boot();
    r.fromMain(doc());
    r.fromMain(selection());
    expect(r.a.sent.slice(1)).toEqual([
      { kind: 'doc', version: 1, textKind: 'markdown', text: '# a' },
      { kind: 'selection', version: 1, anchor: 0, head: 2 },
    ]);
    expect(r.b.sent).toEqual([{ kind: 'init' }]);
  });

  it('accepts an empty document and the largest allowed text', () => {
    const r = boot();
    r.fromMain(doc({ text: '' }));
    r.fromMain(doc({ text: 'x'.repeat(16 * 1024 * 1024), version: 2 }));
    expect(r.a.sent.filter((m) => (m as { kind: string }).kind === 'doc')).toHaveLength(2);
  });

  it('does not pass anything before the part is ready, or after it was stopped', () => {
    const r = boot(false);
    r.fromMain(doc());
    r.fromMain(selection());
    expect(r.a.sent).toEqual([{ kind: 'init' }]);
    r.a.emit({ kind: 'ready' });
    r.fromMain({ v: 0, kind: 'stop', plugin: 'a' });
    r.fromMain(doc());
    expect(r.a.sent).toEqual([{ kind: 'init' }]);
  });

  it.each([
    ['a text over 16 MiB', doc({ text: 'x'.repeat(16 * 1024 * 1024 + 1) })],
    ['a non-string text', doc({ text: 5 })],
    ['another kind of text', doc({ textKind: 'org' })],
    ['a negative version', doc({ version: -1 })],
    ['a fractional version', doc({ version: 1.5 })],
    ['an extra field on doc', doc({ extra: 1 })],
    ['a missing field on doc', { v: 0, kind: 'doc', plugin: 'a', version: 1, text: 'x' }],
    ['a wrong protocol version', doc({ v: 1 })],
    ['a negative anchor', selection({ anchor: -1 })],
    ['a fractional head', selection({ head: 0.5 })],
    ['an offset over the limit', selection({ head: 2147483648 })],
    ['an extra field on selection', selection({ extra: 1 })],
  ])('ignores %s', (_n, message) => {
    const r = boot();
    r.fromMain(message);
    expect(r.a.sent).toEqual([{ kind: 'init' }]);
    expect(r.a.terminated).toBe(0);
  });
});
