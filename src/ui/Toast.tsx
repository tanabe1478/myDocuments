import { useEffect, useRef } from 'react';
import type { Notice } from '../document/controller';
import type { ToastLayout } from './toastLayout';

export interface ToastNotice extends Notice {
  id: number;
}

const DURATION_MS = { info: 6000, error: 12000 } as const;
/** 本文に重ねて表示するとき、トーストの上端の上に足す余白（スクロールの余白に含める）。 */
const OVERLAY_GAP_PX = 8;

interface Props {
  notice: ToastNotice | null;
  /** 置き場所（本文の列の外 / 本文に重ねる）。App が、窓の幅と外観パネルから決める（toastLayout.ts）。 */
  layout: ToastLayout;
  onDismiss(id: number): void;
  /**
   * 本文に重ねて表示しているとき、本文の下側を覆っている高さ（px）。出ていない・列の外にあるときは 0。
   * 本文の高さは変えず、エディタのスクロールの余白に使う（カーソル行がトーストの下に隠れないように）。
   */
  onCoveredHeight(px: number): void;
}

export function Toast({ notice, layout, onDismiss, onCoveredHeight }: Props) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const present = notice !== null;
  const overlay = layout.placement === 'overlay';

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => onDismiss(notice.id), DURATION_MS[notice.kind]);
    return () => clearTimeout(timer);
  }, [notice, onDismiss]);

  // 本文に重ねているあいだ、トーストが覆う高さ（.app の下端からトーストの上端まで）を知らせる。
  useEffect(() => {
    const el = buttonRef.current;
    if (!present || !overlay || !el) {
      onCoveredHeight(0);
      return;
    }
    const report = () => {
      const app = el.closest('.app');
      if (!app) return;
      onCoveredHeight(Math.max(0, app.getBoundingClientRect().bottom - el.getBoundingClientRect().top) + OVERLAY_GAP_PX);
    };
    report();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(report) : null;
    observer?.observe(el);
    window.addEventListener('resize', report);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', report);
      onCoveredHeight(0);
    };
  }, [present, overlay, notice?.id, onCoveredHeight]);

  // 領域自体は常に置く（スクリーンリーダーが、後から入る文言を読み上げられるように）。
  return (
    <div
      className="toast-region"
      data-placement={layout.placement}
      style={overlay ? undefined : ({ '--md-toast-width': `${layout.width}px` } as React.CSSProperties)}
      role={notice?.kind === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      {notice && (
        <button
          type="button"
          ref={buttonRef}
          className={`toast toast-${notice.kind}`}
          data-testid="toast"
          title="クリックで閉じる"
          onClick={() => onDismiss(notice.id)}
        >
          {notice.message}
        </button>
      )}
    </div>
  );
}
