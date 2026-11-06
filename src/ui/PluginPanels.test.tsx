// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredPanel } from '../plugin-api';
import { PluginPanels } from './PluginPanels';

// R7: 部品のパネルの節。部品の文字列は文字として描かれる。キーボード、aria、たたむ操作。

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const panel = (over: Partial<RegisteredPanel> = {}): RegisteredPanel => ({
  pluginId: 'outline',
  id: 'outline.outline',
  title: 'アウトライン',
  loaded: true,
  version: 1,
  items: [
    { text: 'one', depth: 0, offset: 0 },
    { text: 'two', depth: 1, offset: 10 },
    { text: 'three', depth: 0, offset: 20 },
  ],
  current: 1,
  empty: null,
  ...over,
});

function render(panels: readonly RegisteredPanel[], opts: { collapsed?: string[]; onToggle?: (id: string) => void; onActivate?: (p: RegisteredPanel, i: number) => void } = {}) {
  const onToggle = vi.fn<(id: string) => void>(opts.onToggle);
  const onActivate = vi.fn<(p: RegisteredPanel, i: number) => void>(opts.onActivate);
  act(() => root.render(<PluginPanels panels={panels} collapsed={new Set(opts.collapsed ?? [])} onToggle={onToggle} onActivate={onActivate} />));
  return { onToggle, onActivate };
}
const items = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid=plugin-panel-item]'));
const key = (el: Element, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));

describe('rendering', () => {
  it('renders nothing when no part has a panel', () => {
    render([]);
    expect(container.innerHTML).toBe('');
  });

  it('a section with a heading button (the title), and a list named after the title, one button per item', () => {
    render([panel()]);
    const toggle = container.querySelector('[data-testid=plugin-panel-toggle]')!;
    expect(toggle.textContent).toContain('アウトライン');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('section')!.getAttribute('aria-label')).toBe('アウトライン');
    const list = container.querySelector('ul')!;
    expect(list.getAttribute('aria-label')).toBe('アウトラインの項目');
    expect(items().map((b) => b.textContent)).toEqual(['one', 'two', 'three']);
    expect(items().map((b) => b.dataset.depth)).toEqual(['0', '1', '0']);
  });

  it('marks the current item with aria-current="location" (and only it)', () => {
    render([panel({ current: 2 })]);
    expect(items().map((b) => b.getAttribute('aria-current'))).toEqual([null, null, 'location']);
    render([panel({ current: null })]);
    expect(items().map((b) => b.getAttribute('aria-current'))).toEqual([null, null, null]);
  });

  it('shows the empty text the part gave, or a default, and nothing before the part has sent anything', () => {
    render([panel({ items: [], current: null, empty: '見出しはありません' })]);
    expect(container.querySelector('[data-testid=plugin-panel-empty]')!.textContent).toBe('見出しはありません');
    render([panel({ items: [], current: null, empty: null })]);
    expect(container.querySelector('[data-testid=plugin-panel-empty]')!.textContent).toBe('項目はありません');
    render([panel({ loaded: false, items: [], current: null })]);
    expect(container.querySelector('[data-testid=plugin-panel-empty]')).toBeNull();
    expect(container.querySelector('ul')).toBeNull();
  });
});

