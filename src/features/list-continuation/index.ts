import { PLUGIN_API_VERSION, type Plugin } from '../../plugin-api';
import { listContinuationExtension, type ListContinuation } from './listContinuation';

/** 設定ファイル（preferences.json）の最上位のキー。これまでと同じ名前・同じ文字列の値のまま保存する。 */
export const LIST_CONTINUATION_SETTING_KEY = 'listContinuation';

const MODES: readonly ListContinuation[] = ['tight', 'preserve'];

/**
 * リストの継続（Run 11）: リストの項目で Enter を押したとき、次の項目を続ける。空行を入れるかを設定で選ぶ。
 * 同梱の部品（段 3: エディタの中の拡張）。
 * Enter の優先順位: tight のときだけ、拡張が最優先（Prec.highest）の Enter のキー割り当てを足す。preserve は
 * 何も足さず、lang-markdown の既定の Enter に任せる。優先度は Prec が決めるので、部品の並び順には依存しない。
 */
export const listContinuationPlugin: Plugin = {
  manifest: {
    id: 'list-continuation',
    name: 'リストの継続',
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    tier: 'editor',
  },
  activate(ctx) {
    const mode = ctx.registerSetting<ListContinuation>({
      key: LIST_CONTINUATION_SETTING_KEY,
      defaultValue: 'tight',
      normalize: (raw) => (MODES.includes(raw as ListContinuation) ? (raw as ListContinuation) : 'tight'),
    });
    ctx.registerEditorExtension({
      setting: mode,
      create: (value) => listContinuationExtension(value),
    });
    ctx.registerSettingsItem({
      placement: 'editing.body',
      order: 100,
      kind: 'radio',
      setting: mode,
      legend: 'リストの継続',
      options: [
        { value: 'tight', label: '空行を入れない' },
        { value: 'preserve', label: 'リストの形に合わせる' },
      ],
      hint: '空行で区切ったリストで Enter を押したとき、次の項目の前にも空行を入れるか',
    });
  },
};
