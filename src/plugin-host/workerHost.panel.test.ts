import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IsolatedItemsUpdate, IsolatedPanelInfo, IsolatedPluginListener } from '../plugin-api';
import { LIMITS, type MainMessage } from './protocol';
import { createWorkerHost, type FrameHandle, type HostTrace } from './workerHost';

// R7: 本体側の仕組み（workerHost）の、パネルの登録、項目の受け取り（形・頻度の上限・状態）、本文とカーソルの位置を部品に届ける口。

const IFRAME_WINDOW = { name: 'the-iframe-window' };

function setup() {
  const posted: MainMessage[] = [];
  let handler: ((event: { source: unknown; data: unknown }) => void) | null = null;
  const events: HostTrace[] = [];
  const frame: FrameHandle = { post: (m) => posted.push(m), owns: (s) => s === IFRAME_WINDOW, dispose() {} };
  const host = createWorkerHost({
    createFrame: () => frame,
    listen: ((h: typeof handler) => {
      handler = h;
      return () => {};
    }) as never,
    trace: (e) => events.push(e),
    report: vi.fn(),
    activateTimeoutMs: 100_000,
    runTimeoutMs: 100_000,
  });
  const fromIframe = (data: unknown) => handler?.({ source: IFRAME_WINDOW, data });
  let helloSent = false;
  /** 部品を起動する。最初の起動のあとに、仲介の hello を送る（iframe は最初の start で作られる）。 */
  const start = (id: string, l: IsolatedPluginListener) => {
    host.start(id, 'c', l);
    if (!helloSent) {
      helloSent = true;
      fromIframe({ v: 0, kind: 'hello' });
    }
  };
  const listener = (over: Partial<IsolatedPluginListener> = {}) => {
    const panels: IsolatedPanelInfo[] = [];
    const updates: IsolatedItemsUpdate[] = [];
    const l: IsolatedPluginListener = {
      onCommand: vi.fn(),
      onReady: vi.fn(),
      onStopped: vi.fn(),
      onPanel: (p) => void panels.push(p),
      onItems: (u) => void updates.push(u),
      ...over,
    };
    return Object.assign(l, { panels, updates });
  };
  return { host, posted, fromIframe, events, listener, start };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const panelMsg = (plugin = 'a', id = 'outline', title = 'アウトライン') => ({ v: 0, kind: 'panel', plugin, id, title });
const itemsMsg = (over: object = {}, plugin = 'a') => ({ v: 0, kind: 'items', plugin, panel: 'outline', version: 1, items: [{ text: 'a', depth: 0, offset: 0 }], current: 0, empty: null, ...over });
const ready = (plugin = 'a') => ({ v: 0, kind: 'ready', plugin });
const stoppedWith = (l: IsolatedPluginListener) => (l.onStopped as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));

describe('panel registration', () => {
  it('hands the panel to the listener once, while the part is starting', () => {
    const t = setup();
    const l = t.listener();
    t.start('a', l);
    t.fromIframe(panelMsg());
    expect(l.panels).toEqual([{ id: 'outline', title: 'アウトライン' }]);
    expect(t.events).toContainEqual({ type: 'panel', plugin: 'a', panel: 'outline' });
    expect(stoppedWith(l)).toEqual([]);
  });

  it('stops the part for a panel after ready, a second panel, or when the listener cannot show panels', () => {
    for (const run of [
      (t: ReturnType<typeof setup>) => {
        t.fromIframe(ready());
        t.fromIframe(panelMsg());
      },
      (t: ReturnType<typeof setup>) => {
        t.fromIframe(panelMsg());
        t.fromIframe(panelMsg('a', 'other'));
      },
    ]) {
      const t = setup();
      const l = t.listener();
      t.start('a', l);
      run(t);
      expect(stoppedWith(l)).toHaveLength(1);
      expect(stoppedWith(l)[0]).toContain('不正なメッセージ');
    }
    const t = setup();
    const l = t.listener({ onPanel: undefined });
    t.start('a', l);
    t.fromIframe(panelMsg());
    expect(stoppedWith(l)[0]).toContain('この環境では使えません');
  });

  it('stops the part when the listener throws on registration', () => {
    const t = setup();
    const l = t.listener({
      onPanel: () => {
        throw new Error('登録できません');
      },
    });
    t.start('a', l);
    t.fromIframe(panelMsg());
    expect(stoppedWith(l)).toEqual(['登録できません']);
  });

  it('a message for a part that is not started is ignored', () => {
    const t = setup();
    t.fromIframe(panelMsg('nobody'));
    expect(t.events).toEqual([]);
  });
});

