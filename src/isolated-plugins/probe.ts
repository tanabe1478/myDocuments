import { PLUGIN_API_VERSION, type ActionPlugin, type PluginRegistry } from '../plugin-api';
import type { HostTrace } from '../plugin-host';
import probeFrameHtml from './probe-frame.html?raw';

/**
 * 隔離の検証用（ADR-005 の R5「R5 で確かめた隔離」）。VITE_ISOLATION_PROBE=1 のビルドと、Cargo の feature isolation-probe を
 * 両方有効にしたビルドだけで動く。本番のビルドからは import ごと取り除かれる（印の文字列 __mdeIsolationProbe が dist に出ないことを CI が見る）。
 *
 * 起動するとすぐに、次を実際の Tauri の窓の中で試す（OS のキー入力・クリックは送らない）:
 *  (1) Worker の中のグローバル（__TAURI_INTERNALS__ など）。
 *  (2) Worker からの ipc://localhost と http://ipc.localhost への fetch と XHR（鍵なし）。
 *  (3) Worker から 127.0.0.1 の受け口への fetch、XHR、WebSocket、importScripts、入れ子の Worker。
 *  (4) Worker から仲介への、決めていない形のメッセージ（仲介が止める）。
 *  (5) 鍵が漏れたと仮定して、本体が鍵を部品に渡した場合の (2) と (3)。
 *  (6) 仲介の iframe と同じ条件の文脈（probe-frame。sandbox の srcdoc の iframe。R8 で plug: から移した）から、鍵ありの
 *      webkit.messageHandlers.ipc.postMessage などが届くか。R8 では、届かないことを確かめる（届いたら失敗）。
 *  (6b) R8: その文脈が自分の iframe を別の URL（本体のページ、plug:、data:、blob:）へ移す経路と、子の iframe を作る経路。移った先で鍵ありの
 *      postMessage が届くかの記録。
 *  (7) R6: 権限の API。宣言していない権限の API の呼び出し（確認なしで拒否される）、不正な形の呼び出し（部品が止まる）、
 *      未決の権限の呼び出し（確認の画面が出て、自動では許可されない。この検証は、確認の画面を答えるコードを持たない）。
 *      クリップボードへの書き込みは、この検証用のビルドでは記録（clipboard.log）に差し替わっていて、OS のクリップボードには書かない。
 *  (8) R6: 同梱の部品が、本物の relay.js（srcdoc の仲介の iframe）の上で動き、コマンドとメニューの項目を登録したこと。
 *  (9) R7: パネルと本文の API。不正な形の項目（深さ、登録していないパネル）、頻度の上限（setItems の連打）、カーソルを動かそうとするメッセージ
 *      （どれも、仲介が部品を止める）。権限 document.read を宣言した部品にだけ本文が届き、宣言していない部品には届かないこと。
 *      同梱の部品（アウトライン）が、本物の relay.js の上でパネルを登録したこと（パネルは見えていないので、本文は届かない）。
 * 届いたかの判定は、ネイティブ側の記録（canary.log）と 127.0.0.1 の受け口の記録で行う（このファイルが送る自己申告は参考）。
 * 比較のために、本体（鍵を持つ側）からの呼び出しも記録する（対照）。
 */
const MARK = '__mdeIsolationProbe';

interface Internals {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}
const internals = (): Internals => (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;

/** 本体が、IPC の鍵を持つ側として、1 回 invoke して鍵を取り出す（検証のための、鍵の漏れの模擬。製品のコードでは行わない）。 */
async function captureKeyAndConfig(): Promise<{ key: string | null; net: string }> {
  let key: string | null = null;
  const original = window.fetch;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers;
    const value = headers instanceof Headers ? headers.get('Tauri-Invoke-Key') : headers && !Array.isArray(headers) ? (headers as Record<string, string>)['Tauri-Invoke-Key'] : null;
    if (value) key = value;
    return original.call(window, input, init);
  }) as typeof window.fetch;
  try {
    const config = (await internals().invoke('isolation_probe_config')) as { net: string };
    return { key, net: config.net };
  } finally {
    window.fetch = original;
  }
}

