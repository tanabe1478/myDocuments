import { isDirty, type DocumentState, type SavePolicy } from './state';
import type { DocumentFormat } from './format';

/** ディスクにあった、自分の知らない新しい内容。 */
export interface ChangedOnDisk {
  readonly kind: 'changed';
  readonly revision: string;
  /** 改行は LF に正規化済み。 */
  readonly text: string;
  readonly format: DocumentFormat;
}

export type DiskSide = ChangedOnDisk | { readonly kind: 'deleted' };

/**
 * 外部変更の状態。DocumentState とは別に持つ。
 * none: 変更なし。
 * changed: 未保存の変更がない文書で、ディスクが変わった（読み直しの途中の状態）。
 * deleted: 未保存の変更がない文書で、ファイルが削除された。
 * conflict: 未保存の変更がある文書で、ディスクが変わった（または削除された）。
 *   keepMine は、ユーザーが「自分の版を残す」を選んだ（次の保存で、ディスクの版を置き換える）。
 */
export type ExternalState =
  | { readonly kind: 'none' }
  | { readonly kind: 'changed'; readonly disk: ChangedOnDisk }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'conflict'; readonly disk: DiskSide; readonly keepMine: boolean };

export const NO_EXTERNAL_CHANGE: ExternalState = { kind: 'none' };

/** ディスクを確かめた結果。 */
export type DiskObservation =
  /** ディスクの revision が、文書が最後に見たものと同じ。 */
  | { readonly kind: 'unchanged' }
  | ChangedOnDisk
  | { readonly kind: 'deleted' };

/** 状態の遷移に伴って、呼び出し側がすること。 */
export type ExternalEffect =
  | 'none'
  /** 本文をディスクの内容に読み直し、通知する（未保存の変更がないとき）。 */
  | 'reload'
  /** 衝突したことを知らせる。 */
  | 'announce-conflict'
  /** ファイルが削除されたことを知らせる。 */
  | 'announce-deleted';

export interface ExternalTransition {
  readonly next: ExternalState;
  readonly effect: ExternalEffect;
}

/**
 * ディスクの観測結果から、次の外部変更の状態と、すべきことを決める純関数。
 * 同じ状態を繰り返し観測しても（フォーカスのたび、監視の重複通知）、通知は繰り返さない。
 */
export function observeDisk(doc: DocumentState, current: ExternalState, obs: DiskObservation): ExternalTransition {
  const dirty = isDirty(doc);

  if (obs.kind === 'unchanged') {
    return { next: NO_EXTERNAL_CHANGE, effect: 'none' };
  }

  if (obs.kind === 'changed') {
    if (!dirty) return { next: { kind: 'changed', disk: obs }, effect: 'reload' };
    if (current.kind === 'conflict' && current.disk.kind === 'changed' && current.disk.revision === obs.revision) {
      // 既に知っている衝突（ユーザーの選択も保つ）。
      return { next: current, effect: 'none' };
    }
    return {
      next: { kind: 'conflict', disk: obs, keepMine: false },
      // 未解決の衝突の内容が更新されただけなら、静かに差し替える。
      effect: current.kind === 'conflict' && !current.keepMine ? 'none' : 'announce-conflict',
    };
  }

  // 削除
  if (current.kind === 'deleted' || (current.kind === 'conflict' && current.disk.kind === 'deleted')) {
    return { next: current, effect: 'none' };
  }
  return {
    next: dirty ? { kind: 'conflict', disk: { kind: 'deleted' }, keepMine: false } : { kind: 'deleted' },
    effect: 'announce-deleted',
  };
}

/** 外部変更の状態から決まる、保存の仕方。 */
export function savePolicy(ext: ExternalState): SavePolicy {
  if (isDeleted(ext)) return 'recreate';
  if (ext.kind === 'conflict' && ext.keepMine) return 'overwrite';
  return 'normal';
}

/** ファイルが削除されている状態か（未保存の変更の有無によらない）。 */
export function isDeleted(ext: ExternalState): boolean {
  return ext.kind === 'deleted' || (ext.kind === 'conflict' && ext.disk.kind === 'deleted');
}

/** 競合バーで、ユーザーの選択を待っている衝突か。 */
export function isUnresolvedConflict(ext: ExternalState): boolean {
  return ext.kind === 'conflict' && !ext.keepMine;
}

/** 「自分の版を残す」を選んだ状態にする。ディスクの内容が変わっていなければ何も変えない。 */
export function keepMine(ext: ExternalState): ExternalState {
  if (ext.kind !== 'conflict' || ext.disk.kind !== 'changed') return ext;
  return { ...ext, keepMine: true };
}

/** 差分を見せるための、ディスクの内容。削除されている・衝突していないなら null。 */
export function diskTextForDiff(ext: ExternalState): string | null {
  return ext.kind === 'conflict' && ext.disk.kind === 'changed' ? ext.disk.text : null;
}
