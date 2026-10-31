import { DEFAULT_PREFERENCES } from './preferences';

/**
 * フォントの選択肢。同梱フォントはなく、OS にあるものを順に試す font-family。
 * 一覧にない指定は、外観パネルの自由入力で行う。
 */
export interface FontPreset {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export const FONT_PRESETS: readonly FontPreset[] = [
  { id: 'sans', label: 'ゴシック体（標準）', value: DEFAULT_PREFERENCES.fontFamily },
  {
    id: 'serif',
    label: '明朝体',
    value: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif CJK JP", "Noto Serif JP", serif',
  },
  {
    id: 'mono',
    label: '等幅',
    value: 'ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans Mono CJK JP", monospace',
  },
];

export function presetIdOf(fontFamily: string): string | null {
  return FONT_PRESETS.find((p) => p.value === fontFamily)?.id ?? null;
}
