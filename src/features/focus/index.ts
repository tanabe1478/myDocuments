import { PLUGIN_API_VERSION, type Plugin } from '../../plugin-api';
import { focusModeExtension } from './focusMode';

/** 設定ファイル（preferences.json）の最上位のキー。これまでと同じ名前・同じ真偽値のまま保存する。 */
export const FOCUS_SETTING_KEY = 'focusMode';

/**
 * フォーカスモード（UI-06）: カーソルのある段落以外の行を弱く表示する。同梱の部品（段 3: エディタの中の拡張）。
 * 段落の分け方は文書の種類（markdown / plain）で変わるので、種類が変わると拡張を作り直してもらう。
 */
export const focusPlugin: Plugin = {
  manifest: {
    id: 'focus',
    name: 'フォーカスモード',
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    tier: 'editor',
  },
  activate(ctx) {
    const mode = ctx.registerSetting<boolean>({
      key: FOCUS_SETTING_KEY,
      defaultValue: false,
      normalize: (raw) => (typeof raw === 'boolean' ? raw : false),
    });
    ctx.registerEditorExtension({
      setting: mode,
      dependsOnTextKind: true,
      create: (on, { textKind }) => (on ? focusModeExtension(textKind) : []),
    });
    ctx.registerCommand({
      id: 'toggle',
      title: 'フォーカスモードの切り替え',
      shortcut: 'Mod+Shift+F',
      ignoreInTextEntry: true,
      run: ({ settings }) => settings.update(mode, (on) => !on),
    });
    ctx.registerSettingsItem({
      placement: 'appearance.writingAids',
      order: 100,
      kind: 'checkbox',
      setting: mode,
      label: 'フォーカスモード',
    });
  },
};