/** Worker の中で動く、検証のコードの部品。どれも、結果を短い文字列にして、まとめて 1 つの記録にする。 */
const WORKER_LIB = `
const R = {};
const csp = [];
self.addEventListener('securitypolicyviolation', (e) => csp.push(e.violatedDirective + ':' + String(e.blockedURI).slice(0, 30)));
const t = (name, fn) => Promise.race([Promise.resolve().then(fn), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]).then(
  (v) => { R[name] = String(v).slice(0, 40); },
  (e) => { R[name] = 'ERR:' + ((e && e.name) || '') + ':' + String((e && e.message) || e).slice(0, 24); },
);
const ipcFetch = (url, who, key) => {
  const headers = { 'Content-Type': 'application/json', 'Tauri-Callback': '1', 'Tauri-Error': '2' };
  if (key) headers['Tauri-Invoke-Key'] = key;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify({ who }) }).then(async (r) => r.status + ' ' + (r.headers.get('Tauri-Response') || '-') + ' ' + (await r.text()).slice(0, 20));
};
const ipcXhr = (url, who, key) => new Promise((resolve, reject) => {
  const q = new XMLHttpRequest();
  q.open('POST', url);
  q.setRequestHeader('Content-Type', 'application/json'); q.setRequestHeader('Tauri-Callback', '1'); q.setRequestHeader('Tauri-Error', '2');
  if (key) q.setRequestHeader('Tauri-Invoke-Key', key);
  q.onload = () => resolve(q.status + ' ' + q.responseText.slice(0, 20));
  q.onerror = () => reject(new Error('xhr network error'));
  q.send(JSON.stringify({ who }));
});
const globals = () => { R.g = [typeof self.__TAURI_INTERNALS__, typeof self.__TAURI__, typeof self.isTauri, typeof (self.webkit && self.webkit.messageHandlers), typeof self.ipc, String(self.origin)].join(','); };
const ipcNoKey = (c) => [
  t('f-ipc', () => ipcFetch('ipc://localhost/isolation_probe_canary', c + ':fetch-ipc-nokey', null)),
  t('x-ipc', () => ipcXhr('ipc://localhost/isolation_probe_canary', c + ':xhr-ipc-nokey', null)),
  t('f-http', () => ipcFetch('http://ipc.localhost/isolation_probe_canary', c + ':fetch-ipchttp-nokey', null)),
];
const ipcKey = (c, key) => [
  t('kf-ipc', () => ipcFetch('ipc://localhost/isolation_probe_canary', c + ':fetch-ipc-key', key)),
  t('kx-ipc', () => ipcXhr('ipc://localhost/isolation_probe_canary', c + ':xhr-ipc-key', key)),
  t('kf-http', () => ipcFetch('http://ipc.localhost/isolation_probe_canary', c + ':fetch-ipchttp-key', key)),
  t('k-real', () => ipcFetch('ipc://localhost/load_preferences', c + ':real', key)),
];
const net = (c, base) => [
  t('n-fetch', () => fetch(base + '/fetch?ctx=' + c + '-fetch', { mode: 'no-cors' }).then(() => 'resolved')),
  t('n-xhr', () => new Promise((res, rej) => { const q = new XMLHttpRequest(); q.open('GET', base + '/xhr?ctx=' + c + '-xhr'); q.onload = () => res('loaded'); q.onerror = () => rej(new Error('xhr network error')); q.send(); })),
  t('n-ws', () => new Promise((res) => { const w = new WebSocket('ws://' + base.replace('http://', '') + '/ws?ctx=' + c + '-ws'); w.onopen = () => { res('open'); w.close(); }; w.onerror = () => res('error'); setTimeout(() => res('timeout'), 1500); })),
  t('n-import', () => { importScripts(base + '/script.js?ctx=' + c + '-importscripts'); return 'ran'; }),
  t('n-sse', () => typeof EventSource === 'undefined' ? 'n/a' : new Promise((res) => { const s = new EventSource(base + '/sse?ctx=' + c + '-sse'); s.onopen = () => { res('open'); s.close(); }; s.onerror = () => { res('error'); s.close(); }; setTimeout(() => res('timeout'), 1500); })),
  t('n-nested', () => new Promise((res) => {
    const code = 'fetch(' + JSON.stringify(base + '/fetch?ctx=' + c + '-nested-worker-fetch') + ',{mode:"no-cors"}).then(()=>postMessage("resolved"),(e)=>postMessage("ERR:"+e.name))';
    const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    w.onmessage = (e) => res(e.data); w.onerror = () => res('worker-error'); setTimeout(() => res('timeout'), 3000);
  })),
];
// 結果を、部品の report コマンドの例外の理由（300 文字まで）に載せる。ホストは、この理由を止めた記録として本体に残す。
const registerReport = (done) => api.registerCommand({ id: 'report', title: 'report', run: async () => { await done; throw new Error(JSON.stringify({ R, csp }).slice(0, 290)); } });
`;

