import { PLUGIN_API_VERSION, type ActionPlugin } from '../../plugin-api';
import source from './worker.js?raw';

/**
 * 同梱の段 2 の部品「パスをコピー」（ADR-005 の S2）。開いている文書のパス（Mod+Alt+C。パレットのコマンド）と、
 * ツリーで右クリックした行のパス（ファイルとフォルダ）を、クリップボードに書く。
 * 権限: paths.read（パスを知る）と clipboard.write（書く）。初回に、本体が確認の画面で聞く。
 * Worker で動くコードは worker.js（?raw で文字列にして渡す）。
 */
export const copyPathPlugin: ActionPlugin = {
  manifest: {
    id: 'copy-path',
    name: 'パスをコピー',
    version: '0.1.0',
    apiVersion: PLUGIN_API_VERSION,
    tier: 'action',
    permissions: ['clipboard.write', 'paths.read'],
  },
  source,
};
