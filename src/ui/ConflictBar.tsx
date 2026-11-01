import type { Ref } from 'react';
import { isDeleted, type ExternalState } from '../document/external';

interface Props {
  external: ExternalState;
  /** バーを置く領域。F6 の巡回（App.tsx）が、表示中だけ対象に含めるために使う。 */
  regionRef?: Ref<HTMLDivElement>;
  onShowDiff(): void;
  onReload(): void;
  onKeepMine(): void;
  onRecreate(): void;
}

type BarState = 'deleted' | 'keep-mine' | 'conflict';

interface BarAction {
  testId: string;
  label: string;
  run(): void;
}

interface BarView {
  state: BarState;
  /** alert は出現が読み上げられる（選択が要る状態）。status は控えめな通知（選択済み）。 */
  role: 'alert' | 'status';
  /** バーの名前。 */
  name: string;
  message: string;
  actions: BarAction[];
}

/**
 * 外部変更の競合バー。ユーザーの選択が要る状態（衝突、削除）のときだけ表示する。
 * 自動で読み直した場合（未保存の変更がなかったとき）は、通知だけでバーは出さない。
 *
 * 本文には重ねない。.app の縦の並びの中、上部バーの下・本文の上に専用の場所を取り、表示中は本文の領域が縮む。
 * 1 行目にメッセージ、2 行目に操作ボタン。幅は本文の列に揃える（styles.css の .conflict-bar）。
 * キーボード: Tab で本文の前に並ぶボタンへ届く。F6 の巡回（本文 → 上部バー → 競合バー → 下部バー）にも含める。
 */
/** 競合バーを表示する状態か。表示中は、本文の上の余白を詰める（styles.css の data-conflict）。 */
export function isConflictBarVisible(external: ExternalState): boolean {
  return isDeleted(external) || external.kind === 'conflict';
}

export function ConflictBar({ external, regionRef, onShowDiff, onReload, onKeepMine, onRecreate }: Props) {
  const view = describe(external, { onShowDiff, onReload, onKeepMine, onRecreate });
  if (!view) return null;
  return (
    <div className="conflict-region" ref={regionRef}>
      <div className="conflict-bar" role={view.role} aria-label={view.name} data-testid="conflict-bar" data-state={view.state}>
        <p className="conflict-message">{view.message}</p>
        <div className="conflict-actions">
          {view.actions.map((action) => (
            <button key={action.testId} type="button" data-testid={action.testId} onClick={action.run}>
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function describe(
  external: ExternalState,
  handlers: Pick<Props, 'onShowDiff' | 'onReload' | 'onKeepMine' | 'onRecreate'>,
): BarView | null {
  const diff: BarAction = { testId: 'conflict-diff', label: '差分を見る', run: handlers.onShowDiff };
  const reload: BarAction = { testId: 'conflict-reload', label: 'ディスクから読み直す', run: handlers.onReload };

  if (isDeleted(external)) {
    return {
      state: 'deleted',
      role: 'alert',
      name: 'ファイルの削除',
      message: 'ファイルが削除されました。本文はそのまま残しています。',
      actions: [{ testId: 'deleted-recreate', label: '作り直して保存', run: handlers.onRecreate }],
    };
  }
  if (external.kind !== 'conflict') return null;

  if (external.keepMine) {
    return {
      state: 'keep-mine',
      role: 'status',
      name: '外部変更の競合',
      message: '自分の版を残します。次の保存で、ディスクの版はバックアップしてから置き換えます。',
      actions: [diff, reload],
    };
  }
  return {
    state: 'conflict',
    role: 'alert',
    name: '外部変更の競合',
    message: 'ファイルが外部で変更されています。未保存の変更と食い違っています。',
    actions: [diff, reload, { testId: 'conflict-keep', label: '自分の版を残す', run: handlers.onKeepMine }],
  };
}