interface ProbePart {
  readonly id: string;
  readonly source: (c: { net: string; key: string | null }) => string;
  /** 部品が宣言する権限（R6）。 */
  readonly permissions?: readonly string[];
}

const PARTS: readonly ProbePart[] = [
  // (1) グローバル
  { id: 'probe-globals', source: () => `${WORKER_LIB}\nglobals();\nregisterReport(Promise.resolve());` },
  // (2) 鍵なしの IPC
  { id: 'probe-ipc', source: () => `${WORKER_LIB}\nglobals();\nregisterReport(Promise.all(ipcNoKey('worker')));` },
  // (3) ネットワーク
  { id: 'probe-net', source: ({ net }) => `${WORKER_LIB}\nregisterReport(Promise.all(net('worker', ${JSON.stringify(net)})));` },
  // (5) 鍵が漏れたと仮定（本体が鍵を部品に渡した）。(2) と (3) を、鍵ありで
  {
    id: 'probe-leaked',
    source: ({ net, key }) =>
      `${WORKER_LIB}\nregisterReport(Promise.all([...ipcKey('worker-leaked', ${JSON.stringify(key)}), ...net('worker-leaked', ${JSON.stringify(net)})]));`,
  },
  // (4) 仲介への、決めていない形のメッセージ（仲介が部品を止める）
  { id: 'probe-post-unknown', source: () => `api.registerCommand({ id: 'report', title: 'report', run: async () => {} });\nself.postMessage({ kind: 'steal', what: 'everything' });` },
  { id: 'probe-post-forged', source: () => `api.registerCommand({ id: 'report', title: 'report', run: async () => {} });\nself.postMessage({ kind: 'done', req: 1 });` },
  {
    id: 'probe-post-invoke',
    source: ({ key }) =>
      `api.registerCommand({ id: 'report', title: 'report', run: async () => {} });\nself.postMessage({ kind: 'invoke', cmd: 'isolation_probe_canary', payload: { who: 'worker:postmessage-invoke' }, __TAURI_INVOKE_KEY__: ${JSON.stringify(key)} });`,
  },
  // (7) 宣言していない権限の API の呼び出し。API 経由と、仲介へ直接の postMessage の 2 通り。どちらも、確認の画面なしで拒否される
  // （結果は、本体から Worker に result として届く。ここで受け取って、報告に載せる）。
  {
    id: 'probe-undeclared',
    source: () => `
const got = [];
self.addEventListener('message', (e) => { const d = e.data; if (d && d.kind === 'result') got.push({ call: d.call, ok: d.ok, declaredMentioned: /宣言していません/.test(String(d.reason || '')) }); });
api.registerCommand({ id: 'report', title: 'report', run: async () => {
  self.postMessage({ kind: 'call', call: 11, method: 'clipboardWriteText', text: 'probe:undeclared-raw-write' });
  self.postMessage({ kind: 'call', call: 12, method: 'currentPath' });
  const viaApi = [];
  for (const attempt of [() => api.clipboard.writeText('probe:undeclared-api-write'), () => api.document.currentPath()]) {
    try { await attempt(); viaApi.push('resolved'); } catch (e) { viaApi.push('rejected:' + /宣言していません/.test(String(e.message))); }
  }
  await new Promise((r) => setTimeout(r, 1500));
  throw new Error(JSON.stringify({ got, viaApi }).slice(0, 290));
} });`,
  },
  // (7) 不正な形の呼び出し。仲介が部品を止める。
  { id: 'probe-bad-call-method', permissions: ['clipboard.write'], source: () => `api.registerCommand({ id: 'report', title: 'report', run: async () => {} });\nself.postMessage({ kind: 'call', call: 1, method: 'readClipboard' });` },
  { id: 'probe-bad-call-extra', permissions: ['paths.read'], source: () => `api.registerCommand({ id: 'report', title: 'report', run: async () => {} });\nself.postMessage({ kind: 'call', call: 1, method: 'currentPath', text: 'x' });` },
  { id: 'probe-bad-call-long', permissions: ['clipboard.write'], source: () => `api.registerCommand({ id: 'report', title: 'report', run: async () => {} });\nself.postMessage({ kind: 'call', call: 1, method: 'clipboardWriteText', text: 'x'.repeat(100001) });` },
  { id: 'probe-bad-menu', permissions: ['paths.read'], source: () => `api.registerCommand({ id: 'report', title: 'report', run: async () => {} });\nself.postMessage({ kind: 'menu', id: 'x', title: 't', where: 'editor' });` },
  // (7) 未決の権限の呼び出し。確認の画面が出て、答えられない限り、書かれない（この検証は、答えない）。
  {
    id: 'probe-undecided',
    permissions: ['clipboard.write'],
    source: () => `api.registerCommand({ id: 'report', title: 'report', run: async () => { await api.clipboard.writeText('probe:undecided-write'); } });`,
  },
  // (9) R7: パネルの不正な項目（深さが範囲外）。仲介が部品を止める。
  { id: 'probe-panel-bad-items', source: () => `api.registerPanel({ id: 'p', title: 'p' });\nself.postMessage({ kind: 'items', panel: 'p', version: 0, items: [{ text: 'x', depth: 99, offset: 0 }], current: null, empty: null });` },
  // (9) R7: 登録していないパネルの項目。
  { id: 'probe-panel-unregistered', source: () => `api.registerPanel({ id: 'p', title: 'p' });\nself.postMessage({ kind: 'items', panel: 'other', version: 0, items: [], current: null, empty: null });` },
  // (9) R7: setItems の頻度の上限（1 秒に 30 回）を超える。
  { id: 'probe-panel-flood', source: () => `const panel = api.registerPanel({ id: 'p', title: 'p' });\nfor (let i = 0; i < 40; i++) panel.setItems([], { version: i });` },
  // (9) R7: カーソルを動かそうとする（そのためのメッセージはない）。
  { id: 'probe-panel-move', source: () => `api.registerPanel({ id: 'p', title: 'p' });\nself.postMessage({ kind: 'moveCursor', offset: 0 });` },
  // (9) R7: 本文の通知。document.read を宣言した部品には届き（対照）、宣言していない部品には届かない。どちらもパネルを持たない（パネルがあれば、見えているときだけ届く）。
  // 結果は、report のコマンドの例外の理由に載せる。
  {
    id: 'probe-doc-declared',
    permissions: ['document.read'],
    source: () => `const got = { docs: 0, sels: 0, kinds: [] };
api.document.onDidChange((d) => { got.docs++; got.kinds.push(d.kind + ':' + typeof d.text); });
api.document.onDidChangeSelection(() => { got.sels++; });
api.registerCommand({ id: 'report', title: 'report', run: async () => { await new Promise((r) => setTimeout(r, 1500)); throw new Error(JSON.stringify(got).slice(0, 290)); } });`,
  },
  {
    id: 'probe-doc-undeclared',
    source: () => `const got = { docs: 0, sels: 0, kinds: [] };
api.document.onDidChange((d) => { got.docs++; got.kinds.push(d.kind + ':' + typeof d.text); });
api.document.onDidChangeSelection(() => { got.sels++; });
api.registerCommand({ id: 'report', title: 'report', run: async () => { await new Promise((r) => setTimeout(r, 1500)); throw new Error(JSON.stringify(got).slice(0, 290)); } });`,
  },
  // (4) 本体と同じ名前の BroadcastChannel（origin が違うので、本体には届かないはず）。本体の側が listen して、聞こえたら記録する
  {
    id: 'probe-broadcast',
    source: () => `${WORKER_LIB}\nregisterReport(t('bc', () => { const b = new BroadcastChannel('${MARK}-bc'); b.postMessage('hello from the worker'); b.close(); return 'posted'; }));`,
  },
];

