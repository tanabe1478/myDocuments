/** 音の種類。Enter だけ少し低い音にする。 */
export type SoundKind = 'key' | 'enter';

/** KeyboardEvent のうち、判定に使う部分（テストで作りやすいように、必要な項目だけ）。 */
export interface KeyEventLike {
  readonly key: string;
  readonly keyCode?: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat?: boolean;
}

/** 文字の入力ではない、修飾キーなどの名前（key の値）。単独で押しても鳴らさない。 */
const NON_SOUND_NAMED = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn', 'FnLock', 'NumLock', 'ScrollLock', 'OS', 'Super', 'Hyper', 'Symbol', 'SymbolLock']);

/** 文字の入力に準じて鳴らす、名前のあるキー（Space は key が ' ' で、1 文字として数える）。Enter は別の音。 */
const SOUND_NAMED = new Set(['Backspace', 'Delete', 'Tab', 'Dead']);

/** IME の変換中に届く keydown（Chromium は key が 'Process'、keyCode が 229。Safari と Android は key が別でも keyCode が 229）。 */
const isImeKey = (e: KeyEventLike) => e.key === 'Process' || e.keyCode === 229;

/**
 * keydown が音を鳴らすキーか。鳴らすなら音の種類、鳴らさないなら null。
 * - 鳴らす: 文字の入力になるキー（日本語入力の変換中を含む）、Space、Enter、Backspace、Delete、Tab。
 * - 鳴らさない: 修飾キーだけ、Cmd または Ctrl を伴うキー（ショートカット）、矢印などの移動キー、Escape、ファンクションキー。
 * Alt（macOS の Option）だけを伴うキーは、文字を入力するので鳴らす。繰り返し（repeat）は鳴らすキーとして扱う（間引きは再生側）。
 */
export function soundKindOf(e: KeyEventLike): SoundKind | null {
  if (e.metaKey || e.ctrlKey) return null;
  if (NON_SOUND_NAMED.has(e.key)) return null;
  if (e.key === 'Enter') return 'enter';
  if (isImeKey(e)) return 'key';
  if (SOUND_NAMED.has(e.key)) return 'key';
  // 1 文字（サロゲートペアの文字も 1 つと数える）。ArrowLeft、Escape、F5、Home などの名前は 2 文字以上なので外れる。
  return [...e.key].length === 1 ? 'key' : null;
}
