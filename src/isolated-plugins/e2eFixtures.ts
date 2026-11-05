import { PLUGIN_API_VERSION, type ActionPlugin } from '../plugin-api';

/**
 * e2e のビルドだけが読み込む、段 2 のテスト用の部品（tests/e2e/isolated-plugins.spec.ts）。
 * 本番のビルドには入らない（呼び出しが __E2E__ の中にあり、印の文字列 __mdeE2EActionFixture が dist に出ないことを CI が見る）。
 * source は、Worker の中で動くコードの文字列。
 */
const MARK = '__mdeE2EActionFixture';
/** 本体のページの origin。部品のコードが、同じ origin へのネットワークが止まっていることを確かめる。 */
const PAGE = location.origin;

const fixture = (id: string, source: string, permissions?: readonly string[]): ActionPlugin => ({
  manifest: { id, name: `${MARK} ${id}`, version: '0.0.0', apiVersion: PLUGIN_API_VERSION, tier: 'action', ...(permissions ? { permissions } : {}) } as ActionPlugin['manifest'],
  source,
});

export const e2eActionPlugins: readonly ActionPlugin[] = [
  // 正常: ショートカットで実行され、非同期に終わる（本体は done を受け取る）。
  fixture(
    'e2e-ok',
    `api.registerCommand({ id: 'record', title: '記録', shortcut: 'Mod+Shift+E', run: async () => { await new Promise((r) => setTimeout(r, 250)); } });`,
  ),
  // 実行が例外を出す。
  fixture('e2e-throws', `api.registerCommand({ id: 'boom', title: '例外', shortcut: 'Mod+Shift+X', run: async () => { throw new Error('boom'); } });`),
  // 実行が終わらない（無限ループ）。
  fixture('e2e-loop', `api.registerCommand({ id: 'spin', title: '無限ループ', shortcut: 'Mod+Shift+M', run: () => { for (;;) {} } });`),
  // 最初の実行（トップレベル）で例外。
  fixture('e2e-activate-throws', `api.registerCommand({ id: 'never', title: 'never', run: async () => {} });\nthrow new Error('activate boom');`),
  // 形の違うメッセージを送る（決めていない種類）。
  fixture('e2e-bogus', `api.registerCommand({ id: 'bogus', title: 'bogus', shortcut: 'Mod+Shift+Q', run: async () => {} });\nself.postMessage({ kind: 'steal', what: 'everything' });`),
  // 本体の段 3 のコマンド（フォーカスモード Mod+Shift+F）とショートカットが重なる。
  fixture('e2e-clash', `api.registerCommand({ id: 'clash', title: '重なり', shortcut: 'Mod+Shift+F', run: async () => {} });`),
  // 本体のページの DOM と window、ネットワーク、保存領域に届かないことを、Worker の中から確かめる（届けば例外 = 止まる）。
  fixture(
    'e2e-reach',
    `api.registerCommand({ id: 'reach', title: '到達', shortcut: 'Mod+Shift+Y', run: async () => {
      const fail = (what) => { throw new Error('reachable: ' + what); };
      if (typeof document !== 'undefined') fail('document');
      if (typeof window !== 'undefined') fail('window');
      if (typeof parent !== 'undefined') fail('parent');
      if (typeof localStorage !== 'undefined') fail('localStorage');
      if (typeof __TAURI_INTERNALS__ !== 'undefined') fail('__TAURI_INTERNALS__');
      if (self.origin !== 'null') fail('origin ' + self.origin);
      const blocked = (p) => p.then(() => false, () => true);
      if (!(await blocked(fetch('${PAGE}/')))) fail('fetch of the page origin');
      if (!(await blocked(fetch('http://127.0.0.1:1/')))) fail('fetch of 127.0.0.1');
      const xhr = await new Promise((resolve) => { const x = new XMLHttpRequest(); x.onload = () => resolve('loaded'); x.onerror = () => resolve('blocked'); x.open('GET', '${PAGE}/'); x.send(); });
      if (xhr !== 'blocked') fail('XMLHttpRequest of the page origin');
      try { importScripts('blob:null/x'); fail('importScripts(blob:)'); } catch (e) { if (String(e.message).startsWith('reachable')) throw e; }
      // 部品のコードは、Worker の中でも eval できない（作った文脈の CSP を継承する。script-src に unsafe-eval がない）。
      try { new Function('return 1')(); fail('eval'); } catch (e) { if (String(e.message).startsWith('reachable')) throw e; }
    } });`,
  ),
  // R6: 権限を宣言していない部品が、権限の要る API を呼ぶ（確認の画面は出ず、呼び出しだけが reject される。部品は止まらない）。
  fixture(
    'e2e-undeclared',
    `api.registerCommand({ id: 'try', title: 'try', shortcut: 'Mod+Shift+J', run: async () => {
      for (const attempt of [() => api.clipboard.writeText('x'), () => api.document.currentPath()]) {
        try { await attempt(); throw new Error('the call was not refused'); } catch (e) { if (String(e.message) === 'the call was not refused') throw e; }
      }
    } });`,
  ),
  // R6: 不正な形の呼び出し（決めていない method）。仲介が、その部品を止める。
  fixture(
    'e2e-bad-call',
    `api.registerCommand({ id: 'bad', title: 'bad', shortcut: 'Mod+Shift+U', run: async () => {} });
     self.postMessage({ kind: 'call', call: 1, method: 'readClipboard' });`,
    ['clipboard.write'],
  ),
  // R6: paths.read を宣言せずに、メニューの項目を登録する（登録を拒否して、その部品を止める）。
  fixture('e2e-menu-undeclared', `api.registerContextMenuItem({ id: 'x', title: 'x', where: 'tree', run: async () => {} });`, ['clipboard.write']),
  // R6: 知らない権限を宣言する（その部品を読み込まない）。
  fixture('e2e-unknown-permission', `api.registerCommand({ id: 'never', title: 'never', run: async () => {} });`, ['clipboard.write', 'network']),
];
