import { useEffect, useId, useRef } from 'react';
import { AppearanceSettings, type AppearanceSettingsProps } from './AppearanceSettings';
import { EditingSettings } from './EditingSettings';
import { PluginPermissionsSettings, type PluginPermissionsSettingsProps } from './PluginPermissionsSettings';

export interface SettingsDialogProps extends AppearanceSettingsProps {
  onClose(): void;
  /** 「部品の権限」の節（段 2 の部品の、利用者が決めた権限）。渡さなければ、節を出さない。 */
  pluginPermissions?: PluginPermissionsSettingsProps;
}

/** 開いたときにフォーカスする、最初の設定項目（閉じるボタンではなく）。 */
const FIRST_CONTROL = 'select, input, textarea';
const FOCUSABLE = 'button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Tab で実際に止まる要素。同じ名前のラジオは、選択中の 1 つにだけ止まる（未選択のラジオには Tab で届かない）。
 * DOM 順の最後が未選択のラジオだと、「最後の項目」を取り違えて、Tab がダイアログの外へ出てしまう。
 */
function tabStops(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if ((el as HTMLButtonElement).disabled || el.getClientRects().length === 0) return false;
    if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || el.checked || el.name === '') return true;
    return !root.querySelector(`input[type="radio"][name="${CSS.escape(el.name)}"]:checked`);
  });
}

/**
 * 設定画面。窓の中央に出るモーダルの dialog。いまの節は「外観」「編集」「部品の権限」（節は SettingsDialog の本文に並べて足す）。
 * 背景の幕は薄く、変更はすぐ本文に反映されるので、後ろの本文の変化が見える。
 * 開いたら最初の設定項目にフォーカスし、Tab は中で循環し、Esc・閉じるボタン・幕のクリックで閉じる。
 * フォーカスの戻り先は App が管理する。高さが窓に収まらないときは、本文（設定項目）の部分がスクロールする。
 */
export function SettingsDialog({ onClose, pluginPermissions, ...appearance }: SettingsDialogProps) {
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
    const root = rootRef.current;
    if (!root) return;
    const items = tabStops(root);
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    // 最後より後ろ（Tab で止まらない未選択のラジオなど）や、最初より前にいるときも、端として扱う。
    const after = (a: Element, b: Element | undefined) => !!b && !!(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
    const before = (a: Element, b: Element | undefined) => !!b && !!(b.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_PRECEDING);
    const outside = !active || !root.contains(active);
    if (e.shiftKey && (outside || active === first || before(active, first))) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && (outside || active === last || after(active, last))) {
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
          <EditingSettings prefs={appearance.prefs} onChange={appearance.onChange} settingsItems={appearance.settingsItems} />
          {pluginPermissions && <PluginPermissionsSettings {...pluginPermissions} />}
        </div>
      </section>
    </div>
  );
}
