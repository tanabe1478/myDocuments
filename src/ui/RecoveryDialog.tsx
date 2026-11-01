import { useEffect, useRef } from 'react';
import type { RecoveryChoice } from '../document/controller';

interface Props {
  /** 文書名（保存先のない草稿は「無題」）。 */
  documentName: string;
  updatedAt: number;
  /** ほかの草稿の件数。 */
  others: number;
  onChoose(choice: RecoveryChoice): void;
}

const FORMAT = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });

/** 起動時の、未保存の草稿の復旧の確認。Esc は「あとで」。 */
export function RecoveryDialog({ documentName, updatedAt, others, onChoose }: Props) {
  const restoreRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    restoreRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onChoose('later');
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
        aria-labelledby="recovery-title"
        aria-describedby="recovery-body"
        data-testid="recovery-dialog"
        onKeyDown={onKeyDown}
      >
        <h2 id="recovery-title">前回の未保存の草稿があります</h2>
        <p id="recovery-body">
          <span data-testid="recovery-name">{documentName}</span>
          （<span data-testid="recovery-time">{FORMAT.format(new Date(updatedAt))}</span>）
          {others > 0 && <span data-testid="recovery-others">　ほかに {others} 件の草稿があります。</span>}
        </p>
        <div className="dialog-actions">
          <button type="button" data-testid="recovery-later" onClick={() => onChoose('later')}>
            あとで
          </button>
          <button type="button" data-testid="recovery-discard" onClick={() => onChoose('discard')}>
            破棄する
          </button>
          <button type="button" data-testid="recovery-restore" ref={restoreRef} className="primary" onClick={() => onChoose('restore')}>
            復元する
          </button>
        </div>
      </div>
    </div>
  );
}
