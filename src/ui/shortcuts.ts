export type ShortcutAction =
  | 'new'
  | 'open'
  | 'save'
  | 'saveAs'
  | 'appearance'
  | 'focusMode'
  | 'typewriterMode'
  | 'fullscreen';

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
 * macOS は Cmd、それ以外は Ctrl（以下 Mod）。
 * 新規 Mod+N、開く Mod+O、保存 Mod+S、別名保存 Mod+Shift+S、外観パネル Mod+,、
 * フォーカスモード Mod+Shift+F、タイプライターモード Mod+Shift+T。
 * 全画面は macOS が Ctrl+Cmd+F、Windows / Linux が F11（各 OS の標準）。
 * 検索の Mod+F（Shift なし）は CodeMirror の持ち物なので、ここでは扱わない。
 * IME の変換中のキーは対象にしない。
 */
export function matchShortcut(e: KeyLike, mac: boolean): ShortcutAction | null {
  if (e.isComposing || e.keyCode === 229) return null;
  // 論理キーを優先し、ASCII の英字でない配列（日本語入力オンなど）のときは物理キーで判定する。
  const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : /^Key([A-Z])$/.exec(e.code)?.[1]?.toLowerCase();

  if (mac) {
    if (e.metaKey && e.ctrlKey && !e.altKey && !e.shiftKey && letter === 'f') return 'fullscreen';
  } else if (e.key === 'F11' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    return 'fullscreen';
  }

  const primary = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!primary || e.altKey) return null;
  if (!e.shiftKey && (e.key === ',' || e.code === 'Comma')) return 'appearance';
  switch (letter) {
    case 'n':
      return e.shiftKey ? null : 'new';
    case 'o':
      return e.shiftKey ? null : 'open';
    case 's':
      return e.shiftKey ? 'saveAs' : 'save';
    case 'f':
      return e.shiftKey ? 'focusMode' : null;
    case 't':
      return e.shiftKey ? 'typewriterMode' : null;
    default:
      return null;
  }
}
