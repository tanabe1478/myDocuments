import { useEffect, useRef } from 'react';
import type { DiscardChoice } from '../document/controller';

interface Props {
  documentName: string;
  onChoose(choice: DiscardChoice): void;
}

/** 未保存の変更があるまま、新規・開くを実行したときの確認。Esc はキャンセル。 */
export function ConfirmDiscardDialog({ documentName, onChoose }: Props) {
  const saveRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onChoose('cancel');
      return;
    }
    if (e.key !== 'Tab') return;
    // フォーカスをダイアログ内に閉じ込める。
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

  return (
    <div className="dialog-backdrop">
      <div
        ref={rootRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="discard-title"
        aria-describedby="discard-body"
        onKeyDown={onKeyDown}
      >
        <h2 id="discard-title">未保存の変更があります</h2>
        <p id="discard-body">「{documentName}」の変更を保存しますか？</p>
        <div className="dialog-actions">
          <button type="button" data-testid="discard-cancel" onClick={() => onChoose('cancel')}>
            キャンセル
          </button>
          <button type="button" data-testid="discard-discard" onClick={() => onChoose('discard')}>
            保存しない
          </button>
          <button type="button" data-testid="discard-save" ref={saveRef} className="primary" onClick={() => onChoose('save')}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
