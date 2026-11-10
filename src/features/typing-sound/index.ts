import { PLUGIN_API_VERSION, type Plugin } from '../../plugin-api';
import { createTypingSoundE2EProbe } from './e2eProbe';
import { timbreFacet, typingSoundExtension, volumeFacet } from './extension';
import { DEFAULT_TIMBRE, DEFAULT_VOLUME, createTypingSoundPlayer, isTimbre, isVolume } from './player';
import { SOUND_URLS } from './sounds';

/** 設定ファイル（preferences.json）の最上位のキー。 */
export const TYPING_SOUND_SETTING_KEY = 'typingSound';
export const TYPING_SOUND_VOLUME_SETTING_KEY = 'typingSoundVolume';
export const TYPING_SOUND_TIMBRE_SETTING_KEY = 'typingSoundTimbre';

/**
 * タイピング音: キーを押すたびに、打鍵音（CC0 の録音。出典は sounds/README.md と sounds/typewriter/README.md）を Web Audio で鳴らす。既定はオフ。
 * 音色はキーボード（既定）とタイプライター。同梱の部品（段 3: エディタの中の拡張）。設定がオフの間は、素材の fetch も AudioContext の生成もしない。
 * オンのときは、選んでいる音色の素材だけを読む。
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
    // ログ（ADR-007）は、本体が貸す ctx.log（source は typing-sound に固定）。性能の計測（R16）は ctx.perf。どちらも無効の間は何もしない。
    const player = createTypingSoundPlayer({ urls: SOUND_URLS, log: ctx.log, perf: ctx.perf, ...(observe ? { observe } : {}) });

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
    const timbre = ctx.registerSetting<string>({
      key: TYPING_SOUND_TIMBRE_SETTING_KEY,
      defaultValue: DEFAULT_TIMBRE,
      normalize: (raw) => (isTimbre(raw) ? raw : DEFAULT_TIMBRE),
    });
    // 音色の拡張は、オンの拡張より先に登録する。本体は、起動時に保存済みの設定を登録の順に 1 つずつ適用するので、
    // 先にオンが入ると、まだ既定のキーボードのまま素材を読み始めてしまう（保存済みの音色がタイプライターのとき、キーボードの素材まで読む）。
    ctx.registerEditorExtension({ setting: timbre, create: (kind) => timbreFacet.of(isTimbre(kind) ? kind : DEFAULT_TIMBRE) });
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
    // 「音」の節では、音色を音量の前に置く。
    ctx.registerSettingsItem({
      placement: 'sound.body',
      order: 50,
      kind: 'radio',
      setting: timbre,
      legend: 'タイピング音の音色',
      options: [
        { value: 'keyboard', label: 'キーボード' },
        { value: 'typewriter', label: 'タイプライター' },
      ],
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
