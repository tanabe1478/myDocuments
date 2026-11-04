import type { Plugin } from '../plugin-api';
import { focusPlugin } from './focus';
import { listContinuationPlugin } from './list-continuation';
import { markdownPlugin } from './markdown';
import { typewriterPlugin } from './typewriter';

/**
 * 同梱の部品の一覧。ホストは、この一覧からだけ部品を読み込む（部品の個別の import はホストに書かない）。
 * 部品を足すときは、ここに 1 行足す。エディタの拡張の重なりの順は、この並びの順（Markdown の見た目、フォーカスモード、
 * リストの継続、タイプライターモード）。Markdown の見た目を先頭に置くのは、これまで本体の言語の設定と一緒に先頭にあった
 * 装飾（行の装飾の class の並び）の重なりの順を変えないため。同じ優先度（Prec）の拡張どうしだけ、この順が効く。リストの継続の Enter は最優先
 * （Prec.highest）なので、並びの影響を受けない。
 */
export const bundledPlugins: readonly Plugin[] = [markdownPlugin, focusPlugin, listContinuationPlugin, typewriterPlugin];
