import { useCallback, useMemo, useRef, useState, type MouseEvent } from 'react';
import { basename } from '../document/state';
import type { ExplorerController, ExplorerState } from '../explorer/controller';
import { buildTree } from '../explorer/tree';
import { FileTree } from './FileTree';
import type { SidebarMode } from './sidebarLayout';
import type { MenuTarget, RegisteredMenuItem } from '../plugin-api';
import { TreeContextMenu, type MenuItem } from './TreeContextMenu';

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
  /** 部品（段 2）が、ツリーの右クリックに足した項目。ファイルとフォルダの行のメニューに、本体の項目のあと、区切りを入れて並ぶ。 */
  pluginMenuItems?: readonly RegisteredMenuItem[];
}

/** 右クリックメニューの対象。path が null なら、ツリーの空き領域（作成先はルート）。 */
interface MenuState {
  readonly x: number;
  readonly y: number;
  readonly path: string | null;
  /** メニューを閉じた後に、フォーカスを戻す先。 */
  readonly origin: HTMLElement | null;
}

const CREATE_ITEMS: readonly MenuItem[] = [
  { id: 'new-file', label: '新しいファイル' },
  { id: 'new-folder', label: '新しいフォルダ' },
];
const ITEM_ITEMS: readonly MenuItem[] = [
  ...CREATE_ITEMS,
  { id: 'rename', label: '名前を変更' },
  { id: 'trash', label: 'ゴミ箱に移動' },
];

/**
 * 左サイドバー。中身はエクスプローラー（フォルダのツリー）。フォルダを選ぶまでは「フォルダを開く」ボタンだけ
 * （前回のフォルダを開けなかったときは、その旨と「再試行」も）。
 * 閉じているときは、見えず、フォーカスも受けない（inert）。開閉は上部バーの左端のボタンか Mod+B。
 * 重ねて表示するとき（狭い窓）は、上部バーの開閉ボタンが隠れるので、中に閉じるボタンを置く。Esc でも閉じる。
 * 見出しの「新しいファイル」「新しいフォルダ」と、ツリーの右クリックメニューから、作成・名前の変更・ゴミ箱への移動ができる。
 */
