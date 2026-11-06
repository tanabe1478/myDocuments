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
  // R6b: 確認の画面を出させようとする部品。起動時（activate の中）、実行の外（タイマー）、同じ実行の 2 回目以降は、画面を出さずに reject される。
  // 画面が出てよいのは、利用者の操作で始まった実行（ショートカット、ツリーのメニューの項目）の中の最初の 1 回だけ。呼び出しの結果は
  // 本体の記録（__mdeE2EIsolatedTrace の result）で見る。
  fixture(
    'e2e-prompt-abuse',
    `api.clipboard.writeText('at-activate').catch(() => {});
     api.registerCommand({ id: 'burst', title: 'burst', shortcut: 'Mod+Shift+K', run: async () => {
       for (let i = 0; i < 3; i++) await api.document.currentPath().catch(() => null);
     } });
     api.registerCommand({ id: 'later', title: 'later', shortcut: 'Mod+Shift+L', run: async () => {
       setTimeout(() => { api.document.currentPath().catch(() => {}); }, 300);
     } });
     api.registerContextMenuItem({ id: 'burst', title: 'e2e-burst', where: 'tree', run: async () => {
       for (let i = 0; i < 3; i++) await api.clipboard.writeText('x' + i).catch(() => null);
     } });`,
    ['clipboard.write', 'paths.read'],
  ),
  // R7: パネルに、HTML に見える文字列を送る（見出し、項目、項目がないときの文言）。本体は文字として描き、HTML として解釈しない。
  // 解釈されると、img の onerror などで window.__e2ePwned が立つ。
  fixture(
    'e2e-panel-evil',
    `const panel = api.registerPanel({ id: 'evil', title: '<img src=x onerror="window.__e2ePwned = 1">' });
     panel.setItems([
       { text: '<img src=x onerror="window.__e2ePwned = 1">', depth: 0, offset: 0 },
       { text: '<script>window.__e2ePwned = 1</script>', depth: 1, offset: 0 },
       { text: '<a href="javascript:window.__e2ePwned = 1">link</a>', depth: 2, offset: 0 },
       { text: '"><svg onload=window.__e2ePwned=1>', depth: 7, offset: 0 },
     ], { version: 0 });`,
    ['document.read'],
  ),
  // R7: 受け取った本文の版・種類・長さと、カーソルの位置を、パネルに出す（document.read を宣言している。届いたことを画面で確かめる）。
  fixture(
    'e2e-panel-echo',
    `const panel = api.registerPanel({ id: 'echo', title: 'エコー' });
     let last = null; let position = null;
     const render = () => panel.setItems([
       ...(last ? [{ text: 'doc v' + last.version + ' ' + last.kind + ' ' + last.text.length, depth: 0, offset: 0 }] : []),
       ...(position ? [{ text: 'sel ' + position.anchor + '-' + position.head, depth: 0, offset: 0 }] : []),
     ], { version: last ? last.version : 0, emptyText: 'まだ何も受け取っていません' });
     api.document.onDidChange((d) => { last = d; render(); });
     api.document.onDidChangeSelection((s) => { position = s; render(); });
     render();`,
    ['document.read'],
  ),
  // R7: echo と同じだが、document.read を宣言していない。本文もカーソルの位置も届かない（届けば、画面の文字が変わる）。
  fixture(
    'e2e-panel-undeclared',
    `const panel = api.registerPanel({ id: 'undeclared', title: '宣言なし' });
     const show = (text) => panel.setItems([{ text, depth: 0, offset: 0 }], { version: 0 });
     api.document.onDidChange((d) => show('received doc ' + d.version));
     api.document.onDidChangeSelection((s) => show('received sel ' + s.head));
     show('何も受け取っていません');`,
  ),
  // R7: setItems の頻度の上限（1 秒に 30 回）を超える。
  fixture('e2e-panel-flood', `const panel = api.registerPanel({ id: 'flood', title: '連打' });\nfor (let i = 0; i < 40; i++) panel.setItems([], { version: i });`),
  // R7: 項目の数の上限（1000）を超える（Worker の API が拒否して、部品の最初の実行が例外になる）。
  fixture('e2e-panel-many', `const panel = api.registerPanel({ id: 'many', title: '多すぎる' });\npanel.setItems(Array.from({ length: 1001 }, (_, i) => ({ text: 'x' + i, depth: 0, offset: 0 })), { version: 0 });`),
  // R7: 決めていない形のメッセージ（登録していないパネルの項目）を、API を通さずに送る（仲介が止める）。
  fixture('e2e-panel-bogus', `api.registerPanel({ id: 'bogus', title: 'bogus' });\nself.postMessage({ kind: 'items', panel: 'nope', version: 0, items: [], current: null, empty: null });`),
  // R7: カーソルを動かそうとする（そのためのメッセージはない。仲介が止める。本体のカーソルは動かない）。
  fixture('e2e-panel-move', `api.registerPanel({ id: 'move', title: 'move' });\nself.postMessage({ kind: 'moveCursor', offset: 0 });`),
  // R7: 版 0 の項目だけを送り続ける（本文の版が進んだあとは古い項目。押しても本体は移さない）。
  fixture(
    'e2e-panel-stale',
    `const panel = api.registerPanel({ id: 'stale', title: '古い項目' });\npanel.setItems([{ text: '先頭へ', depth: 0, offset: 0 }], { version: 0 });`,
  ),
];
