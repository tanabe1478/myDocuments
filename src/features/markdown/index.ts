import { PLUGIN_API_VERSION, type Plugin } from '../../plugin-api';
import { linkOpenExtension } from './linkOpen';
import { markdownDecorations } from './markdownDecorations';
import { DEFAULT_MARKUP_DISPLAY, MARKUP_DISPLAY_SETTING_KEY, normalizeMarkupDisplay, type MarkupDisplay } from './markupDisplay';
import { tableDisplay } from './tableDisplay';
import { tableKeys } from './tableKeys';
import { taskToggleExtension } from './taskToggle';
import { markdownTheme } from './theme';

/**
 * Markdown の見た目（見出し・強調・リンクなどの装飾、記法記号の隠し方 ADR-004、チェックボックスのクリック、
 * ⌘/Ctrl+クリックでリンクを開く操作、表の表示と Tab でのセルの移動 ADR-006）。同梱の部品（段 3: エディタの中の拡張）。
 *
 * 本体との約束（ADR-005 の R4）:
 * - Markdown の文書には、本体が Markdown の言語（構文木）を入れる。この部品はその構文木を読むだけで、言語は入れない。
 * - 素のテキスト（.txt、.text）には何も足さない（文書の種類に依存する拡張）。素のテキストの空行の高さは本体が付ける。
 * - リンクを開くのは、本体が貸す『外部の URL を開く』だけを使う（利用者の ⌘/Ctrl+クリックのときだけ呼ぶ）。
 *   OS の判定も、本体が貸すものを使う。
 */
export const markdownPlugin: Plugin = {
  manifest: {
    id: 'markdown',
    name: 'Markdown の見た目',
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    tier: 'editor',
  },
  activate(ctx) {
    const display = ctx.registerSetting<MarkupDisplay>({
      key: MARKUP_DISPLAY_SETTING_KEY,
      defaultValue: DEFAULT_MARKUP_DISPLAY,
      normalize: normalizeMarkupDisplay,
    });
    ctx.registerEditorExtension({
      setting: display,
      dependsOnTextKind: true,
      create: (value, { textKind, openExternalUrl, isMacPlatform }) =>
        textKind === 'plain'
          ? []
          : [markdownDecorations(value), tableDisplay(), tableKeys(), linkOpenExtension(openExternalUrl, isMacPlatform), taskToggleExtension(), markdownTheme],
    });
    ctx.registerSettingsItem({
      placement: 'appearance.body',
      // 本体の項目は 100 刻み。「紙の幅」（300）と「テーマ」（400）の間。
      order: 350,
      kind: 'radio',
      setting: display,
      legend: '記号の表示',
      options: [
        { value: 'cursorLine', label: 'カーソルのある行だけ' },
        { value: 'always', label: '常に表示' },
      ],
      hint: 'Markdown の # や * などの記号を、どの行で見せるか。「カーソルのある行だけ」では、ほかの行は記号を隠して整形して表示します（文書の中身は変わりません）。',
    });
  },
};
