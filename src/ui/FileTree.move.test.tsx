// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTree, type DirState } from '../explorer/tree';
import { FileTree } from './FileTree';

// ADR-003 の R15: ツリーの切り取りと貼り付けのキー。ドラッグの動き（実際の dataTransfer を伴うもの）は tests/e2e/explorer-move.spec.ts が見る。
// クリップボードは使わない（印はアプリの中の状態）。

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
  vi.unstubAllGlobals();
});

const DIRS = new Map<string, DirState>([
  [
    '/r',
    {
      status: 'loaded',
      more: 0,
      entries: [
        { name: 'docs', path: '/r/docs', kind: 'dir' },
        { name: 'a.md', path: '/r/a.md', kind: 'file' },
      ],
    },
  ],
]);

function setup(options: { cutId?: string | null; mac?: boolean; edit?: boolean } = {}) {
  vi.stubGlobal('navigator', { platform: options.mac === false ? 'Win32' : 'MacIntel', userAgent: '' });
  const handlers = {
    onCut: vi.fn(),
    onPaste: vi.fn(),
    onCancelCut: vi.fn(),
    onMove: vi.fn(),
  };
  act(() =>
    root.render(
      <FileTree
        nodes={buildTree('/r', DIRS, new Set())}
        currentPath={null}
        selectedId={null}
        edit={
          options.edit
            ? { mode: 'rename', parentPath: '/r', targetPath: '/r/a.md', initial: 'a.md', selection: [0, 1], error: null, busy: false }
            : null
        }
        rootPath="/r"
        onSelect={() => {}}
        onToggle={() => {}}
        onExpand={() => {}}
        onCollapse={() => {}}
        onOpenFile={() => {}}
        onRename={() => {}}
        onTrash={() => {}}
        onMenuKey={() => {}}
        onEditCommit={() => {}}
        onEditCancel={() => {}}
        onEditBlur={() => {}}
        onEditChange={() => {}}
        cutId={options.cutId ?? null}
        dropDirFor={() => '/r'}
        canDrop={() => true}
        onMove={handlers.onMove}
        onCut={handlers.onCut}
        onPaste={handlers.onPaste}
        onCancelCut={handlers.onCancelCut}
      />,
    ),
  );
  return handlers;
}

const row = (id: string) => container.querySelector<HTMLElement>(`[role=treeitem][data-row-id="${id}"]`)!;

function key(target: Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => void target.dispatchEvent(event));
  return event;
}

describe('cut and paste keys', () => {
  it('Cmd+X (macOS) cuts the row that has the focus, and prevents the default (so nothing reaches the real clipboard)', () => {
    const h = setup({ mac: true });
    const event = key(row('/r/a.md'), { key: 'x', metaKey: true });
    expect(h.onCut).toHaveBeenCalledWith('/r/a.md');
    expect(event.defaultPrevented).toBe(true);
  });

  it('Ctrl+X (other platforms) cuts, and Cmd+X there does not; on macOS Ctrl+X does not', () => {
    const win = setup({ mac: false });
    expect(key(row('/r/a.md'), { key: 'x', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(win.onCut).toHaveBeenCalledWith('/r/a.md');
    expect(key(row('/r/a.md'), { key: 'x', metaKey: true }).defaultPrevented).toBe(false);
    expect(win.onCut).toHaveBeenCalledTimes(1);

    const mac = setup({ mac: true });
    expect(key(row('/r/a.md'), { key: 'x', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(mac.onCut).not.toHaveBeenCalled();
  });

  it('Mod+V pastes at the row only while an item is cut; without a mark it is left alone', () => {
    const marked = setup({ mac: true, cutId: '/r/a.md' });
    const event = key(row('/r/docs'), { key: 'v', metaKey: true });
    expect(marked.onPaste).toHaveBeenCalledWith('/r/docs');
    expect(event.defaultPrevented).toBe(true);

    const bare = setup({ mac: true, cutId: null });
    expect(key(row('/r/docs'), { key: 'v', metaKey: true }).defaultPrevented).toBe(false);
    expect(bare.onPaste).not.toHaveBeenCalled();
  });

  it('ignores other modifier combinations (Shift, Alt) and other keys', () => {
    const h = setup({ mac: true, cutId: '/r/a.md' });
    key(row('/r/a.md'), { key: 'x', metaKey: true, shiftKey: true });
    key(row('/r/a.md'), { key: 'x', metaKey: true, altKey: true });
    key(row('/r/a.md'), { key: 'c', metaKey: true });
    key(row('/r/a.md'), { key: 'v', metaKey: true, altKey: true });
    expect(h.onCut).not.toHaveBeenCalled();
    expect(h.onPaste).not.toHaveBeenCalled();
  });

  it('does not act during IME composition', () => {
    const h = setup({ mac: true, cutId: '/r/a.md' });
    const event = key(row('/r/a.md'), { key: 'x', metaKey: true, isComposing: true });
    expect(h.onCut).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves the keys inside the name input alone (the text is cut and pasted as it is)', () => {
    const h = setup({ mac: true, cutId: '/r/docs', edit: true });
    const input = container.querySelector('input')!;
    expect(input).not.toBeNull();
    for (const k of ['x', 'v']) {
      const event = key(input, { key: k, metaKey: true });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(h.onCut).not.toHaveBeenCalled();
    expect(h.onPaste).not.toHaveBeenCalled();
  });

  it('Esc removes the mark (and does not bubble), and does nothing without a mark', () => {
    const h = setup({ cutId: '/r/a.md' });
    const bubbled = vi.fn();
    // React は native のイベントの伝播を、root（container）より外へは止める。
    document.body.addEventListener('keydown', bubbled);
    const event = key(row('/r/a.md'), { key: 'Escape' });
    expect(h.onCancelCut).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', bubbled);

    const bare = setup({ cutId: null });
    key(row('/r/a.md'), { key: 'Escape' });
    expect(bare.onCancelCut).not.toHaveBeenCalled();
  });

  it('shows the mark in the name and in data-cut, only for the cut row', () => {
    setup({ cutId: '/r/a.md' });
    expect(row('/r/a.md').getAttribute('aria-label')).toBe('a.md（切り取り済み）');
    expect(row('/r/a.md').dataset.cut).toBe('true');
    expect(row('/r/docs').getAttribute('aria-label')).toBe('docs');
    expect(row('/r/docs').dataset.cut).toBeUndefined();
  });

  it('a cut or paste event that reaches a row (not through the keys) is the same operation (the clipboard itself is never touched: see architecture.move.test.ts)', () => {
    const h = setup({ cutId: '/r/a.md' });
    const cut = new Event('cut', { bubbles: true, cancelable: true });
    act(() => void row('/r/docs').dispatchEvent(cut));
    expect(h.onCut).toHaveBeenCalledWith('/r/docs');
    expect(cut.defaultPrevented).toBe(true);
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    act(() => void row('/r/docs').dispatchEvent(paste));
    expect(h.onPaste).toHaveBeenCalledWith('/r/docs');
  });
});

describe('draggable rows', () => {
  it('file and folder rows are draggable; a row being renamed is not', () => {
    setup();
    expect(row('/r/a.md').getAttribute('draggable')).toBe('true');
    expect(row('/r/docs').getAttribute('draggable')).toBe('true');
    setup({ edit: true });
    expect(row('/r/a.md').getAttribute('draggable')).toBe('false');
    expect(row('/r/docs').getAttribute('draggable')).toBe('true');
  });
});
