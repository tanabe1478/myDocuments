import { PLUGIN_API_VERSION, type Plugin } from '../../plugin-api';
import { typewriterModeExtension } from './typewriterMode';

/** 設定ファイル（preferences.json）の最上位のキー。これまでと同じ名前・同じ真偽値のまま保存する。 */
export const TYPEWRITER_SETTING_KEY = 'typewriterMode';

/** タイプライターモード（UI-07）: カーソル行を表示領域の縦中央に保つ。同梱の部品（段 3: エディタの中の拡張）。 */
export const typewriterPlugin: Plugin = {
  manifest: {
    id: 'typewriter',
    name: 'タイプライターモード',
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    tier: 'editor',
  },
  activate(ctx) {
    const mode = ctx.registerSetting<boolean>({
      key: TYPEWRITER_SETTING_KEY,
      defaultValue: false,
      normalize: (raw) => (typeof raw === 'boolean' ? raw : false),
    });
    ctx.registerEditorExtension({ setting: mode, create: (on) => (on ? typewriterModeExtension() : []) });
    ctx.registerCommand({
      id: 'toggle',
      title: 'タイプライターモードの切り替え',
      shortcut: 'Mod+Shift+T',
      ignoreInTextEntry: true,
      run: ({ settings }) => settings.update(mode, (on) => !on),
    });
    ctx.registerSettingsItem({
      placement: 'appearance.writingAids',
      order: 200,
      kind: 'checkbox',
      setting: mode,
      label: 'タイプライターモード',
    });
  },
};
