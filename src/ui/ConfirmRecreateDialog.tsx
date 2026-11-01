import { useEffect, useRef } from 'react';

interface Props {
  documentName: string;
  onChoose(recreate: boolean): void;
}

/** 削除されたファイルを、保存で作り直してよいかの確認。Esc はキャンセル。 */
export function ConfirmRecreateDialog({ documentName, onChoose }: Props) {
  const okRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    okRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
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

  return (
    <div className="dialog-backdrop">
      <div
        ref={rootRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="recreate-title"
        aria-describedby="recreate-body"
        onKeyDown={onKeyDown}
      >
        <h2 id="recreate-title">ファイルが削除されています</h2>
        <p id="recreate-body">「{documentName}」は削除されています。保存して、ファイルを作り直しますか？</p>
        <div className="dialog-actions">
          <button type="button" data-testid="recreate-cancel" onClick={() => onChoose(false)}>
            キャンセル
          </button>
          <button type="button" data-testid="recreate-ok" ref={okRef} className="primary" onClick={() => onChoose(true)}>
            作り直して保存
          </button>
        </div>
      </div>
    </div>
  );
}