describe('strings from a part are text, never HTML', () => {
  const evil = ['<img src=x onerror="window.__pwned = 1">', '<script>window.__pwned = 1</script>', '<a href="javascript:window.__pwned=1">x</a>', '"><svg onload=window.__pwned=1>'];

  it('draws a title, item texts and an empty text containing markup as plain text: no element is created from them', () => {
    (window as { __pwned?: number }).__pwned = 0;
    render([panel({ title: evil[0]!, items: evil.map((text, i) => ({ text, depth: i, offset: i })), current: 0 })]);
    expect(container.querySelectorAll('img, script, svg, a')).toHaveLength(0);
    expect(items().map((b) => b.textContent)).toEqual(evil);
    expect(container.querySelector('[data-testid=plugin-panel-toggle]')!.textContent).toContain(evil[0]);
    render([panel({ items: [], current: null, empty: evil[1]! })]);
    expect(container.querySelectorAll('img, script, svg, a')).toHaveLength(0);
    expect(container.querySelector('[data-testid=plugin-panel-empty]')!.textContent).toBe(evil[1]);
    expect((window as { __pwned?: number }).__pwned).toBe(0);
  });

  it('only the elements and attributes the host decides appear: no attribute carries a part string except the accessible names', () => {
    render([panel({ title: 'T"x', items: [{ text: 'a" onclick="x', depth: 1, offset: 0 }], current: 0 })]);
    const allowed = new Set(['class', 'type', 'data-testid', 'data-index', 'data-depth', 'tabindex', 'aria-current', 'aria-expanded', 'aria-controls', 'aria-label', 'aria-hidden', 'data-panel-id', 'data-collapsed', 'id', 'hidden']);
    for (const el of Array.from(container.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) expect(allowed.has(attr.name), `${el.tagName} ${attr.name}`).toBe(true);
    }
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    expect(container.querySelector('button.plugin-panel-item')!.getAttribute('onclick')).toBeNull();
  });
});

describe('collapsing', () => {
  it('the heading button toggles (aria-expanded), and a collapsed body is hidden (its items cannot take focus)', () => {
    const { onToggle } = render([panel()]);
    act(() => container.querySelector<HTMLElement>('[data-testid=plugin-panel-toggle]')!.click());
    expect(onToggle).toHaveBeenCalledWith('outline.outline');
    render([panel()], { collapsed: ['outline.outline'], onToggle });
    expect(container.querySelector('[data-testid=plugin-panel-toggle]')!.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector<HTMLElement>('.plugin-panel-body')!.hidden).toBe(true);
    expect(container.querySelector('[data-testid=plugin-panel]')!.getAttribute('data-collapsed')).toBe('true');
  });
});

describe('keyboard', () => {
  it('Tab enters on one item only: the current one, or the first when there is none', () => {
    render([panel({ current: 2 })]);
    expect(items().map((b) => b.tabIndex)).toEqual([-1, -1, 0]);
    render([panel({ current: null })]);
    expect(items().map((b) => b.tabIndex)).toEqual([0, -1, -1]);
  });

  it('arrow up and down, Home and End move the focus (and stop at both ends)', () => {
    render([panel()]);
    const [a, b, c] = items() as unknown as [HTMLElement, HTMLElement, HTMLElement];
    act(() => a.focus());
    key(a, 'ArrowDown');
    expect(document.activeElement).toBe(b);
    key(b, 'ArrowDown');
    expect(document.activeElement).toBe(c);
    key(c, 'ArrowDown');
    expect(document.activeElement).toBe(c);
    key(c, 'Home');
    expect(document.activeElement).toBe(a);
    key(a, 'ArrowUp');
    expect(document.activeElement).toBe(a);
    key(a, 'End');
    expect(document.activeElement).toBe(c);
    key(c, 'ArrowUp');
    expect(document.activeElement).toBe(b);
  });

  it('the Tab stop follows the last focused item', () => {
    render([panel({ current: 0 })]);
    act(() => items()[2]!.focus());
    expect(items().map((b) => b.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('a click activates the item with its index (Enter on a button is a click)', () => {
    const { onActivate } = render([panel()]);
    act(() => items()[1]!.click());
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0]![1]).toBe(1);
    expect((onActivate.mock.calls[0]![0] as RegisteredPanel).id).toBe('outline.outline');
  });

  it('does not take keys with a modifier, and ignores keys during IME composition', () => {
    render([panel()]);
    const a = items()[0]!;
    act(() => a.focus());
    act(() => void a.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(a);
    act(() => void a.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', isComposing: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(a);
  });

  it('when the list shrinks, the Tab stop stays on a real item', () => {
    render([panel({ current: null })]);
    act(() => items()[2]!.focus());
    render([panel({ items: [{ text: 'only', depth: 0, offset: 0 }], current: null })]);
    expect(items().map((b) => b.tabIndex)).toEqual([0]);
  });
});
