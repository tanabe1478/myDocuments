/**
 * エクスプローラーのツリーの純粋なロジック（React にも bridge にも依存しない）。
 * 読み込み済みのフォルダの中身（dirs）と展開状態（expanded）から、表示する行を作り、キー操作の結果を決める。
 */
import { isOpenableFile } from '../document/fileKinds';
import type { FolderEntry } from '../platform';

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

/** フォルダ（リンクを含む）か。並べ替えで先に置く。 */
function isFolderLike(entry: FolderEntry): boolean {
  return entry.kind === 'dir' || entry.kind === 'symlinkDir';
}

/** フォルダが先、その中は名前の自然順（大文字小文字を区別せず、数字は数として比べる）。元の配列は変えない。 */
export function sortEntries(entries: readonly FolderEntry[]): FolderEntry[] {
  return [...entries].sort(
    (a, b) =>
      Number(isFolderLike(b)) - Number(isFolderLike(a)) ||
      collator.compare(a.name, b.name) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/** 1 つのフォルダの読み込み状態。 */
export type DirState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'loaded';
      /** 並べ替え済み。 */
      readonly entries: readonly FolderEntry[];
      /** 件数の上限で出していない項目の数。 */
      readonly more: number;
    }
  | { readonly status: 'error'; readonly message: string };

export type RowKind = 'dir' | 'file' | 'symlinkDir' | 'other' | 'note';
export type NoteKind = 'loading' | 'empty' | 'error' | 'more';

export interface TreeRow {
  /** 項目はパス。補足の行は、親のパスと種類から作る。 */
  readonly id: string;
  /** 親の行の id。最上位は null。 */
  readonly parentId: string | null;
  /** 1 始まり（aria-level）。 */
  readonly level: number;
  readonly kind: RowKind;
  readonly entry?: FolderEntry;
  /** 表示する名前（補足の行は文言）。 */
  readonly label: string;
  /** 展開できるフォルダか（フォルダへのシンボリックリンクは展開しない）。 */
  readonly expandable: boolean;
  readonly expanded: boolean;
  /** クリックや Enter で開ける文書か。 */
  readonly openable: boolean;
  readonly note?: NoteKind;
}

export interface TreeNode {
  readonly row: TreeRow;
  /** 展開しているときの子（展開していなければ空）。 */
  readonly children: readonly TreeNode[];
}

export const NOTE_LABELS = {
  loading: '読み込み中…',
  empty: '空のフォルダ',
  more: (count: number) => `ほか ${count.toLocaleString('ja-JP')} 件`,
} as const;

function noteNode(parentPath: string, parentId: string | null, level: number, note: NoteKind, label: string): TreeNode {
  return {
    row: {
      id: `${parentPath}\u0000note:${note}`,
      parentId,
      level,
      kind: 'note',
      label,
      expandable: false,
      expanded: false,
      openable: false,
      note,
    },
    children: [],
  };
}

/** dir の中身の行。 */
function childNodes(
  dirPath: string,
  parentId: string | null,
  level: number,
  dirs: ReadonlyMap<string, DirState>,
  expanded: ReadonlySet<string>,
): TreeNode[] {
  const state = dirs.get(dirPath);
  if (!state || state.status === 'loading') return [noteNode(dirPath, parentId, level, 'loading', NOTE_LABELS.loading)];
  if (state.status === 'error') return [noteNode(dirPath, parentId, level, 'error', state.message)];
  const nodes = state.entries.map((entry): TreeNode => {
    const expandable = entry.kind === 'dir';
    const isExpanded = expandable && expanded.has(entry.path);
    return {
      row: {
        id: entry.path,
        parentId,
        level,
        kind: entry.kind,
        entry,
        label: entry.name,
        expandable,
        expanded: isExpanded,
        openable: entry.kind === 'file' && isOpenableFile(entry.name),
      },
      children: isExpanded ? childNodes(entry.path, entry.path, level + 1, dirs, expanded) : [],
    };
  });
  if (state.entries.length === 0) nodes.push(noteNode(dirPath, parentId, level, 'empty', NOTE_LABELS.empty));
  if (state.more > 0) nodes.push(noteNode(dirPath, parentId, level, 'more', NOTE_LABELS.more(state.more)));
  return nodes;
}

/** ルートのフォルダの中身を、最上位（level 1）としたツリー。ルート自身は行にしない（見出し部に出す）。 */
export function buildTree(
  rootPath: string,
  dirs: ReadonlyMap<string, DirState>,
  expanded: ReadonlySet<string>,
): TreeNode[] {
  return childNodes(rootPath, null, 1, dirs, expanded);
}

/** 画面に見えている順（上から下）の行。キー操作の移動の単位。 */
export function flattenRows(nodes: readonly TreeNode[]): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (list: readonly TreeNode[]) => {
    for (const node of list) {
      rows.push(node.row);
      walk(node.children);
    }
  };
  walk(nodes);
  return rows;
}

export type TreeKey = 'ArrowDown' | 'ArrowUp' | 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End' | 'Enter' | ' ';

export const TREE_KEYS: readonly string[] = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Enter', ' '];

export type TreeAction = 'expand' | 'collapse' | 'toggle' | 'open';

export interface NavigationResult {
  /** フォーカス（roving tabindex の位置）を置く行。 */
  readonly focusId: string;
  /** 行に対して起こす操作。なければ null。 */
  readonly action: TreeAction | null;
}

/**
 * キー操作の結果。上下で移動、右で展開（展開済みなら最初の子へ）、左で折りたたみ（折りたたみ済みか展開できないなら親へ）、
 * Home / End で先頭・末尾、Enter（と Space）でフォルダの開閉または文書を開く。
 * 行がない、または activeId が行にないときは null。
 */
export function navigate(rows: readonly TreeRow[], activeId: string | null, key: TreeKey): NavigationResult | null {
  if (rows.length === 0) return null;
  const index = rows.findIndex((r) => r.id === activeId);
  const current = rows[index < 0 ? 0 : index]!;
  const at = index < 0 ? 0 : index;
  const stay = (action: TreeAction | null = null): NavigationResult => ({ focusId: current.id, action });
  const move = (to: number): NavigationResult => ({ focusId: rows[Math.min(Math.max(to, 0), rows.length - 1)]!.id, action: null });

  switch (key) {
    case 'ArrowDown':
      return move(at + 1);
    case 'ArrowUp':
      return move(at - 1);
    case 'Home':
      return move(0);
    case 'End':
      return move(rows.length - 1);
    case 'ArrowRight': {
      if (!current.expandable) return stay();
      if (!current.expanded) return stay('expand');
      const child = rows[at + 1];
      return child && child.parentId === current.id ? { focusId: child.id, action: null } : stay();
    }
    case 'ArrowLeft': {
      if (current.expandable && current.expanded) return stay('collapse');
      return current.parentId !== null ? { focusId: current.parentId, action: null } : stay();
    }
    case 'Enter':
    case ' ':
      if (current.expandable) return stay('toggle');
      return stay(current.openable ? 'open' : null);
  }
}
