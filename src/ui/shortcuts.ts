export type ShortcutAction =
  | 'new'
  | 'open'
  | 'save'
  | 'saveAs'
  | 'settings'
  | 'sidebar'
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
 * 新規 Mod+N、開く Mod+O、保存 Mod+S、別名保存 Mod+Shift+S、設定画面 Mod+,、サイドバー Mod+B。
 * 部品（src/plugin-api/）が登録したコマンドのショートカットは、ここでは扱わない（部品の一覧が持つ。ここの固定のショートカットが先に判定される）。
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
  if (!e.shiftKey && (e.key === ',' || e.code === 'Comma')) return 'settings';
  switch (letter) {
    case 'n':
      return e.shiftKey ? null : 'new';
    case 'o':
      return e.shiftKey ? null : 'open';
    case 's':
      return e.shiftKey ? 'saveAs' : 'save';
    case 'b':
      return e.shiftKey ? null : 'sidebar';
    default:
      return null;
  }
}

/**
 * キー入力の対象が、本文以外の文字入力欄（input・textarea・select・contenteditable）か。
 * CodeMirror の本文（.cm-content）は contenteditable だが、ここには含めない。
 * 検索パネルの入力欄など、本文の外にある欄は含める。
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  if (target.closest('.cm-content')) return false;
  if (target.closest('input, textarea, select')) return true;
  const editable = target.closest('[contenteditable]');
  return editable !== null && editable.getAttribute('contenteditable')?.toLowerCase() !== 'false';
}

/**
 * 部品のコマンドを、このキー入力の対象で実行してよいか。ignoreInTextEntry のコマンド（モードの切替）は、
 * 入力欄にフォーカスがあるときは実行しない。固定のショートカット（設定画面の開閉・サイドバー・保存・全画面など）は、
 * 入力欄でも従来どおり実行する。
 */
export function shouldRunPluginCommand(command: { readonly ignoreInTextEntry: boolean }, target: EventTarget | null): boolean {
  return !(command.ignoreInTextEntry && isTextEntryTarget(target));
}
