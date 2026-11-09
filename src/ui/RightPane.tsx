import type { ReactNode } from 'react';
import type { SidebarMode } from './sidebarLayout';

export const RIGHT_PANE_ID = 'app-right-pane';

interface Props {
  open: boolean;
  /** push: 本文の領域の右を空ける。overlay: 窓が狭いので本文の上に重ねる（閉じるボタンを出す）。 */
  mode: SidebarMode;
  onClose(): void;
  /** 部品のパネルの節（PluginPanels）。閉じているときは、ペインごと inert なので、フォーカスを受けない。 */
  children: ReactNode;
}

/**
 * 右ペイン（ADR-005 の R13）。段 2 の部品のパネル（アウトラインなど）を置く。本文の領域の右に、幅 260px で置く。
 * 閉じているときは、見えず、フォーカスも受けない（inert）。開閉は上部バーの右端のボタンか、Option+Cmd+B（Windows / Linux は Ctrl+Alt+B）。
 * 起動時は閉じている（状態は保存しない）。重ねて表示するとき（狭い窓）は、中に閉じるボタンを置く。Esc でも閉じる。
 * 配色と文字は左サイドバーにそろえる。
 */
export function RightPane({ open, mode, onClose, children }: Props) {
  return (
    <aside
      id={RIGHT_PANE_ID}
      className="right-pane"
      aria-label="パネル"
      data-testid="right-pane"
      data-open={open ? 'true' : 'false'}
      data-mode={mode}
      inert={!open}
      onKeyDown={(e) => {
        if (mode === 'overlay' && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="right-pane-inner">
        <div className="sidebar-header">
          <h2>パネル</h2>
          {mode === 'overlay' && (
            <button type="button" className="sidebar-close" data-testid="right-pane-close" aria-label="パネルを閉じる" onClick={onClose}>
              ×
            </button>
          )}
        </div>
        {children}
      </div>
    </aside>
  );
}
