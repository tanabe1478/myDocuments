import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { InlineEdit } from '../explorer/controller';
import { isSameOrInside } from '../explorer/names';
import { TREE_KEYS, flattenRows, navigate, type TreeAction, type TreeKey, type TreeNode, type TreeRow } from '../explorer/tree';
import { NameInput } from './NameInput';
import { isMacPlatform } from './shortcuts';

interface Props {
  nodes: readonly TreeNode[];
  /** 開いている文書のパス（ツリー上で強調する）。 */
  currentPath: string | null;
  /** 選択（キーボードの位置）している項目。Tab で入る項目でもある。 */
  selectedId: string | null;
  edit: InlineEdit | null;
  /** ルートのフォルダのパス（ルート直下に作るときの入力欄の位置）。 */
  rootPath: string;
  onSelect(id: string): void;
  onToggle(path: string): void;
  onExpand(path: string): void;
  onCollapse(path: string): void;
  onOpenFile(path: string): void;
  onRename(path: string): void;
  onTrash(path: string): void;
  /** キーボード（Shift+F10、メニューキー）で、項目のメニューを開く。座標は項目の行の位置。 */
  onMenuKey(path: string, x: number, y: number): void;
  onEditCommit(value: string): void;
  onEditCancel(): void;
  onEditBlur(value: string): void;
  onEditChange(): void;
  /** 切り取りの印が付いている項目。 */
  cutId: string | null;
  /** 行（null は空いている所）の、落とす・貼り付ける先のフォルダ。なければ null。 */
  dropDirFor(rowId: string | null): string | null;
  /** ドラッグ中の項目 path を、行（null は空いている所）に落とせるか。 */
  canDrop(path: string, rowId: string | null): boolean;
  /** ドラッグした項目 path を、行（null は空いている所）に落とした。 */
  onMove(path: string, rowId: string | null): void;
  /** 切り取りの印を付ける（⌘X / Ctrl+X）。 */
  onCut(path: string): void;
  /** 印の付いた項目を、行の場所へ貼り付ける（⌘V / Ctrl+V）。 */
  onPaste(rowId: string): void;
  /** 切り取りの印を外す（Esc）。 */
  onCancelCut(): void;
}

/** ドラッグ中であることの印（ツリーの中でだけ意味を持つ）。パスや名前は入れない。 */
const DRAG_TYPE = 'application/x-mde-tree-item';
/** 閉じたフォルダの上で止まったときに開くまでの時間。 */
const HOVER_OPEN_MS = 700;
/** ツリーの上下の端から、この距離（px）に入ると、ドラッグ中にスクロールする。 */
const SCROLL_EDGE_PX = 28;
const SCROLL_MAX_SPEED = 14;

/**
 * フォルダのツリー（WAI-ARIA の tree パターン）。role=tree / treeitem / group、aria-level、aria-expanded、
 * roving tabindex（Tab で入る項目は 1 つだけ。中は矢印キー）。操作の判断は explorer/tree.ts の navigate。
 * 開けないファイルとフォルダへのリンクは aria-disabled で、クリックや Enter では何も起きない。
 * F2 で名前の変更、Delete（macOS は ⌘⌫ も）でゴミ箱へ。作成と名前の変更の入力欄は、ツリーの中に出す。
 */
