import { Facet } from '@codemirror/state';
import type { PluginPerf } from '../../plugin-api';

/** 何も数えない計測（ctx.perf を渡されない使い方、単体テスト用）。 */
export const NO_PERF: PluginPerf = { enabled: false, span: () => () => {}, measure: (_name, fn) => fn(), record: () => {} };

/**
 * 性能の計測（R16）の口を、エディタの state に持たせる（部品が本体から貸された ctx.perf を、拡張の中から使うため）。
 * 区間の名前: markdown.decorations（行の装飾と記号の隠し方の組み立て全体）、markdown.live-markup（そのうち、隠す記号とリンクの範囲を決める部分）、
 * markdown.table-display（表の表示の組み立て）。
 */
export const perfFacet = Facet.define<PluginPerf, PluginPerf>({
  combine: (values) => values[0] ?? NO_PERF,
});
