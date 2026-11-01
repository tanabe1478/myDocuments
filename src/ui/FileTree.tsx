import { useRef, useState, type KeyboardEvent } from 'react';
import { TREE_KEYS, flattenRows, navigate, type TreeAction, type TreeKey, type TreeNode, type TreeRow } from '../explorer/tree';

interface Props {
  nodes: readonly TreeNode[];
  /** 開いている文書のパス（ツリー上で強調する）。 */
  currentPath: string | null;
  onToggle(path: string): void;
  onExpand(path: string): void;
  onCollapse(path: string): void;
  onOpenFile(path: string): void;
}

/**
 * フォルダのツリー（WAI-ARIA の tree パターン）。role=tree / treeitem / group、aria-level、aria-expanded、
 * roving tabindex（Tab で入る項目は 1 つだけ。中は矢印キー）。操作の判断は explorer/tree.ts の navigate。
 * 開けないファイルとフォルダへのリンクは aria-disabled で、クリックや Enter では何も起きない。
 */
export function FileTree({ nodes, currentPath, onToggle, onExpand, onCollapse, onOpenFile }: Props) {
  const rows = flattenRows(nodes);
  const [activeId, setActiveId] = useState<string | null>(null);
  const items = useRef(new Map<string, HTMLElement>());
  // Tab で入る項目。記録した項目がなくなった（折りたたんだ、再読み込みで消えた）ときは先頭。
  const tabId = rows.some((r) => r.id === activeId) ? activeId : (rows[0]?.id ?? null);

  const run = (row: TreeRow, action: TreeAction) => {
    const path = row.entry?.path;
    if (path === undefined) return;
    if (action === 'expand') onExpand(path);
    else if (action === 'collapse') onCollapse(path);
    else if (action === 'toggle') onToggle(path);
    else if (action === 'open') onOpenFile(path);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey || !TREE_KEYS.includes(e.key)) return;
    // 項目そのものにフォーカスがあるときだけ扱う（中の入力欄などのキーは奪わない）。
    const target = e.target instanceof HTMLElement ? e.target : null;
    const id = target?.dataset.rowId;
    if (id === undefined) return;
    const result = navigate(rows, id, e.key as TreeKey);
    if (!result) return;
    e.preventDefault();
    if (result.focusId !== id) {
      setActiveId(result.focusId);
      items.current.get(result.focusId)?.focus();
    }
    const row = rows.find((r) => r.id === result.focusId);
    if (row && result.action) run(row, result.action);
  };

  const render = (node: TreeNode) => {
    const { row } = node;
    const current = row.entry !== undefined && row.kind === 'file' && row.entry.path === currentPath;
    const disabled = !row.expandable && !row.openable;
    const hint =
      row.kind === 'symlinkDir'
        ? `${row.label}（フォルダへのリンク。開きません）`
        : row.kind === 'file' && !row.openable
          ? `${row.label}（開けない形式です）`
          : row.label;
    const click = () => {
      setActiveId(row.id);
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
        tabIndex={row.id === tabId ? 0 : -1}
        aria-level={row.level}
        aria-label={row.kind === 'symlinkDir' ? `${row.label}（リンク）` : row.label}
        aria-expanded={row.expandable ? row.expanded : undefined}
        aria-disabled={disabled ? true : undefined}
        aria-current={current ? 'true' : undefined}
      >
        <div
          className="tree-row"
          title={row.kind === 'note' ? undefined : hint}
          style={{ paddingLeft: `${6 + (row.level - 1) * 14}px` }}
          onClick={row.kind === 'note' ? undefined : click}
        >
          <span className="tree-twisty" aria-hidden="true">
            {row.expandable ? <Chevron expanded={row.expanded} /> : null}
          </span>
          {row.kind !== 'note' && (
            <span className="tree-icon" aria-hidden="true">
              {row.kind === 'dir' || row.kind === 'symlinkDir' ? <FolderIcon /> : <FileIcon />}
            </span>
          )}
          <span className="tree-name">{row.label}</span>
          {row.kind === 'symlinkDir' && (
            <span className="tree-badge" aria-hidden="true">
              ↪
            </span>
          )}
        </div>
        {node.children.length > 0 && (
          <ul role="group" className="tree-group">
            {node.children.map(render)}
          </ul>
        )}
      </li>
    );
  };

  return (
    <ul role="tree" aria-label="フォルダのツリー" className="file-tree" data-testid="file-tree" onKeyDown={onKeyDown}>
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
