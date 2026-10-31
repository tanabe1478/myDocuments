import { DEFAULT_FORMAT, eolLabel, type DocumentFormat } from './format';

/**
 * 文書の状態。dirty は保持せず、text と savedText の比較で導出する。
 * text は編集中の本文（LF 正規化済み）、savedText は最後に読み込んだ／保存した本文。
 */
export interface DocumentState {
  readonly path: string | null;
  readonly savedText: string;
  readonly text: string;
  readonly format: DocumentFormat;
}

export function newDocumentState(): DocumentState {
  return { path: null, savedText: '', text: '', format: DEFAULT_FORMAT };
}

export function openedDocumentState(path: string, text: string, format: DocumentFormat): DocumentState {
  return { path, savedText: text, text, format };
}

export function isDirty(state: DocumentState): boolean {
  return state.text !== state.savedText;
}

export function withText(state: DocumentState, text: string): DocumentState {
  return state.text === text ? state : { ...state, text };
}

/**
 * 保存が成功した後の状態。savedText は保存した時点の本文で、text には触れない
 * （保存中に入力が進んでいても、その分は未保存のまま残る）。
 * 保存では多数派の改行コードに揃うので、mixedEol は解消する。
 */
export function savedDocumentState(
  state: DocumentState,
  saved: { path: string; text: string; format: DocumentFormat },
): DocumentState {
  return {
    ...state,
    path: saved.path,
    savedText: saved.text,
    format: { ...saved.format, mixedEol: false },
  };
}

/** 新規・開くの前に、未保存の変更の扱いを確認する必要があるか。 */
export function needsDiscardConfirmation(state: DocumentState): boolean {
  return isDirty(state);
}

export type SavePlan =
  /** 保存先がない。保存先を選ぶ（別名保存へ）。 */
  | { kind: 'choose-path' }
  /** 変更がない。何もしない。 */
  | { kind: 'noop' }
  | { kind: 'write'; path: string };

/** 保存（上書き）の方針。bridge を呼ぶ前に決まる部分。 */
export function planSave(state: DocumentState): SavePlan {
  if (state.path === null) return { kind: 'choose-path' };
  if (!isDirty(state)) return { kind: 'noop' };
  return { kind: 'write', path: state.path };
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export const UNTITLED = '無題';

export function documentTitle(state: DocumentState): string {
  return state.path === null ? UNTITLED : basename(state.path);
}

/** 保存先の候補に使うファイル名。 */
export function suggestedFileName(state: DocumentState): string {
  return state.path === null ? `${UNTITLED}.md` : basename(state.path);
}

/** 混在改行を多数派に揃えて保存したときの通知。揃える必要がなければ null。 */
export function mixedEolNotice(format: DocumentFormat): string | null {
  if (!format.mixedEol) return null;
  return `改行コードが混在していたため、多数派の ${eolLabel(format.eol)} に揃えて保存しました。`;
}
