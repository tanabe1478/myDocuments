export type ShortcutAction = 'new' | 'open' | 'save' | 'saveAs';

/** matchShortcut が見る、KeyboardEvent の部分。 */
export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export function isMacPlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac/i.test(nav.userAgentData?.platform ?? nav.platform ?? '');
}

/**
 * macOS は Cmd、それ以外は Ctrl。新規 N、開く O、保存 S、別名保存 Shift+S。
 * IME の変換中のキーは対象にしない。
 */
export function matchShortcut(e: KeyLike, mac: boolean): ShortcutAction | null {
  if (e.isComposing || e.keyCode === 229) return null;
  const primary = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!primary || e.altKey) return null;
  // 論理キーを優先し、ASCII の英字でない配列（日本語入力オンなど）のときは物理キーで判定する。
  const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase();
  switch (letter) {
    case 'n':
      return e.shiftKey ? null : 'new';
    case 'o':
      return e.shiftKey ? null : 'open';
    case 's':
      return e.shiftKey ? 'saveAs' : 'save';
    default:
      return null;
  }
}
