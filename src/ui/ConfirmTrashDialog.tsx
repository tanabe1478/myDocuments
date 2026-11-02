import { useEffect, useRef } from 'react';
import type { TrashTarget } from '../explorer/controller';

interface Props {
  target: TrashTarget;
  onChoose(confirmed: boolean): void;
}

/** ゴミ箱へ移す前の確認（毎回出す）。既定のフォーカスはキャンセル。Esc もキャンセル。 */
export function ConfirmTrashDialog({ target, onChoose }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onChoose(false);
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

  const message =
    target.kind === 'folder'
      ? `フォルダ "${target.name}" とその中身をゴミ箱に移動しますか？`
      : `"${target.name}" をゴミ箱に移動しますか？`;

  return (
    <div className="dialog-backdrop">
      <div
        ref={rootRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="trash-title"
        aria-describedby="trash-body"
        data-testid="confirm-trash"
        onKeyDown={onKeyDown}
      >
        <h2 id="trash-title">ゴミ箱に移動</h2>
        <p id="trash-body">{message}</p>
        <div className="dialog-actions">
          <button type="button" data-testid="trash-cancel" ref={cancelRef} onClick={() => onChoose(false)}>
            キャンセル
          </button>
          <button type="button" data-testid="trash-ok" className="primary" onClick={() => onChoose(true)}>
            ゴミ箱に移動
          </button>
        </div>
      </div>
    </div>
  );
}