export const probePlugins: readonly ActionPlugin[] = PARTS.map(({ id, permissions }) => ({
  manifest: { id, name: `${MARK} ${id}`, version: '0.0.0', apiVersion: PLUGIN_API_VERSION, tier: 'action', ...(permissions ? { permissions } : {}) } as ActionPlugin['manifest'],
  // source は、起動のときに鍵と受け口の URL を決めてから作る（createProbe）。ここは宣言だけ。
  source: '/* replaced in createProbe */',
}));

export interface ProbeSetup {
  readonly plugins: readonly ActionPlugin[];
  readonly trace: (event: HostTrace) => void;
  readonly afterBoot: (registry: PluginRegistry) => void;
}

export async function createProbe(): Promise<ProbeSetup> {
  const invoke = internals().invoke.bind(internals());
  const report = (data: Record<string, unknown>) => invoke('isolation_probe_report', { line: JSON.stringify(data) }).catch(() => undefined);
  const { key, net } = await captureKeyAndConfig();

  // 対照: 本体（鍵を持つ側）からの呼び出しは、ネイティブ側の記録に届く。記録の仕組みが動いていることの確認。
  await invoke('isolation_probe_canary', { who: 'main:control-invoke' });
  // 対照（R6）: 本体（鍵を持つ側）からの、クリップボードへの書き込みのコマンドは、記録（clipboard.log）に届く。この検証用のビルドでは、
  // 書き込みは記録に差し替わっていて、OS のクリップボードには書かない。
  await invoke('write_clipboard_text', { text: 'main:control-clipboard' });
  const control: Record<string, string> = {};
  try {
    const handler = (window as unknown as { webkit?: { messageHandlers?: { ipc?: { postMessage(m: string): void } } } }).webkit?.messageHandlers?.ipc;
    if (handler && key) {
      handler.postMessage(JSON.stringify({ cmd: 'isolation_probe_canary', callback: 1, error: 2, options: {}, payload: { who: 'main:control-postmessage-key' }, __TAURI_INVOKE_KEY__: key }));
      control.postMessage = 'posted';
    } else control.postMessage = handler ? 'no-key' : 'no-handler';
  } catch (e) {
    control.postMessage = `ERR:${String(e)}`;
  }
  const hear: string[] = [];
  const bc = new BroadcastChannel(`${MARK}-bc`);
  bc.onmessage = (e) => hear.push(String(e.data));
  await report({ ev: 'control', keyCaptured: key !== null, net, ua: navigator.userAgent, origin: location.origin, control });

  const plugins: ActionPlugin[] = probePlugins.map((p, i) => ({ ...p, source: PARTS[i]!.source({ net, key }) }));
  const stops = new Map<string, string>();
  const waiting = new Map<string, () => void>();
  /** 同梱の部品について、本体の側で見えた出来事（本物の relay.js の上で起動したことの確認）。 */
  const bundledEvents: string[] = [];
  /** 同梱の部品（アウトライン。R7）について、本体の側で見えた出来事。 */
  const outlineEvents: string[] = [];
  const trace = (event: HostTrace): void => {
    if (event.plugin === 'copy-path') bundledEvents.push(event.type === 'command' ? `command:${event.command}` : event.type === 'menu' ? `menu:${event.item}` : event.type);
    if (event.plugin === 'outline') outlineEvents.push(event.type === 'panel' ? `panel:${event.panel}` : event.type);
    if (event.type !== 'stopped') return;
    stops.set(event.plugin, event.reason);
    waiting.get(event.plugin)?.();
  };

  const runFrame = (): Promise<unknown[]> =>
    new Promise((resolve) => {
      const results: unknown[] = [];
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.style.cssText = 'position:absolute;width:0;height:0;border:0;left:-9999px';
      const finish = () => {
        window.removeEventListener('message', onMessage);
        frame.remove();
        resolve(results);
      };
      const timer = setTimeout(() => {
        results.push({ error: 'timeout' });
        finish();
      }, 25000);
      const onMessage = (e: MessageEvent) => {
        if (e.source !== frame.contentWindow) return;
        const d = e.data as { kind?: string; phase?: number };
        if (d?.kind === 'probe-hello') frame.contentWindow!.postMessage({ kind: 'probe-phase1', net }, '*');
        else if (d?.kind === 'probe-result') {
          results.push(d);
          if (d.phase === 1) frame.contentWindow!.postMessage({ kind: 'probe-phase2', key }, '*'); // 鍵の漏れの模擬（本体が鍵を渡す）
          else {
            clearTimeout(timer);
            finish();
          }
        }
      };
      window.addEventListener('message', onMessage);
      frame.srcdoc = probeFrameHtml;
      document.body.appendChild(frame);
    });

  /**
   * R8: 仲介と同じ条件の文脈（srcdoc の sandbox の iframe）が、自分を別の URL へ移す（self）、子の iframe を作る（child）経路。
   * 1 回の試験ごとに新しい文脈を作る（移れたら、その文脈のコードは失われる）。移った先で動くコード（data: と blob: の本文）は、
   * 鍵ありの postMessage を試し、着いたことを top（この窓）へ知らせる。届いたかの判定は canary.log（id は nav-<mode>-<dest>:postmessage-key）。
   */
  const runNav = (mode: 'self' | 'child', dest: 'tauri' | 'plug' | 'data' | 'blob'): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const id = `nav-${mode}-${dest}`;
      const out: Record<string, unknown> = { id, mode, dest, loadEvents: 0, hello: false, landed: null, frameReport: null, mainViolations: [] as string[] };
      // 本体の窓の CSP の違反（自分を移す経路は、子の iframe の持ち主である本体の frame-src で止まるはず）。
      const onViolation = (e: SecurityPolicyViolationEvent) => (out.mainViolations as string[]).push(`${e.violatedDirective}:${String(e.blockedURI).slice(0, 24)}`);
      document.addEventListener('securitypolicyviolation', onViolation);
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.style.cssText = 'position:absolute;width:0;height:0;border:0;left:-9999px';
      frame.addEventListener('load', () => {
        out.loadEvents = (out.loadEvents as number) + 1;
      });
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        window.removeEventListener('message', onMessage);
        document.removeEventListener('securitypolicyviolation', onViolation);
        frame.remove();
        resolve(out);
      };
      const onMessage = (e: MessageEvent) => {
        const d = e.data as { kind?: string; id?: string };
        if (d?.kind === 'probe-landed' && d.id === id) out.landed = d;
        else if (e.source === frame.contentWindow && d?.kind === 'probe-hello') {
          out.hello = true;
          frame.contentWindow!.postMessage({ kind: 'probe-nav', mode, dest, key, origin: location.origin }, '*');
          setTimeout(finish, 4500);
        } else if (e.source === frame.contentWindow && d?.kind === 'probe-nav-report' && d.id === id) out.frameReport = d;
      };
      window.addEventListener('message', onMessage);
      setTimeout(finish, 12000);
      frame.srcdoc = probeFrameHtml;
      document.body.appendChild(frame);
    });

  const afterBoot = (registry: PluginRegistry): void => {
    void (async () => {
      // 同梱の部品（R6）が、本物の relay.js の上で、コマンドとメニューの項目を登録し、ready になったか。
      for (let i = 0; i < 100 && !bundledEvents.includes('ready'); i++) await new Promise((r) => setTimeout(r, 100));
      await report({
        ev: 'bundled',
        plugin: 'copy-path',
        events: bundledEvents,
        commands: registry.commands.filter((c) => c.pluginId === 'copy-path').map((c) => c.id),
        menuItems: registry.menuItems.filter((m) => m.pluginId === 'copy-path').map((m) => m.id),
        status: registry.records.find((r) => r.id === 'copy-path')?.status ?? null,
      });
      // 同梱の部品（アウトライン。R7）: パネルを登録し、ready になったこと。パネルは見えていない（サイドバーは閉じている）ので、本文は届かない。
      for (let i = 0; i < 100 && !outlineEvents.includes('ready'); i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 1000));
      await report({
        ev: 'bundled-outline',
        plugin: 'outline',
        events: outlineEvents,
        panels: registry.panels.filter((p) => p.pluginId === 'outline').map((p) => p.id),
        status: registry.records.find((r) => r.id === 'outline')?.status ?? null,
      });
      // 部品の Worker を 1 つずつ。report のコマンドを実行して、結果の自己申告を止めた理由として受け取る。
      for (const { manifest } of plugins) {
        const id = manifest.id;
        if (id === 'probe-undecided') continue; // 最後に、別の扱いで試す（確認の画面が出る）。
        const stopped = stops.has(id)
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              waiting.set(id, resolve);
              setTimeout(resolve, 15000);
            });
        for (let i = 0; i < 100 && !registry.commands.some((c) => c.id === `${id}.report`); i++) {
          if (stops.has(id)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const command = registry.commands.find((c) => c.id === `${id}.report`);
        if (command && !stops.has(id)) command.run({} as never);
        await stopped;
        await report({ ev: 'worker', plugin: id, stopped: stops.get(id) ?? null, status: registry.records.find((r) => r.id === id)?.status ?? null });
      }
      await new Promise((r) => setTimeout(r, 500));
      await report({ ev: 'broadcast', heardInMainPage: hear });
      // 未決の権限の呼び出し（R6）。確認の画面が出る。この検証は、画面に答えるコードを持たない（自動では許可しない）。
      const undecided = registry.commands.find((c) => c.id === 'probe-undecided.report');
      undecided?.run({} as never);
      await new Promise((r) => setTimeout(r, 3000));
      const dialog = document.querySelector('[data-testid="permission-dialog"]');
      await report({
        ev: 'undecided',
        ran: Boolean(undecided),
        dialogShown: dialog !== null,
        dialogPlugin: dialog?.querySelector('[data-testid="permission-plugin-name"]')?.textContent ?? null,
        dialogPermissions: Array.from(dialog?.querySelectorAll('[data-permission]') ?? []).map((li) => li.getAttribute('data-permission')),
        status: registry.records.find((r) => r.id === 'probe-undecided')?.status ?? null,
      });
      // 同梱の部品の未決の呼び出し（本物の relay.js の上。確認の画面は上の部品が出しているので、順番を待つ）。これも、書かれない。
      registry.commands.find((c) => c.id === 'copy-path.copy-current-path')?.run({} as never);
      await new Promise((r) => setTimeout(r, 1500));
      // 仲介の iframe と同じ条件の文脈（probe-frame。srcdoc）から。
      const frameResults = await runFrame();
      await report({ ev: 'relay-context', results: frameResults });
      await new Promise((r) => setTimeout(r, 1500));
      // R8: その文脈が自分を別の URL へ移す経路と、子の iframe を作る経路（本体のページ、plug:、data:、blob:）。
      const navResults: Record<string, unknown>[] = [];
      for (const mode of ['self', 'child'] as const) {
        for (const dest of ['tauri', 'plug', 'data', 'blob'] as const) navResults.push(await runNav(mode, dest));
      }
      await report({ ev: 'nav', results: navResults });
      await new Promise((r) => setTimeout(r, 1500));
      await report({ ev: 'done' });
    })();
  };

  return { plugins, trace, afterBoot };
}
