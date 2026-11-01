import { useMemo } from 'react';
import { basename } from '../document/state';
import type { ExplorerController, ExplorerState } from '../explorer/controller';
import { buildTree } from '../explorer/tree';
import { FileTree } from './FileTree';
import type { SidebarMode } from './sidebarLayout';

export const SIDEBAR_ID = 'app-sidebar';

interface Props {
  open: boolean;
  /** push: 本文を押し出す。overlay: 窓が狭いので本文の上に重ねる（閉じるボタンを出す）。 */
  mode: SidebarMode;
  explorer: ExplorerController;
  explorerState: ExplorerState;
  /** 開いている文書のパス（ツリー上で強調する）。 */
  currentPath: string | null;
  onOpenFile(path: string): void;
  onClose(): void;
}

/**
 * 左サイドバー。中身はエクスプローラー（フォルダのツリー）。フォルダを選ぶまでは「フォルダを開く」ボタンだけ。
 * 閉じているときは、見えず、フォーカスも受けない（inert）。開閉は上部バーの左端のボタンか Mod+B。
 * 重ねて表示するとき（狭い窓）は、上部バーの開閉ボタンが隠れるので、中に閉じるボタンを置く。Esc でも閉じる。
 */
export function Sidebar({ open, mode, explorer, explorerState, currentPath, onOpenFile, onClose }: Props) {
  const { root, dirs, expanded } = explorerState;
  const nodes = useMemo(() => (root === null ? [] : buildTree(root, dirs, expanded)), [root, dirs, expanded]);

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
        {root === null ? (
          <div className="sidebar-empty" data-testid="sidebar-empty">
            <p>フォルダはまだ開かれていません</p>
            <button type="button" className="sidebar-button" data-testid="open-folder" onClick={() => void explorer.chooseFolder()}>
              フォルダを開く
            </button>
          </div>
        ) : (
          <>
            <div className="explorer-folder">
              <span className="explorer-folder-name" data-testid="folder-name" title={root}>
                {basename(root)}
              </span>
              <button
                type="button"
                className="sidebar-icon-button"
                data-testid="refresh-folder"
                aria-label="再読み込み"
                title="再読み込み"
                onClick={() => void explorer.refresh()}
              >
                <RefreshIcon />
              </button>
            </div>
            <button type="button" className="sidebar-button explorer-change" data-testid="change-folder" onClick={() => void explorer.chooseFolder()}>
              別のフォルダを開く
            </button>
            <div className="explorer-tree">
              <FileTree
                nodes={nodes}
                currentPath={currentPath}
                onToggle={explorer.toggle}
                onExpand={explorer.expand}
                onCollapse={explorer.collapse}
                onOpenFile={onOpenFile}
              />
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8" />
      <path d="M13.5 2.2v3h-3" />
    </svg>
  );
}
