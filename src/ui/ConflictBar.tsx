import { isDeleted, type ExternalState } from '../document/external';

interface Props {
  external: ExternalState;
  onShowDiff(): void;
  onReload(): void;
  onKeepMine(): void;
  onRecreate(): void;
}

/**
 * 外部変更の競合バー。ユーザーの選択が要る状態（衝突、削除）のときだけ表示する。
 * 自動で読み直した場合（未保存の変更がなかったとき）は、通知だけでバーは出さない。
 */
export function ConflictBar({ external, onShowDiff, onReload, onKeepMine, onRecreate }: Props) {
  if (isDeleted(external)) {
    return (
      <div className="conflict-bar" role="alert" data-testid="conflict-bar" data-state="deleted">
        <span className="conflict-message">ファイルが削除されました。本文はそのまま残しています。</span>
        <button type="button" data-testid="deleted-recreate" onClick={onRecreate}>
          作り直して保存
        </button>
      </div>
    );
  }
  if (external.kind !== 'conflict') return null;

  if (external.keepMine) {
    return (
      <div className="conflict-bar" role="status" data-testid="conflict-bar" data-state="keep-mine">
        <span className="conflict-message">自分の版を残します。次の保存で、ディスクの版はバックアップしてから置き換えます。</span>
        <button type="button" data-testid="conflict-diff" onClick={onShowDiff}>
          差分を見る
        </button>
        <button type="button" data-testid="conflict-reload" onClick={onReload}>
          ディスクから読み直す
        </button>
      </div>
    );
  }
  return (
    <div className="conflict-bar" role="alert" data-testid="conflict-bar" data-state="conflict">
      <span className="conflict-message">ファイルが外部で変更されています。未保存の変更と食い違っています。</span>
      <button type="button" data-testid="conflict-diff" onClick={onShowDiff}>
        差分を見る
      </button>
      <button type="button" data-testid="conflict-reload" onClick={onReload}>
        ディスクから読み直す
      </button>
      <button type="button" data-testid="conflict-keep" onClick={onKeepMine}>
        自分の版を残す
      </button>
    </div>
  );
}
