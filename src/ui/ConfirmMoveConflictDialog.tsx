import { useEffect, useRef } from 'react';
import type { MoveConflictChoice, MoveConflictInfo } from '../explorer/controller';

interface Props {
  info: MoveConflictInfo;
  onChoose(choice: MoveConflictChoice): void;
}

const KIND_LABEL = { file: 'ファイル', folder: 'フォルダ' } as const;

/**
 * 移し先に同じ名前の項目があるときの確認（毎回出す）。置き換える（既存の項目はゴミ箱へ移る）、両方とも残す（番号を付ける。既定のフォーカス）、
 * 中止（Esc もこれ）。置き換えを選べないとき（開いている文書を置き換えることになる、移す項目が既存の項目の中にある）は、
 * ボタンを aria-disabled にして、理由を出す（フォーカスは受けるので、理由が読める）。Tab はダイアログの中で回る。
 */
export function ConfirmMoveConflictDialog({ info, onChoose }: Props) {
  const keepBothRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    keepBothRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onChoose('cancel');
      return;
    }
    if (e.key !== 'Tab') return;
    const buttons = Array.from(rootRef.current?.querySelectorAll('button') ?? []);
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  const blocked = info.replaceBlockedReason !== null;
  const differentKinds = info.movingKind !== info.existingKind;

  return (
    <div className="dialog-backdrop">
      <div
        ref={rootRef}
        className="dialog move-conflict-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="move-conflict-title"
        aria-describedby="move-conflict-body"
        data-testid="confirm-move-conflict"
        onKeyDown={onKeyDown}
      >
        <h2 id="move-conflict-title">同じ名前の項目があります</h2>
        <div id="move-conflict-body">
          <p data-testid="move-conflict-message">
            “{info.name}” という名前の項目が “{info.destName}” にすでにあります。
          </p>
          {differentKinds && (
            <p data-testid="move-conflict-kinds">
              移す項目は{KIND_LABEL[info.movingKind]}、すでにある項目は{KIND_LABEL[info.existingKind]}です。
            </p>
          )}
        </div>
        <div className="move-conflict-actions">
          <button
            type="button"
            data-testid="move-replace"
            className="move-conflict-choice"
            aria-disabled={blocked ? true : undefined}
            aria-describedby={blocked ? 'move-replace-reason' : 'move-replace-note'}
            onClick={() => {
              if (!blocked) onChoose('replace');
            }}
          >
            <span className="move-conflict-label">置き換える</span>
            <span id="move-replace-note" className="move-conflict-note">
              すでにある項目は、ゴミ箱へ移ります。
            </span>
          </button>
          {blocked && (
            <p id="move-replace-reason" className="move-conflict-reason" data-testid="move-replace-reason">
              {info.replaceBlockedReason}
            </p>
          )}
          <button type="button" data-testid="move-keep-both" ref={keepBothRef} className="move-conflict-choice primary" onClick={() => onChoose('keep-both')}>
            <span className="move-conflict-label">両方とも残す</span>
            <span className="move-conflict-note">移す項目に、番号を付けます。</span>
          </button>
          <button type="button" data-testid="move-cancel" className="move-conflict-choice" onClick={() => onChoose('cancel')}>
            <span className="move-conflict-label">中止</span>
          </button>
        </div>
      </div>
    </div>
  );
}
