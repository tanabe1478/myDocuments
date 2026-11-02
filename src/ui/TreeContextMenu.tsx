import { useEffect, useRef } from 'react';

export interface MenuItem {
  readonly id: 'new-file' | 'new-folder' | 'rename' | 'trash';
  readonly label: string;
}

interface Props {
  x: number;
  y: number;
  items: readonly MenuItem[];
  onChoose(id: MenuItem['id']): void;
  /** 閉じる（Esc、外のクリック、項目の選択の後）。 */
  onClose(): void;
}

/**
 * ツリーの右クリックメニュー（role=menu / menuitem）。開くと最初の項目にフォーカスし、上下・Home・End で移動、
 * Enter で実行、Esc で閉じる。外を押しても閉じる。
 */
export function TreeContextMenu({ x, y, items, onChoose, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    const focus = (i: number) => buttons[(i + buttons.length) % buttons.length]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focus(at + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focus(at < 0 ? -1 : at - 1);
        break;
      case 'Home':
        e.preventDefault();
        focus(0);
        break;
      case 'End':
        e.preventDefault();
        focus(-1);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
      case 'Tab':
        e.preventDefault();
        onClose();
        break;
    }
  };

  // 窓の外へはみ出さない位置にする。
  const left = Math.max(4, Math.min(x, window.innerWidth - 190));
  const top = Math.max(4, Math.min(y, window.innerHeight - 8 - items.length * 30));

  return (
    <div
      ref={ref}
      className="tree-context-menu"
      role="menu"
      aria-label="ツリーの操作"
      data-testid="tree-context-menu"
      style={{ left, top }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="tree-context-item"
          data-testid={`menu-${item.id}`}
          tabIndex={-1}
          onClick={() => onChoose(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
