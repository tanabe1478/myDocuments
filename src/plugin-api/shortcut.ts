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
}

export interface ParsedShortcut {
  /** 小文字の ASCII 英字 1 文字、または ','。 */
  readonly key: string;
  readonly shift: boolean;
  /** 正規化した表記（'Mod+Shift+T'）。 */
  readonly text: string;
}

/** 'Mod+T'、'Mod+Shift+T'、'Mod+,' を読む。Mod が必須。形が違えば例外。 */
export function parseShortcut(text: string): ParsedShortcut {
  const parts = text.split('+');
  const key = parts.pop() ?? '';
  const mods = new Set(parts);
  const valid = parts.length === mods.size && [...mods].every((m) => m === 'Mod' || m === 'Shift');
  if (!valid || !mods.has('Mod') || !/^[A-Za-z,]$/.test(key)) {
    throw new Error(`invalid shortcut: ${JSON.stringify(text)} (expected "Mod+T", "Mod+Shift+T" or "Mod+,")`);
  }
  const shift = mods.has('Shift');
  return { key: key.toLowerCase(), shift, text: `Mod+${shift ? 'Shift+' : ''}${key.toUpperCase()}` };
}

/** macOS は Cmd、それ以外は Ctrl を Mod とする。Alt つきと、IME の変換中のキーは対象にしない。 */
export function matchesShortcut(shortcut: ParsedShortcut, e: KeyEventLike, mac: boolean): boolean {
  if (e.isComposing || e.keyCode === 229) return false;
  const primary = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!primary || e.altKey || e.shiftKey !== shortcut.shift) return false;
  if (shortcut.key === ',') return e.key === ',' || e.code === 'Comma';
  // 論理キーを優先し、ASCII の英字でない配列（日本語入力オンなど）のときは物理キーで判定する。
  const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase();
  return letter === shortcut.key;
}
