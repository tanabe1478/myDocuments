import { PLUGIN_API_VERSION, type Plugin } from '../../plugin-api';
import { createTypingSoundE2EProbe } from './e2eProbe';
import { typingSoundExtension, volumeFacet } from './extension';
import { DEFAULT_VOLUME, createTypingSoundPlayer, isVolume } from './player';
import { SOUND_URLS } from './sounds';

/** 設定ファイル（preferences.json）の最上位のキー。 */
export const TYPING_SOUND_SETTING_KEY = 'typingSound';
export const TYPING_SOUND_VOLUME_SETTING_KEY = 'typingSoundVolume';

/**
 * タイピング音: キーを押すたびに、打鍵音（CC0 の録音。出典は sounds/README.md）を Web Audio で鳴らす。既定はオフ。
 * 同梱の部品（段 3: エディタの中の拡張）。設定がオフの間は、素材の fetch も AudioContext の生成もしない。
 */
export const typingSoundPlugin: Plugin = {
  manifest: {
    id: 'typing-sound',
    name: 'タイピング音',
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    tier: 'editor',
  },
  activate(ctx) {
    // e2e のビルドだけ、音の要求を数える（__E2E__ が false の本番では、この呼び出しごと取り除かれる）。
    const observe = __E2E__ ? createTypingSoundE2EProbe() : undefined;
    const player = createTypingSoundPlayer({ urls: SOUND_URLS, ...(observe ? { observe } : {}) });

    const enabled = ctx.registerSetting<boolean>({
      key: TYPING_SOUND_SETTING_KEY,
      defaultValue: false,
      normalize: (raw) => (typeof raw === 'boolean' ? raw : false),
    });
    const volume = ctx.registerSetting<string>({
      key: TYPING_SOUND_VOLUME_SETTING_KEY,
      defaultValue: DEFAULT_VOLUME,
      normalize: (raw) => (isVolume(raw) ? raw : DEFAULT_VOLUME),
    });
    ctx.registerEditorExtension({ setting: enabled, create: (on) => (on ? typingSoundExtension(player) : []) });
    ctx.registerEditorExtension({ setting: volume, create: (level) => volumeFacet.of(isVolume(level) ? level : DEFAULT_VOLUME) });
    // ショートカットは割り当てない（コマンドとしてだけ使える）。
    ctx.registerCommand({
      id: 'toggle',
      title: 'タイピング音の切り替え',
      run: ({ settings }) => settings.update(enabled, (on) => !on),
    });
    ctx.registerSettingsItem({
      placement: 'appearance.writingAids',
      order: 400,
      kind: 'checkbox',
      setting: enabled,
      label: 'タイピング音',
    });
    ctx.registerSettingsItem({
      placement: 'sound.body',
      order: 100,
      kind: 'radio',
      setting: volume,
      legend: 'タイピング音の大きさ',
      options: [
        { value: 'low', label: '小' },
        { value: 'medium', label: '中' },
        { value: 'high', label: '大' },
      ],
      hint: 'タイピング音は「外観」の「執筆の補助」でオンにします。',
    });
    // 部品を外すとき、AudioContext を閉じる。
    return () => player.dispose();
  },
};
