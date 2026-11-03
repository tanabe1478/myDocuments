import type { Plugin } from '../plugin-api';
import { typewriterPlugin } from './typewriter';

/**
 * 同梱の部品の一覧。ホストは、この一覧からだけ部品を読み込む（部品の個別の import はホストに書かない）。
 * 部品を足すときは、ここに 1 行足す。
 */
export const bundledPlugins: readonly Plugin[] = [typewriterPlugin];
