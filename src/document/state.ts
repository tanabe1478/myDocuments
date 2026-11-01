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
  /**
   * savedText に対応する、ディスク上のバイト列の revision（SHA-256）。
   * 保存時に「最後に見たディスクの状態」として渡し、ディスクが違えば書かずに衝突にする。
   * ディスクにファイルがない前提（新規文書、削除された文書）は null。
   */
  readonly diskRevision: string | null;
  /** 草稿の識別子。文書ごとに 1 つ（新規文書も、開いた文書も、文書を切り替えるたびに新しくする）。 */
  readonly draftId: string;
}

export function newDocumentState(draftId: string): DocumentState {
  return { path: null, savedText: '', text: '', format: DEFAULT_FORMAT, diskRevision: null, draftId };
}

export interface LoadedDocument {
  readonly path: string;
  readonly text: string;
  readonly format: DocumentFormat;
  readonly revision: string;
}

export function openedDocumentState(loaded: LoadedDocument, draftId: string): DocumentState {
  return {
    path: loaded.path,
    savedText: loaded.text,
    text: loaded.text,
    format: loaded.format,
    diskRevision: loaded.revision,
    draftId,
  };
}

/** ディスクの新しい内容を読み直した後の状態（パスと draftId は保つ）。 */
export function reloadedDocumentState(state: DocumentState, loaded: LoadedDocument): DocumentState {
  return {
    ...state,
    path: loaded.path,
    savedText: loaded.text,
    text: loaded.text,
    format: loaded.format,
    diskRevision: loaded.revision,
  };
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
  saved: { path: string; text: string; format: DocumentFormat; revision: string },
): DocumentState {
  return {
    ...state,
    path: saved.path,
    savedText: saved.text,
    format: { ...saved.format, mixedEol: false },
    diskRevision: saved.revision,
  };
}

/** 新規・開くの前に、未保存の変更の扱いを確認する必要があるか。 */
export function needsDiscardConfirmation(state: DocumentState): boolean {
  return isDirty(state);
}

/**
 * 外部変更の状態から決まる、保存の仕方。
 * normal: ディスクが最後に見たとおりであることを確かめて書く。
 * recreate: ファイルが削除された。作り直す（変更がなくても書く。確認が要る）。
 * overwrite: 衝突を承知で、ディスクの版を置き換える（先にバックアップされる）。
 */
export type SavePolicy = 'normal' | 'recreate' | 'overwrite';

export type SavePlan =
  /** 保存先がない。保存先を選ぶ（別名保存へ）。 */
  | { kind: 'choose-path' }
  /** 変更がない。何もしない。 */
  | { kind: 'noop' }
  | {
      kind: 'write';
      path: string;
      /** ディスクが最後に見たとおりかを確かめる revision。ファイルがない前提なら null。 */
      expectedRevision: string | null;
      overwrite: boolean;
      /** 削除されたファイルを作り直す保存。書く前に確認が要る。 */
      recreate: boolean;
    };

/** 保存（上書き）の方針。bridge を呼ぶ前に決まる部分。 */
export function planSave(state: DocumentState, policy: SavePolicy = 'normal'): SavePlan {
  if (state.path === null) return { kind: 'choose-path' };
  if (policy === 'recreate') {
    return { kind: 'write', path: state.path, expectedRevision: null, overwrite: false, recreate: true };
  }
  if (!isDirty(state)) return { kind: 'noop' };
  return {
    kind: 'write',
    path: state.path,
    expectedRevision: state.diskRevision,
    overwrite: policy === 'overwrite',
    recreate: false,
  };
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
