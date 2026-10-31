import { useEffect } from 'react';
import type { Notice } from '../document/controller';

export interface ToastNotice extends Notice {
  id: number;
}

const DURATION_MS = { info: 6000, error: 12000 } as const;

export function Toast({ notice, onDismiss }: { notice: ToastNotice | null; onDismiss(id: number): void }) {
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => onDismiss(notice.id), DURATION_MS[notice.kind]);
    return () => clearTimeout(timer);
  }, [notice, onDismiss]);

  // 領域自体は常に置く（スクリーンリーダーが、後から入る文言を読み上げられるように）。
  return (
    <div className="toast-region" role={notice?.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
      {notice && (
        <button
          type="button"
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