export function FileTree({
  nodes,
  currentPath,
  selectedId,
  edit,
  rootPath,
  onSelect,
  onToggle,
  onExpand,
  onCollapse,
  onOpenFile,
  onRename,
  onTrash,
  onMenuKey,
  onEditCommit,
  onEditCancel,
  onEditBlur,
  onEditChange,
  cutId,
  dropDirFor,
  canDrop,
  onMove,
  onCut,
  onPaste,
  onCancelCut,
}: Props) {
  const rows = flattenRows(nodes);
  const items = useRef(new Map<string, HTMLElement>());
  // Tab で入る項目。記録した項目がなくなった（折りたたんだ、再読み込みで消えた）ときは先頭。
  const tabId = rows.some((r) => r.id === selectedId) ? selectedId : (rows[0]?.id ?? null);

  // 入力欄が閉じた後、フォーカスがどこにも残っていなければ、選択している項目へ戻す（取り消し、確定の後）。
  // 確定の直後は、新しい項目がまだ一覧にないことがあるので、現れるまで（次の描画で）待つ。
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (edit) {
      restoreFocus.current = true;
      return;
    }
    if (!restoreFocus.current) return;
    const active = document.activeElement;
    if (active && active !== document.body) {
      restoreFocus.current = false;
      return;
    }
    // 何も選んでいなければ、戻さない（先頭の項目へ移すと、それが選択になり、作成先が変わってしまう）。
    if (selectedId === null) {
      restoreFocus.current = false;
    } else if (items.current.has(selectedId)) {
      restoreFocus.current = false;
      items.current.get(selectedId)?.focus();
    }
  });

  // ---- ドラッグアンドドロップ（ツリーの中の項目を、別のフォルダへ） ----
  // ドラッグ中の項目は、ツリーの中の状態（ここ）で持つ。dataTransfer には、パスも名前も入れない（外へ漏れても困らない印だけ）。
  // 外（Finder など）から落とされたものは受け付けない（この状態がないドラッグは、すべて dropEffect none）。
  const [dragging, setDragging] = useState<string | null>(null);
  const draggingRef = useRef<string | null>(null);
  /** 落とせる先のフォルダ。ルートなら rootPath。落とせない（または何も指していない）なら null。 */
  const [dropDir, setDropDir] = useState<string | null>(null);
  const hover = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const scrollSpeed = useRef(0);
  const scrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const treeEl = useRef<HTMLUListElement>(null);

  const clearHover = () => {
    if (hover.current) clearTimeout(hover.current.timer);
    hover.current = null;
  };
  const stopDrag = () => {
    draggingRef.current = null;
    setDragging(null);
    setDropDir(null);
    clearHover();
    scrollSpeed.current = 0;
    if (scrollTimer.current !== null) clearInterval(scrollTimer.current);
    scrollTimer.current = null;
  };
  // 外れるときは、残っているタイマーだけを止める。
  useEffect(
    () => () => {
      if (hover.current) clearTimeout(hover.current.timer);
      if (scrollTimer.current !== null) clearInterval(scrollTimer.current);
    },
    [],
  );

  const rowIdAt = (target: EventTarget | null): string | null => {
    const el = target instanceof Element ? target.closest<HTMLElement>('[data-row-id]') : null;
    return el?.dataset.rowId ?? null;
  };

  const onDragStart = (e: DragEvent<HTMLUListElement>) => {
    const id = rowIdAt(e.target);
    const row = id === null ? undefined : rows.find((r) => r.id === id);
    // 名前の入力欄が開いている間は、行を引かない（入力欄の中の文字の選択が、行のドラッグにならないように）。
    if (!row?.entry || edit !== null) {
      e.preventDefault();
      return;
    }
    draggingRef.current = row.id;
    setDragging(row.id);
    e.dataTransfer.setData(DRAG_TYPE, 'move');
    e.dataTransfer.effectAllowed = 'move';
    // 展開したフォルダを引くとき、中身ごとの画像にならないよう、行だけを見せる。
    const rowEl = e.currentTarget.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(row.id)}"] > .tree-row`);
    if (rowEl) e.dataTransfer.setDragImage(rowEl, 12, 12);
    // 上下の端に近づいたときのスクロール。動きは位置で決まり、ポインタが止まっても続く。
    scrollTimer.current = setInterval(() => {
      const area = treeEl.current?.parentElement;
      if (area && scrollSpeed.current !== 0) area.scrollTop += scrollSpeed.current;
    }, 16);
  };

  const onDragOver = (e: DragEvent<HTMLUListElement>) => {
    const path = draggingRef.current;
    if (path === null || !e.dataTransfer.types.includes(DRAG_TYPE)) {
      // 外から来たもの。受け付けない。
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    const id = rowIdAt(e.target);
    const allowed = canDrop(path, id);
    const dest = allowed ? dropDirFor(id) : null;
    setDropDir((current) => (current === dest ? current : dest));
    e.dataTransfer.dropEffect = allowed ? 'move' : 'none';
    if (allowed) e.preventDefault();

    // 閉じたフォルダの上で止まると開く（動かした項目自身と、その中のフォルダは開かない）。
    const row = id === null ? undefined : rows.find((r) => r.id === id);
    const openable = row?.entry !== undefined && row.expandable && !row.expanded && !isSameOrInside(row.id, path);
    if (!openable || !row) {
      clearHover();
    } else if (hover.current?.id !== row.id) {
      clearHover();
      const target = row.id;
      const timer = setTimeout(() => {
        hover.current = null;
        onExpand(target);
      }, HOVER_OPEN_MS);
      hover.current = { id: target, timer };
    }

    // 上下の端に近づくとスクロールする。
    const area = treeEl.current?.parentElement;
    if (area) {
      const rect = area.getBoundingClientRect();
      const fromTop = e.clientY - rect.top;
      const fromBottom = rect.bottom - e.clientY;
      scrollSpeed.current =
        fromTop < SCROLL_EDGE_PX
          ? -Math.ceil(((SCROLL_EDGE_PX - Math.max(fromTop, 0)) / SCROLL_EDGE_PX) * SCROLL_MAX_SPEED)
          : fromBottom < SCROLL_EDGE_PX
            ? Math.ceil(((SCROLL_EDGE_PX - Math.max(fromBottom, 0)) / SCROLL_EDGE_PX) * SCROLL_MAX_SPEED)
            : 0;
    }
  };

  const onDragLeave = (e: DragEvent<HTMLUListElement>) => {
    // ツリーの外へ出たとき（中の行から行への移動では、消さない）。
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setDropDir(null);
    clearHover();
    scrollSpeed.current = 0;
  };

  const onDrop = (e: DragEvent<HTMLUListElement>) => {
    const path = draggingRef.current;
    if (path === null) return;
    const id = rowIdAt(e.target);
    const allowed = canDrop(path, id);
    if (allowed) e.preventDefault();
    stopDrag();
    if (allowed) onMove(path, id);
  };

  const run = (row: TreeRow, action: TreeAction) => {
    const path = row.entry?.path;
    if (path === undefined) return;
    if (action === 'expand') onExpand(path);
    else if (action === 'collapse') onCollapse(path);
    else if (action === 'toggle') onToggle(path);
    else if (action === 'open') onOpenFile(path);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.nativeEvent.isComposing) return;
    // 項目そのものにフォーカスがあるときだけ扱う（中の入力欄などのキーは奪わない）。
    const target = e.target instanceof HTMLElement ? e.target : null;
    const id = target?.dataset.rowId;
    if (id === undefined) return;
    const row = rows.find((r) => r.id === id);
    const noModifier = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;

    // 切り取りと貼り付け。macOS は ⌘X / ⌘V、ほかは Ctrl+X / Ctrl+V。OS のクリップボードには触れない（印はアプリの中の状態）。
    // 項目の行にフォーカスがあるときだけ（名前の入力欄の中のキーは、上の id の判定で除かれ、文字の切り取りと貼り付けのまま）。
    const mod = isMacPlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (mod && !e.altKey && !e.shiftKey) {
      const key = e.key.toLowerCase();
      if (key === 'x' && row?.entry) {
        e.preventDefault();
        onCut(row.id);
        return;
      }
      if (key === 'v' && row && cutId !== null) {
        e.preventDefault();
        onPaste(row.id);
        return;
      }
    }
    if (e.key === 'Escape' && noModifier && cutId !== null) {
      e.preventDefault();
      e.stopPropagation();
      onCancelCut();
      return;
    }

    // 項目の操作。補足の行（entry がない）には効かせない。
    if (row?.entry) {
      if (e.key === 'F2' && noModifier) {
        e.preventDefault();
        onRename(row.id);
        return;
      }
      const macTrash = isMacPlatform() && e.key === 'Backspace' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      if ((e.key === 'Delete' && noModifier) || macTrash) {
        e.preventDefault();
        onTrash(row.id);
        return;
      }
    }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      e.preventDefault();
      const rect = target?.querySelector('.tree-row')?.getBoundingClientRect();
      onMenuKey(id, (rect?.left ?? 0) + 24, (rect?.bottom ?? 0) - 4);
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey || !TREE_KEYS.includes(e.key)) return;
    const result = navigate(rows, id, e.key as TreeKey);
    if (!result) return;
    e.preventDefault();
    if (result.focusId !== id) {
      onSelect(result.focusId);
      items.current.get(result.focusId)?.focus();
    }
    const next = rows.find((r) => r.id === result.focusId);
    if (next && result.action) run(next, result.action);
  };

  /**
   * ブラウザやメニューの「切り取り」「貼り付け」が、キーを経由せずに届いたとき（keydown が奪われなかったとき）の備え。
   * 項目の行にフォーカスがあるときだけ、ツリーの操作にする。クリップボードの中身は読まず、書かない。
   */
  const onClipboardEvent = (e: ClipboardEvent<HTMLUListElement>) => {
    const id = e.target instanceof HTMLElement ? e.target.dataset.rowId : undefined;
    if (id === undefined) return;
    const row = rows.find((r) => r.id === id);
    if (e.type === 'cut' && row?.entry) {
      e.preventDefault();
      onCut(row.id);
    } else if (e.type === 'paste' && row && cutId !== null) {
      e.preventDefault();
      onPaste(row.id);
    }
  };

  const input = (label: string, level: number, mode: InlineEdit['mode'], current: InlineEdit) => (
    <NameInput
      initial={current.initial}
      selection={current.selection}
      error={current.error}
      busy={current.busy}
      ariaLabel={label}
      onCommit={onEditCommit}
      onCancel={onEditCancel}
      onBlurValue={onEditBlur}
      onChange={onEditChange}
      key={`${mode}:${current.parentPath}:${current.targetPath ?? ''}:${level}`}
    />
  );

  /** 作成の入力欄の行（作成先のフォルダの最初の子として出す）。 */
  const createRow = (level: number) => {
    if (!edit || edit.mode === 'rename') return null;
    return (
      <li key="tree-create-row" role="none" className="tree-edit-row" data-testid="tree-edit-row">
        <div className="tree-row" style={{ paddingLeft: `${6 + (level - 1) * 14}px` }}>
          <span className="tree-twisty" aria-hidden="true" />
          <span className="tree-icon" aria-hidden="true">
            {edit.mode === 'create-folder' ? <FolderIcon /> : <FileIcon />}
          </span>
          <div className="tree-name-field">
            {input(edit.mode === 'create-folder' ? '新しいフォルダの名前' : '新しいファイルの名前', level, edit.mode, edit)}
          </div>
        </div>
      </li>
    );
  };

  const render = (node: TreeNode) => {
    const { row } = node;
    const current = row.entry !== undefined && row.kind === 'file' && row.entry.path === currentPath;
    const disabled = !row.expandable && !row.openable;
    const renaming = edit?.mode === 'rename' && row.entry !== undefined && edit.targetPath === row.entry.path;
    const createHere = edit !== null && edit.mode !== 'rename' && row.entry !== undefined && edit.parentPath === row.entry.path;
    const hint =
      row.kind === 'symlinkDir'
        ? `${row.label}（フォルダへのリンク。開きません）`
        : row.kind === 'file' && !row.openable
          ? `${row.label}（開けない形式です）`
          : row.label;
    const cut = row.entry !== undefined && row.id === cutId;
    const dropTarget = row.kind === 'dir' && row.entry !== undefined && row.id === dropDir && dropDir !== rootPath;
    const click = () => {
      onSelect(row.id);
      items.current.get(row.id)?.focus();
      if (row.expandable && row.entry) onToggle(row.entry.path);
      else if (row.openable && row.entry) onOpenFile(row.entry.path);
    };
    return (
      <li
        key={row.id}
        ref={(el) => {
          if (el) items.current.set(row.id, el);
          else items.current.delete(row.id);
        }}
        role="treeitem"
        className="tree-item"
        data-testid={row.kind === 'note' ? 'tree-note' : 'tree-item'}
        data-row-id={row.id}
        data-kind={row.kind}
        data-path={row.entry?.path}
        data-selected={row.id === selectedId ? 'true' : undefined}
        tabIndex={row.id === tabId ? 0 : -1}
        aria-level={row.level}
        aria-label={(row.kind === 'symlinkDir' ? `${row.label}（リンク）` : row.label) + (cut ? '（切り取り済み）' : '')}
        aria-expanded={row.expandable ? row.expanded : undefined}
        aria-disabled={disabled ? true : undefined}
        aria-current={current ? 'true' : undefined}
        draggable={row.entry !== undefined && !renaming}
        data-cut={cut ? 'true' : undefined}
        data-dragging={row.id === dragging ? 'true' : undefined}
        data-drop-target={dropTarget ? 'true' : undefined}
      >
        <div
          className="tree-row"
          title={row.kind === 'note' || renaming ? undefined : hint}
          style={{ paddingLeft: `${6 + (row.level - 1) * 14}px` }}
          onClick={row.kind === 'note' || renaming ? undefined : click}
        >
          <span className="tree-twisty" aria-hidden="true">
            {row.expandable ? <Chevron expanded={row.expanded} /> : null}
          </span>
          {row.kind !== 'note' && (
            <span className="tree-icon" aria-hidden="true">
              {row.kind === 'dir' || row.kind === 'symlinkDir' ? <FolderIcon /> : <FileIcon />}
            </span>
          )}
          {renaming && edit ? (
            <div className="tree-name-field">{input(`「${row.label}」の新しい名前`, row.level, edit.mode, edit)}</div>
          ) : (
            <span className="tree-name">{row.label}</span>
          )}
          {row.kind === 'symlinkDir' && !renaming && (
            <span className="tree-badge" aria-hidden="true">
              ↪
            </span>
          )}
        </div>
        {(node.children.length > 0 || createHere) && (
          <ul role="group" className="tree-group">
            {createHere && createRow(row.level + 1)}
            {node.children.map(render)}
          </ul>
        )}
      </li>
    );
  };

  return (
    <ul
      ref={treeEl}
      role="tree"
      aria-label="フォルダのツリー"
      className="file-tree"
      data-testid="file-tree"
      data-drop-root={dropDir !== null && dropDir === rootPath ? 'true' : undefined}
      data-dragging={dragging !== null ? 'true' : undefined}
      onKeyDown={onKeyDown}
      onCut={onClipboardEvent}
      onPaste={onClipboardEvent}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={stopDrag}
      // フォーカスのある項目が、選択（作成先、F2、Delete の対象）。
      onFocus={(e) => {
        const id = e.target instanceof HTMLElement ? e.target.dataset.rowId : undefined;
        if (id !== undefined) onSelect(id);
      }}
    >
      {edit !== null && edit.mode !== 'rename' && edit.parentPath === rootPath && createRow(1)}
      {nodes.map(render)}
    </ul>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="tree-chevron" data-expanded={expanded}>
      <path d="M3 1.5 L6.5 5 L3 8.5" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.6H13c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d="M3.5 1.8h5.3l3.7 3.7v8.2c0 .3-.2.5-.5.5H3.5c-.3 0-.5-.2-.5-.5V2.3c0-.3.2-.5.5-.5z" />
      <path d="M8.6 1.9v3.8h3.7" />
    </svg>
  );
}