export function Sidebar({ open, mode, explorer, explorerState, currentPath, onOpenFile, onClose, pluginMenuItems = [] }: Props) {
  const { root, dirs, expanded, selected, edit, restoreFailure } = explorerState;
  const nodes = useMemo(() => (root === null ? [] : buildTree(root, dirs, expanded)), [root, dirs, expanded]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const treeAreaRef = useRef<HTMLDivElement>(null);

  /** フォーカスがどこにも残っていないとき、ツリーの Tab で入る項目へ戻す（ダイアログを閉じた後など）。 */
  const refocusTree = useCallback(() => {
    const active = document.activeElement;
    if (!active || active === document.body) treeAreaRef.current?.querySelector<HTMLElement>('[role=treeitem][tabindex="0"]')?.focus();
  }, []);

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenu((m) => {
      if (restoreFocus && m?.origin?.isConnected) m.origin.focus();
      return null;
    });
  }, []);

  const openMenu = (path: string | null, x: number, y: number) => {
    const active = document.activeElement;
    setMenu({ x, y, path, origin: active instanceof HTMLElement && active !== document.body ? active : null });
  };

  const onTreeContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rowEl = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-row-id]') : null;
    const path = rowEl?.dataset.kind !== 'note' ? (rowEl?.dataset.rowId ?? null) : null;
    explorer.select(path);
    openMenu(path, e.clientX, e.clientY);
  };

  /** 行のパスが、部品に渡せる対象（ファイルかフォルダ。補足の行、壊れたリンクなどは対象にしない）か。 */
  const targetOf = (path: string | null): MenuTarget | null => {
    const row = path === null ? undefined : nodes.find((n) => n.row.id === path)?.row;
    if (!row || path === null) return null;
    return row.kind === 'file' ? { path, kind: 'file' } : row.kind === 'dir' || row.kind === 'symlinkDir' ? { path, kind: 'folder' } : null;
  };
  const menuTarget = menu ? targetOf(menu.path) : null;
  const visiblePluginItems = menuTarget ? pluginMenuItems.filter((i) => i.where === 'tree') : [];

  const choosePlugin = (id: string) => {
    const item = visiblePluginItems.find((i) => i.id === id);
    const origin = menu?.origin;
    setMenu(null);
    // 権限の確認の画面が出ても、閉じたあとに行へ戻れるよう、先にフォーカスを戻す。
    if (origin?.isConnected) origin.focus();
    if (item && menuTarget) void item.run(menuTarget);
  };

  const choose = (id: MenuItem['id']) => {
    const path = menu?.path ?? null;
    setMenu(null);
    if (id === 'new-file') explorer.beginCreate('file');
    else if (id === 'new-folder') explorer.beginCreate('folder');
    else if (id === 'rename' && path !== null) explorer.beginRename(path);
    else if (id === 'trash' && path !== null) void explorer.requestTrash(path).then(refocusTree);
  };

  const trash = (path: string) => void explorer.requestTrash(path).then(refocusTree);

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
            {restoreFailure ? (
              <p data-testid="restore-failure" role="status">
                前回のフォルダ「{basename(restoreFailure.path)}」を開けませんでした（{restoreFailure.message.replace(/。$/, '')}）
              </p>
            ) : (
              <p>フォルダはまだ開かれていません</p>
            )}
            <div className="sidebar-empty-actions">
              {restoreFailure && (
                <button type="button" className="sidebar-button" data-testid="retry-folder" onClick={() => void explorer.retryRestore()}>
                  再試行
                </button>
              )}
              <button type="button" className="sidebar-button" data-testid="open-folder" onClick={() => void explorer.chooseFolder()}>
                フォルダを開く
              </button>
            </div>
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
                data-testid="new-file"
                aria-label="新しいファイル"
                title="新しいファイル"
                onClick={() => explorer.beginCreate('file')}
              >
                <NewFileIcon />
              </button>
              <button
                type="button"
                className="sidebar-icon-button"
                data-testid="new-folder"
                aria-label="新しいフォルダ"
                title="新しいフォルダ"
                onClick={() => explorer.beginCreate('folder')}
              >
                <NewFolderIcon />
              </button>
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
            <div
              ref={treeAreaRef}
              className="explorer-tree"
              data-testid="explorer-tree-area"
              onContextMenu={onTreeContextMenu}
              onClick={(e) => {
                // 空き領域を押すと、選択を外す（作成先がルートになる）。
                if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.testid === 'file-tree') explorer.select(null);
              }}
            >
              <FileTree
                nodes={nodes}
                currentPath={currentPath}
                selectedId={selected}
                edit={edit}
                rootPath={root}
                onSelect={explorer.select}
                onToggle={explorer.toggle}
                onExpand={explorer.expand}
                onCollapse={explorer.collapse}
                onOpenFile={onOpenFile}
                onRename={explorer.beginRename}
                onTrash={trash}
                onMenuKey={(path, x, y) => {
                  explorer.select(path);
                  openMenu(path, x, y);
                }}
                onEditCommit={(value) => void explorer.commitEdit(value)}
                onEditCancel={explorer.cancelEdit}
                // フォーカスが外れたとき: 空なら取り消し、そうでなければ確定を試みる（拒否されたら入力欄を残して理由を出す）。
                onEditBlur={(value) => (value.trim() === '' ? explorer.cancelEdit() : void explorer.commitEdit(value))}
                onEditChange={explorer.clearEditError}
              />
            </div>
          </>
        )}
      </div>
      {menu && (
        <TreeContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.path === null ? CREATE_ITEMS : ITEM_ITEMS}
          pluginItems={visiblePluginItems.map((i) => ({ id: i.id, label: i.title }))}
          onChoose={choose}
          onChoosePlugin={choosePlugin}
          onClose={() => closeMenu(true)}
        />
      )}
    </aside>
  );
}

function NewFileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 1.8H3.5c-.3 0-.5.2-.5.5v11.4c0 .3.2.5.5.5h9c.3 0 .5-.2.5-.5V5.8z" />
      <path d="M8.8 1.9v4h4" />
      <path d="M8 8.2v3.6M6.2 10h3.6" />
    </svg>
  );
}

function NewFolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6H13c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" />
      <path d="M8 7v3.6M6.2 8.8h3.6" />
    </svg>
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
