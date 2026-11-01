import type { Draft, DraftSummary, SessionInfo } from '../platform';
import { NO_EXTERNAL_CHANGE, type ExternalState } from './external';
import type { DocumentFormat } from './format';
import { basename, type DocumentState } from './state';

/** 起動時にすること。 */
export type StartupPlan =
  /** 復旧できる草稿がある。確認を出す（newest は最も新しい草稿、others はそれ以外の件数）。 */
  | { kind: 'ask-draft'; draft: DraftSummary; others: number }
  /** 草稿はない。前回の文書を開き直す。 */
  | { kind: 'reopen'; path: string }
  | { kind: 'nothing' };

/** 草稿があれば復旧の確認。なければ、前回の文書を開き直す。 */
export function planStartup(drafts: readonly DraftSummary[], session: SessionInfo | null): StartupPlan {
  const [newest] = [...drafts].sort((a, b) => b.updatedAt - a.updatedAt);
  if (newest) return { kind: 'ask-draft', draft: newest, others: drafts.length - 1 };
  if (session?.lastPath) return { kind: 'reopen', path: session.lastPath };
  return { kind: 'nothing' };
}

/** 復旧の確認に出す文書名。 */
export function draftTitle(draft: Pick<DraftSummary, 'path'>, untitled: string): string {
  return draft.path === null ? untitled : basename(draft.path);
}

/** 草稿の元の文書の、いまのディスクの内容。 */
export interface OriginalOnDisk {
  /** 改行は LF に正規化済み。 */
  readonly text: string;
  readonly format: DocumentFormat;
  readonly revision: string;
}

export interface Restored {
  readonly state: DocumentState;
  readonly external: ExternalState;
  /** 復旧した本文が、ディスクの内容と同じ（復旧するものがない）。草稿は消してよい。 */
  readonly redundant: boolean;
}

/**
 * 草稿から文書の状態を組み立てる純関数。original は、草稿の元のファイルを読めたときの内容（読めなければ null）。
 * - 元のファイルがない・読めない・草稿に保存先がない → 保存先のない文書として復旧する（本文を失わない）。
 * - 元のファイルが、草稿の元になった revision のまま → 通常の未保存の文書。
 * - 元のファイルが変わっている → 衝突として扱う（保存は、ユーザーが選ぶまで書かない）。
 *   savedText は、草稿の元の本文が残っていないので、いまのディスクの内容で代用する。
 *   diskRevision は草稿の baseRevision のままにし、保存すれば必ず衝突として検出される。
 */
export function restoreFromDraft(draft: Draft, original: OriginalOnDisk | null): Restored {
  const base = { draftId: draft.draftId, text: draft.text, format: draft.format };

  if (draft.path === null || original === null) {
    return {
      state: { ...base, path: null, savedText: '', diskRevision: null },
      external: NO_EXTERNAL_CHANGE,
      redundant: false,
    };
  }

  const sameText = original.text === draft.text;
  if (original.revision === draft.baseRevision || sameText) {
    return {
      state: { ...base, path: draft.path, savedText: original.text, diskRevision: original.revision },
      external: NO_EXTERNAL_CHANGE,
      redundant: sameText,
    };
  }

  return {
    state: { ...base, path: draft.path, savedText: original.text, diskRevision: draft.baseRevision },
    external: {
      kind: 'conflict',
      disk: { kind: 'changed', revision: original.revision, text: original.text, format: original.format },
      keepMine: false,
    },
    redundant: false,
  };
}
