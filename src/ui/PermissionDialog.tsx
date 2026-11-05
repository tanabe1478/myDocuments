import { useEffect, useId, useRef } from 'react';
import { PERMISSION_DESCRIPTIONS, type PermissionOutcome } from '../plugin-api';
import type { PermissionPrompt } from '../permissions/controller';

interface Props {
  prompt: PermissionPrompt;
  onChoose(choice: PermissionOutcome): void;
}

/**
 * 部品の権限の確認（ADR-005 の R6）。部品の名前と、権限ごとの説明を出し、「許可する」「許可しない」を聞く。
 * 既定のフォーカスは「許可しない」。Esc と閉じるボタンは、決めずに閉じる（今回だけ断る。保存せず、次の使用で再び聞く）。
 * 閉じたら、開く前にフォーカスのあった場所へ戻す（なければ呼び出し元の App が本文に戻す）。
 */
export function PermissionDialog({ prompt, onChoose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    denyRef.current?.focus();
    return () => {
      if (previous?.isConnected && previous !== document.body) previous.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onChoose('dismissed');
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
        className="dialog permission-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="permission-dialog"
        onKeyDown={onKeyDown}
      >
        <button type="button" className="permission-close" data-testid="permission-close" aria-label="閉じる（今回だけ断る）" onClick={() => onChoose('dismissed')}>
          ×
        </button>
        <h2 id={titleId}>部品の権限の確認</h2>
        <p id={bodyId}>
          部品「<span data-testid="permission-plugin-name">{prompt.pluginName}</span>」が、次の操作を使おうとしています。
        </p>
        <ul className="permission-list" data-testid="permission-list">
          {prompt.permissions.map((permission) => (
            <li key={permission} data-permission={permission}>
              {PERMISSION_DESCRIPTIONS[permission]}
            </li>
          ))}
        </ul>
        <p className="permission-note">決めた結果は保存されます。設定の「部品の権限」から取り消せます。</p>
        <div className="dialog-actions">
          <button type="button" data-testid="permission-deny" ref={denyRef} onClick={() => onChoose('denied')}>
            許可しない
          </button>
          <button type="button" data-testid="permission-allow" className="primary" onClick={() => onChoose('granted')}>
            許可する
          </button>
        </div>
      </div>
    </div>
  );
}
