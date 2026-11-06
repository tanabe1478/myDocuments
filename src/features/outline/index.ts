import { PLUGIN_API_VERSION, type ActionPlugin } from '../../plugin-api';
import source from './worker.js?raw';

/**
 * 同梱の段 2 の部品「アウトライン」（ADR-005 の S1。R7 の最初の段）。Markdown の見出し（ATX 見出し # から ######）を、
 * 左サイドバーのパネルに一覧にする。見出しを押すと、本体がその行へカーソルを移す（部品はカーソルを動かせない）。
 * 権限: document.read（本文とカーソルの位置を受け取る。宣言だけで使える。確認の画面は出ない）。
 * Worker で動くコードは worker.js（?raw で文字列にして渡す）。
 */
export const outlinePlugin: ActionPlugin = {
  manifest: {
    id: 'outline',
    name: 'アウトライン',
    version: '0.1.0',
    apiVersion: PLUGIN_API_VERSION,
    tier: 'action',
    permissions: ['document.read'],
  },
  source,
};
