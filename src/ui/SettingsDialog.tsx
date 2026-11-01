import { useEffect, useId, useRef } from 'react';
import { AppearanceSettings, type AppearanceSettingsProps } from './AppearanceSettings';

export interface SettingsDialogProps extends AppearanceSettingsProps {
  onClose(): void;
}

/** 開いたときにフォーカスする、最初の設定項目（閉じるボタンではなく）。 */
const FIRST_CONTROL = 'select, input, textarea';
const FOCUSABLE = 'button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * 設定画面。窓の中央に出るモーダルの dialog。いまの節は「外観」だけ（節は SettingsDialog の本文に並べて足す）。
 * 背景の幕は薄く、変更はすぐ本文に反映されるので、後ろの本文の変化が見える。
 * 開いたら最初の設定項目にフォーカスし、Tab は中で循環し、Esc・閉じるボタン・幕のクリックで閉じる。
 * フォーカスの戻り先は App が管理する。高さが窓に収まらないときは、本文（設定項目）の部分がスクロールする。
 */
export function SettingsDialog({ onClose, ...appearance }: SettingsDialogProps) {
  const rootRef = useRef<HTMLElement>(null);
  const titleId = useId();
  // 幕のクリックで閉じるのは、押したのも幕のときだけ（スライダーをドラッグして外で離しても閉じない）。
  const pressedOnBackdrop = useRef(false);

  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>(FIRST_CONTROL)?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    // フォーカスをダイアログ内に閉じ込める。
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0,
    );
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !rootRef.current?.contains(active))) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && (active === last || !rootRef.current?.contains(active))) {
      e.preventDefault();
      first?.focus();
    }
  };

  return (
    <div
      className="settings-backdrop"
      data-testid="settings-backdrop"
      onMouseDown={(e) => {
        pressedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedOnBackdrop.current) onClose();
        pressedOnBackdrop.current = false;
      }}
    >
      <section
        ref={rootRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="settings-dialog"
        onKeyDown={onKeyDown}
      >
        <header className="settings-header">
          <h2 id={titleId}>設定</h2>
          <button type="button" className="settings-close" data-testid="settings-close" onClick={onClose} aria-label="設定を閉じる">
            ×
          </button>
        </header>
        <div className="settings-body" data-testid="settings-body">
          <AppearanceSettings {...appearance} />
        </div>
      </section>
    </div>
  );
}