describe('items', () => {
  it('hands the items to the listener (before and after ready), with the version, current and the empty text', () => {
    const t = setup();
    const l = t.listener();
    t.start('a', l);
    t.fromIframe(panelMsg());
    t.fromIframe(itemsMsg({ version: 0, items: [], current: null, empty: '空' }));
    t.fromIframe(ready());
    t.fromIframe(itemsMsg({ version: 4 }));
    expect(l.updates).toEqual([
      { panel: 'outline', version: 0, items: [], current: null, empty: '空' },
      { panel: 'outline', version: 4, items: [{ text: 'a', depth: 0, offset: 0 }], current: 0, empty: null },
    ]);
    expect(t.events).toContainEqual({ type: 'items', plugin: 'a', panel: 'outline', version: 4, count: 1 });
  });

  it('stops the part for items of a panel it did not register', () => {
    const t = setup();
    const l = t.listener();
    t.start('a', l);
    t.fromIframe(itemsMsg());
    expect(stoppedWith(l)[0]).toContain('登録していないパネル');
    expect(l.updates).toEqual([]);
  });

  it('drops items that do not pass the host-side shape check (bad text, too many, current out of range); they never reach the listener', () => {
    const t = setup();
    const l = t.listener();
    t.start('a', l);
    t.fromIframe(panelMsg());
    for (const bad of [itemsMsg({ items: [{ text: '', depth: 0, offset: 0 }] }), itemsMsg({ items: Array.from({ length: LIMITS.panelItems + 1 }, () => ({ text: 'a', depth: 0, offset: 0 })) }), itemsMsg({ current: 5 })]) t.fromIframe(bad);
    expect(l.updates).toEqual([]);
  });

  it('stops the part that sends more than 30 setItems in a second; the window slides, so a part that stays under the limit keeps running', () => {
    const t = setup();
    const l = t.listener();
    t.start('a', l);
    t.fromIframe(panelMsg());
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < LIMITS.setItemsPerWindow; i++) t.fromIframe(itemsMsg());
      vi.advanceTimersByTime(LIMITS.setItemsWindowMs);
    }
    expect(stoppedWith(l)).toEqual([]);
    expect(l.updates).toHaveLength(90);
    for (let i = 0; i <= LIMITS.setItemsPerWindow; i++) t.fromIframe(itemsMsg());
    expect(stoppedWith(l)).toHaveLength(1);
    expect(stoppedWith(l)[0]).toContain('setItems が多すぎます');
    expect(l.updates).toHaveLength(120);
    // 止めたあとは何も通さない。
    t.fromIframe(itemsMsg());
    expect(l.updates).toHaveLength(120);
    expect(t.posted.at(-1)).toEqual({ v: 0, kind: 'stop', plugin: 'a' });
  });

  it('only the part over the limit is stopped; another part keeps running', () => {
    const t = setup();
    const a = t.listener();
    const b = t.listener();
    t.start('a', a);
    t.start('b', b);
    t.fromIframe(panelMsg('a'));
    t.fromIframe(panelMsg('b'));
    for (let i = 0; i <= LIMITS.setItemsPerWindow; i++) t.fromIframe(itemsMsg({}, 'a'));
    t.fromIframe(itemsMsg({}, 'b'));
    expect(stoppedWith(a)).toHaveLength(1);
    expect(stoppedWith(b)).toEqual([]);
    expect(b.updates).toHaveLength(1);
  });

  it('stops the part when the listener throws on items', () => {
    const t = setup();
    const l = t.listener({
      onItems: () => {
        throw new Error('受け取れません');
      },
    });
    t.start('a', l);
    t.fromIframe(panelMsg());
    t.fromIframe(itemsMsg());
    expect(stoppedWith(l)).toEqual(['受け取れません']);
  });
});

describe('delivering the document and the selection', () => {
  it('posts doc and selection to the relay for a ready part, and traces them (the length, not the text)', () => {
    const t = setup();
    const l = t.listener();
    t.start('a', l);
    t.fromIframe(ready());
    expect(t.host.deliverDocument?.('a', { version: 3, kind: 'markdown', text: '# 見出し\n' })).toBe(true);
    expect(t.host.deliverSelection?.('a', { version: 3, anchor: 1, head: 2 })).toBe(true);
    expect(t.posted.slice(-2)).toEqual([
      { v: 0, kind: 'doc', plugin: 'a', version: 3, textKind: 'markdown', text: '# 見出し\n' },
      { v: 0, kind: 'selection', plugin: 'a', version: 3, anchor: 1, head: 2 },
    ]);
    expect(t.events).toContainEqual({ type: 'doc', plugin: 'a', version: 3, kind: 'markdown', length: 6 });
    expect(t.events).toContainEqual({ type: 'selection', plugin: 'a', version: 3, anchor: 1, head: 2 });
  });

  it('does not deliver to a part that is not ready, was stopped, or is unknown', () => {
    const t = setup();
    const l = t.listener();
    t.start('a', l);
    expect(t.host.deliverDocument?.('a', { version: 1, kind: 'plain', text: 'x' })).toBe(false);
    expect(t.host.deliverSelection?.('a', { version: 1, anchor: 0, head: 0 })).toBe(false);
    t.fromIframe(ready());
    t.host.stop('a');
    expect(t.host.deliverDocument?.('a', { version: 1, kind: 'plain', text: 'x' })).toBe(false);
    expect(t.host.deliverDocument?.('nobody', { version: 1, kind: 'plain', text: 'x' })).toBe(false);
    expect(t.posted.filter((m) => m.kind === 'doc' || m.kind === 'selection')).toEqual([]);
  });

  it('does not deliver a document over the limit (16 MiB)', () => {
    const t = setup();
    t.start('a', t.listener());
    t.fromIframe(ready());
    expect(t.host.deliverDocument?.('a', { version: 1, kind: 'markdown', text: 'x'.repeat(LIMITS.documentTextLength + 1) })).toBe(false);
    expect(t.host.deliverDocument?.('a', { version: 1, kind: 'markdown', text: 'x'.repeat(LIMITS.documentTextLength) })).toBe(true);
  });
});
