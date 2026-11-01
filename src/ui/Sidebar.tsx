import type { SidebarMode } from './sidebarLayout';

export const SIDEBAR_ID = 'app-sidebar';

interface Props {
  open: boolean;
  /** push: 本文を押し出す。overlay: 窓が狭いので本文の上に重ねる（閉じるボタンを出す）。 */
  mode: SidebarMode;
  onClose(): void;
}

/**
 * 左サイドバーの枠。いまは中身がない（空の状態の表示だけ）。フォルダのツリーは次の Run で入れる。
 * 閉じているときは、見えず、フォーカスも受けない（inert）。開閉は上部バーの左端のボタンか Mod+B。
 * 重ねて表示するとき（狭い窓）は、上部バーの開閉ボタンが隠れるので、中に閉じるボタンを置く。Esc でも閉じる。
 */
export function Sidebar({ open, mode, onClose }: Props) {
  return (
    <aside
      id={SIDEBAR_ID}
      className="sidebar"
      aria-label="サイドバー"
      data-testid="sidebar"
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
      <div className="sidebar-inner">
        <div className="sidebar-header">
          <h2>エクスプローラー</h2>
          {mode === 'overlay' && (
            <button type="button" className="sidebar-close" data-testid="sidebar-close" aria-label="サイドバーを閉じる" onClick={onClose}>
              ×
            </button>
          )}
        </div>
        <p className="sidebar-empty" data-testid="sidebar-empty">
          フォルダはまだ開かれていません
        </p>
      </div>
    </aside>
  );
}
