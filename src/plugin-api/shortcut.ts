/** 部品のコマンドのショートカット。ホストの固定のショートカット（src/ui/shortcuts.ts の matchShortcut）と同じ判定の規則。 */

/** matchesShortcut が見る、KeyboardEvent の部分。 */
export interface KeyEventLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  /** AltGr（Windows と Linux の、右 Alt などで文字を入れる修飾）の判定に使う。KeyboardEvent は持っている。なければ AltGr とは見なさない。 */
  getModifierState?(key: string): boolean;
}

export interface ParsedShortcut {
  /** 小文字の ASCII 英字 1 文字、または ','。 */
  readonly key: string;
  readonly shift: boolean;
  /** 'Mod+Alt+C' の形のとき true（ADR-005 の R6）。Alt を使わない形では、この項目はない。 */
  readonly alt?: true;
  /** 正規化した表記（'Mod+Shift+T'、'Mod+Alt+C'）。 */
  readonly text: string;
}

export interface ParseShortcutOptions {
  /** true のとき、'Mod+Alt+<英字>' の形も読む（段 2 のコマンド）。既定は false（Alt つきは形が違う）。 */
  readonly allowAlt?: boolean;
}

/**
 * 'Mod+T'、'Mod+Shift+T'、'Mod+,' を読む。Mod が必須。形が違えば例外。
 * allowAlt のときは、'Mod+Alt+C'（Mod と Alt と英字 1 文字だけ。Shift や ',' とは組み合わせない）も読む。
 * Shift と Alt を組み合わせない理由: macOS の Option+Shift は、Option だけのときとは別の文字になり、物理キーで判定しても
 * 既存のショートカットや OS の割り当てと重なりやすいので、選ばなかった（ADR-005 の R6）。
 */
export function parseShortcut(text: string, options: ParseShortcutOptions = {}): ParsedShortcut {
  const parts = text.split('+');
  const key = parts.pop() ?? '';
  const mods = new Set(parts);
  const allowed = options.allowAlt ? ['Mod', 'Shift', 'Alt'] : ['Mod', 'Shift'];
  const valid = parts.length === mods.size && [...mods].every((m) => allowed.includes(m));
  const alt = mods.has('Alt');
  if (!valid || !mods.has('Mod') || !/^[A-Za-z,]$/.test(key) || (alt && (mods.has('Shift') || key === ','))) {
    throw new Error(
      `invalid shortcut: ${JSON.stringify(text)} (expected "Mod+T", "Mod+Shift+T" or "Mod+,"${options.allowAlt ? ', or "Mod+Alt+C"' : ''})`,
    );
  }
  const shift = mods.has('Shift');
  return {
    key: key.toLowerCase(),
    shift,
    ...(alt ? { alt: true as const } : {}),
    text: `Mod+${shift ? 'Shift+' : ''}${alt ? 'Alt+' : ''}${key.toUpperCase()}`,
  };
}

/**
 * AltGr（Windows と Linux で、Ctrl+Alt として届くことがある文字入力の修飾）による入力か。
 * getModifierState('AltGraph') が true、または Ctrl と Alt が同時に押され、key が英字でない印字できる 1 文字（AltGr で入れた記号や文字）。
 * macOS には AltGr はない（Option の文字は、key が英字にならないが、Ctrl は押されていない）。
 */
export function isAltGraphInput(e: KeyEventLike): boolean {
  if (e.getModifierState?.('AltGraph')) return true;
  return e.ctrlKey && e.altKey && e.key.length === 1 && !/^[A-Za-z]$/.test(e.key);
}

/**
 * macOS は Cmd、それ以外は Ctrl を Mod とする。IME の変換中のキーは対象にしない。
 * Alt を使わない形は、Alt つきのキーを対象にしない。Alt を使う形（'Mod+Alt+C'）は、Alt が押されていることが要り、
 * AltGr による入力には合わない。macOS の Option つきは key が英字にならない（Option+C は 'ç'）ので、物理キー（code）で判定する。
 */
export function matchesShortcut(shortcut: ParsedShortcut, e: KeyEventLike, mac: boolean): boolean {
  if (e.isComposing || e.keyCode === 229) return false;
  const primary = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!primary || e.altKey !== (shortcut.alt === true) || e.shiftKey !== shortcut.shift) return false;
  if (shortcut.alt && isAltGraphInput(e)) return false;
  if (shortcut.key === ',') return e.key === ',' || e.code === 'Comma';
  const physical = /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase();
  // macOS の Option つきは、key が Option で入る文字（'ç'、'Dead'）になるので、物理キーだけで判定する。
  if (shortcut.alt && mac) return physical === shortcut.key;
  // 論理キーを優先し、ASCII の英字でない配列（日本語入力オンなど）のときは物理キーで判定する。
  const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : physical;
  return letter === shortcut.key;
}
