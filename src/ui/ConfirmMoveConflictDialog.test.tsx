// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoveConflictInfo } from '../explorer/controller';
import { ConfirmMoveConflictDialog } from './ConfirmMoveConflictDialog';

// ADR-003 の R15: 同じ名前があるときの確認。置き換える（既存はゴミ箱へ）、両方とも残す（既定のフォーカス）、中止（Esc）。

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

const INFO: MoveConflictInfo = { name: 'a.md', destName: 'other', movingKind: 'file', existingKind: 'file', replaceBlockedReason: null };

function render(info: MoveConflictInfo = INFO) {
  const onChoose = vi.fn();
  act(() => root.render(<ConfirmMoveConflictDialog info={info} onChoose={onChoose} />));
  return onChoose;
}
const byId = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;

describe('ConfirmMoveConflictDialog', () => {
  it('names the item and the destination, and focuses "keep both" by default', () => {
    render();
    expect(container.querySelector('[data-testid=move-conflict-message]')!.textContent).toBe('“a.md” という名前の項目が “other” にすでにあります。');
    expect(container.querySelector('[role=alertdialog]')).not.toBeNull();
    expect(document.activeElement).toBe(byId('move-keep-both'));
    expect(byId('move-replace').textContent).toContain('ゴミ箱');
    expect(container.querySelector('[data-testid=move-conflict-kinds]')).toBeNull();
  });

  it('says so when the kinds differ', () => {
    render({ ...INFO, movingKind: 'folder', existingKind: 'file' });
    expect(container.querySelector('[data-testid=move-conflict-kinds]')!.textContent).toBe('移す項目はフォルダ、すでにある項目はファイルです。');
    render({ ...INFO, movingKind: 'file', existingKind: 'folder' });
    expect(container.querySelector('[data-testid=move-conflict-kinds]')!.textContent).toBe('移す項目はファイル、すでにある項目はフォルダです。');
  });

  it('each button reports its own choice, and Esc is cancel', () => {
    const onChoose = render();
    act(() => byId('move-replace').click());
    act(() => byId('move-keep-both').click());
    act(() => byId('move-cancel').click());
    expect(onChoose.mock.calls.map((c) => c[0])).toEqual(['replace', 'keep-both', 'cancel']);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => void byId('move-keep-both').dispatchEvent(esc));
    expect(onChoose).toHaveBeenLastCalledWith('cancel');
    expect(esc.defaultPrevented).toBe(true);
  });

  it('when replace is not allowed, it is aria-disabled, does nothing, and the reason is given and linked', () => {
    const reason = '開いている文書を置き換えることになるため、選べません。';
    const onChoose = render({ ...INFO, replaceBlockedReason: reason });
    const replace = byId('move-replace');
    expect(replace.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelector('[data-testid=move-replace-reason]')!.textContent).toBe(reason);
    expect(replace.getAttribute('aria-describedby')).toBe('move-replace-reason');
    act(() => replace.click());
    expect(onChoose).not.toHaveBeenCalled();
    act(() => byId('move-keep-both').click());
    expect(onChoose).toHaveBeenCalledWith('keep-both');
  });

  it('Tab goes round inside the dialog', () => {
    render();
    const buttons = [byId('move-replace'), byId('move-keep-both'), byId('move-cancel')];
    buttons[2]!.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => void buttons[2]!.dispatchEvent(forward));
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    act(() => void buttons[0]!.dispatchEvent(back));
    expect(document.activeElement).toBe(buttons[2]);
  });
});
