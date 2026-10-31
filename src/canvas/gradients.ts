/**
 * 背景グラデーションのプリセット。配色は独自のもの（他製品の素材・配色を使わない）。
 * ライト・ダークそれぞれに、2 色の線形グラデーションと、コントラスト評価用の代表色を持つ。
 * 代表色は 2 色の中間色（テストで確かめる）。
 */
export type ThemeMode = 'light' | 'dark';

export interface GradientVariant {
  readonly from: string;
  readonly to: string;
  /** コントラスト評価に使う色。from と to の中間。 */
  readonly representative: string;
}

export interface GradientPreset {
  readonly id: string;
  readonly label: string;
  readonly light: GradientVariant;
  readonly dark: GradientVariant;
}

export const GRADIENTS = [
  {
    id: 'paper',
    label: '和紙',
    light: { from: '#f7f2e6', to: '#ebe4d2', representative: '#f1ebdc' },
    dark: { from: '#1c1e20', to: '#26292c', representative: '#212426' },
  },
  {
    id: 'dusk',
    label: '夕暮れ',
    light: { from: '#f3d9c4', to: '#c9b3d6', representative: '#dec6cd' },
    dark: { from: '#2a2038', to: '#4a2f45', representative: '#3a283f' },
  },
  {
    id: 'forest',
    label: '深い森',
    light: { from: '#d6e6d3', to: '#a9c9b3', representative: '#c0d8c3' },
    dark: { from: '#12201b', to: '#1f3a30', representative: '#192d26' },
  },
  {
    id: 'harbor',
    label: '港の夜明け',
    light: { from: '#d4e4ee', to: '#f0e0d0', representative: '#e2e2df' },
    dark: { from: '#0e1c2c', to: '#25445c', representative: '#1a3044' },
  },
  {
    id: 'ember',
    label: '熾火',
    light: { from: '#f4dccb', to: '#e9b9a0', representative: '#efcbb6' },
    dark: { from: '#1e1412', to: '#4a2318', representative: '#341c15' },
  },
] as const satisfies readonly GradientPreset[];

export type GradientId = (typeof GRADIENTS)[number]['id'];

export const DEFAULT_GRADIENT_ID: GradientId = 'paper';

export function isGradientId(value: unknown): value is GradientId {
  return GRADIENTS.some((g) => g.id === value);
}

export function gradientPreset(id: GradientId): GradientPreset {
  return GRADIENTS.find((g) => g.id === id) ?? GRADIENTS[0];
}

export function gradientVariant(id: GradientId, mode: ThemeMode): GradientVariant {
  return gradientPreset(id)[mode];
}

/** CSS の background に渡す値。 */
export function gradientCss(id: GradientId, mode: ThemeMode): string {
  const v = gradientVariant(id, mode);
  return `linear-gradient(160deg, ${v.from}, ${v.to})`;
}
