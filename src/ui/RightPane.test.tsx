// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RIGHT_PANE_ID, RightPane } from './RightPane';

// ADR-005 の R13: 右ペイン。名前を持つ aside で、閉じている間は inert。重ねるとき（overlay）だけ、閉じるボタンと Esc。

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

function render(props: { open: boolean; mode: 'push' | 'overlay'; onClose?: () => void }) {
  const onClose = vi.fn(props.onClose);
  act(() =>
    root.render(
      <RightPane open={props.open} mode={props.mode} onClose={onClose}>
        <button type="button" data-testid="child">子</button>
      </RightPane>,
    ),
  );
  return { onClose };
}
const pane = () => container.querySelector<HTMLElement>('[data-testid=right-pane]')!;

describe('RightPane', () => {
  it('is an aside with a name and the id the toggle button points to', () => {
    render({ open: true, mode: 'push' });
    expect(pane().tagName).toBe('ASIDE');
    expect(pane().getAttribute('aria-label')).toBe('パネル');
    expect(pane().id).toBe(RIGHT_PANE_ID);
    expect(pane().dataset.open).toBe('true');
    expect(pane().hasAttribute('inert')).toBe(false);
    expect(container.querySelector('[data-testid=child]')).not.toBeNull();
  });

  it('is inert while closed (it takes no focus)', () => {
    render({ open: false, mode: 'push' });
    expect(pane().dataset.open).toBe('false');
    expect(pane().hasAttribute('inert')).toBe(true);
  });

  it('shows the close button only while overlaying, and closes with it', () => {
    render({ open: true, mode: 'push' });
    expect(container.querySelector('[data-testid=right-pane-close]')).toBeNull();
    const { onClose } = render({ open: true, mode: 'overlay' });
    const close = container.querySelector<HTMLButtonElement>('[data-testid=right-pane-close]')!;
    expect(close.getAttribute('aria-label')).toBe('パネルを閉じる');
    act(() => close.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes with Esc from inside the pane only while overlaying', () => {
    const esc = () => act(() => void container.querySelector('[data-testid=child]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    const pushed = render({ open: true, mode: 'push' });
    esc();
    expect(pushed.onClose).not.toHaveBeenCalled();
    const overlaid = render({ open: true, mode: 'overlay' });
    esc();
    expect(overlaid.onClose).toHaveBeenCalledTimes(1);
  });
});
