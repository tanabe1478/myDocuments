import type { Plugin } from '../plugin-api';
import { focusPlugin } from './focus';
import { typewriterPlugin } from './typewriter';

/**
 * 同梱の部品の一覧。ホストは、この一覧からだけ部品を読み込む（部品の個別の import はホストに書かない）。
 * 部品を足すときは、ここに 1 行足す。エディタの拡張の重なりの順は、この並びの順（フォーカスモードが先）。
 */
export const bundledPlugins: readonly Plugin[] = [focusPlugin, typewriterPlugin];
