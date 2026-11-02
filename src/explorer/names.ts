/**
 * ツリーでの作成・名前の変更に使う純粋な関数（名前の検査、既定の拡張子、パスの操作、作成先の決め方）。
 * 名前の規則の正本は Rust 側（src-tauri/src/entries.rs の validate_name）。ここは、入力欄で理由をすぐ見せるための同じ規則。
 */
import { extensionOf } from '../document/fileKinds';

/** ファイルの拡張子がないときに足す拡張子。 */
export const DEFAULT_EXTENSION = '.md';

export type NameProblem = 'empty' | 'separator' | 'dot' | 'hidden' | 'invalid-char' | 'trailing' | 'duplicate';

export const NAME_PROBLEM_MESSAGES: Record<NameProblem, string> = {
  empty: '名前を入力してください。',
  separator: '名前に / や \\ は使えません。',
  dot: '「.」と「..」は名前に使えません。',
  hidden: 'ドットで始まる名前は、ツリーに表示されなくなるため使えません。',
  'invalid-char': '名前に使えない文字があります（< > : " | ? * と制御文字）。',
  trailing: '名前の末尾にドットや空白は使えません。',
  duplicate: '同じ名前の項目がすでにあります。',
};

export type NameCheck = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly problem: NameProblem; readonly message: string };

const fail = (problem: NameProblem): NameCheck => ({ ok: false, problem, message: NAME_PROBLEM_MESSAGES[problem] });

/**
 * 新しい名前の検査。siblings は同じフォルダの項目の名前。同じ名前（完全に一致するもの）は拒否する。
 * 大文字小文字だけが違う名前は、ファイルシステムが区別するかで決まるので、ここでは通し、ネイティブ側の判断に任せる。
 * 名前の変更では、自分自身の名前は siblings から除いて渡す。
 */
export function checkName(name: string, siblings: readonly string[]): NameCheck {
  if (name.trim() === '') return fail('empty');
  if (name.includes('/') || name.includes('\\')) return fail('separator');
  if (name === '.' || name === '..') return fail('dot');
  if (name.startsWith('.')) return fail('hidden');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f<>:"|?*]/.test(name)) return fail('invalid-char');
  if (name.endsWith('.') || name.endsWith(' ')) return fail('trailing');
  if (siblings.includes(name)) return fail('duplicate');
  return { ok: true, name };
}

/** ファイルの名前に、拡張子がなければ .md を足す。拡張子の判定は fileKinds と同じ。 */
export function withDefaultExtension(name: string): string {
  return extensionOf(name) === '' ? `${name}${DEFAULT_EXTENSION}` : name;
}

/** パスの区切り。Windows のパス（\ を含み、/ を含まない）なら \、それ以外は /。 */
export function separatorOf(path: string): '/' | '\\' {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

export function joinPath(dir: string, name: string): string {
  const sep = separatorOf(dir);
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** 親フォルダのパス。最上位（親がない）なら null。 */
export function parentOf(path: string): string | null {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (cut <= 0) return null;
  return path.slice(0, cut);
}

/** path が ancestor そのもの、または ancestor の配下か。 */
export function isSameOrInside(path: string, ancestor: string): boolean {
  if (path === ancestor) return true;
  const sep = separatorOf(ancestor);
  const prefix = ancestor.endsWith(sep) ? ancestor : `${ancestor}${sep}`;
  return path.startsWith(prefix);
}

/**
 * oldPath の名前を newPath に変えたとき、path が移る先。path が oldPath そのもの、または配下ならそのパス、
 * 無関係なら null。
 */
export function relocatePath(path: string, oldPath: string, newPath: string): string | null {
  if (!isSameOrInside(path, oldPath)) return null;
  return `${newPath}${path.slice(oldPath.length)}`;
}

/** 名前の変更の入力欄の、最初の選択範囲（拡張子の前まで。フォルダと拡張子のない名前は全部）。 */
export function renameSelection(name: string, isFolder: boolean): [number, number] {
  const dot = name.lastIndexOf('.');
  return !isFolder && dot > 0 ? [0, dot] : [0, name.length];
}

export interface CreateTargetRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: string;
}

/**
 * 作成先のフォルダ。選択中のフォルダ、ファイルが選択中ならその親フォルダ、何も選んでいない（または選択が見つからない）ならルート。
 * rows は画面に見えている行。id は項目のパス、parentId は親のパス（最上位は null）。
 */
export function createTargetDir(root: string, rows: readonly CreateTargetRow[], selectedId: string | null): string {
  const row = selectedId === null ? undefined : rows.find((r) => r.id === selectedId);
  if (!row) return root;
  // 補足の行（空のフォルダ、読み込み中など）は、そのフォルダの一部として扱う。
  if (row.kind === 'dir') return row.id;
  return row.parentId ?? root;
}
