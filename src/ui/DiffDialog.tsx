import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useEffect, useRef } from 'react';

interface Props {
  /** 自分の本文。 */
  mine: string;
  /** ディスクの内容。 */
  disk: string;
  onClose(): void;
}

/** 自分の本文とディスクの内容の差分（@codemirror/merge）。読み取り専用。Esc で閉じる。 */
export function DiffDialog({ mine, disk, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const host = hostRef.current;
    if (!host) return;
    let destroyed = false;
    let destroy = () => {};
    // 差分表示は、使うときまで読み込まない。
    void import('@codemirror/merge').then(({ MergeView }) => {
      if (destroyed) return;
      const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping];
      const view = new MergeView({
        a: { doc: mine, extensions: readOnly },
        b: { doc: disk, extensions: readOnly },
        parent: host,
        highlightChanges: true,
        gutter: true,
      });
      destroy = () => view.destroy();
    });
    return () => {
      destroyed = true;
      destroy();
    };
  }, [mine, disk]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="dialog-backdrop">
      <div
        className="dialog diff-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diff-title"
        data-testid="diff-dialog"
        onKeyDown={onKeyDown}
      >
        <h2 id="diff-title">自分の版とディスクの版の差分</h2>
        <div className="diff-labels" aria-hidden="true">
          <span>自分の版（左）</span>
          <span>ディスクの版（右）</span>
        </div>
        <div className="diff-host" ref={hostRef} data-testid="diff-host" />
        <div className="dialog-actions">
          <button type="button" data-testid="diff-close" ref={closeRef} className="primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
