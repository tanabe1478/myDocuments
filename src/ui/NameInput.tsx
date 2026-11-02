import { useEffect, useRef, useState } from 'react';

interface Props {
  /** 最初の値と、その選択範囲。 */
  initial: string;
  selection: readonly [number, number];
  /** 拒否の理由（あれば、入力欄の近くに出す）。 */
  error: string | null;
  busy: boolean;
  ariaLabel: string;
  /** Enter。 */
  onCommit(value: string): void;
  /** Esc。 */
  onCancel(): void;
  /** フォーカスが外れた。値が空なら取り消し、そうでなければ確定を、呼び出し側が決める。 */
  onBlurValue(value: string): void;
  onChange(): void;
}

/**
 * ツリーの中の名前の入力欄。Enter で確定、Esc で取り消し。IME の変換中（isComposing、keyCode 229）の Enter では確定しない。
 * 拒否の理由は入力欄の直下に出し、aria-invalid と aria-describedby で結ぶ。
 * 窓そのものがフォーカスを失った（別のアプリへ移った）ときの blur は、編集の終わりとして扱わない。
 */
export function NameInput({ initial, selection, error, busy, ariaLabel, onCommit, onCancel, onBlurValue, onChange }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const errorId = 'tree-name-error';

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(selection[0], selection[1]);
    // 最初の値と選択範囲は、入力欄ができたときだけ使う。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <input
        ref={ref}
        type="text"
        className="tree-name-input"
        data-testid="tree-name-input"
        aria-label={ariaLabel}
        aria-invalid={error !== null ? true : undefined}
        aria-describedby={error !== null ? errorId : undefined}
        value={value}
        readOnly={busy}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setValue(e.target.value);
          onChange();
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // 入力欄のキーは、ツリーやサイドバー（Esc で閉じる）に渡さない。
          e.stopPropagation();
          if (e.key === 'Enter') {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            onCommit(value);
          } else if (e.key === 'Escape') {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!document.hasFocus()) return;
          onBlurValue(value);
        }}
      />
      {error !== null && (
        <div id={errorId} className="tree-name-error" data-testid="tree-name-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
