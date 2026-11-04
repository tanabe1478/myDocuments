import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * 隔離した操作（段 2）の仕組みの縛り（ADR-005 の R5）。ファイルの中身を読んで確かめる。
 * - IPC の鍵と入口の文字列が、段 2 の仕組みのコードに出てこない（鍵を段 1・段 2 に渡さない規則を、コードの側で縛る）。
 * - 仲介のコード（relay.js）が、部品のコードを評価しない。
 * - 段 2 の仕組みのコードが、特定の部品やネイティブへの入口（platform）を import しない。
 * - Tauri 版（plug.rs）とブラウザ版（vite.config.ts）が、同じ元のファイルを使う。CSP の組み立て。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), 'utf8');

function listFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).map((f) => path.join(dir, f)).filter((f) => statSync(f).isFile());
}
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

/**
 * 鍵の縛りの対象。段 2 の仕組みのコード（src/plugin-host/ の、テストを除く全部）と、段 2 を扱う本体のコード。
 * 対象から除くのは、検証用のコードだけ: src/isolated-plugins/e2eFixtures.ts（本体への到達を試す e2e 用の部品）と
 * src/isolated-plugins/probe.ts（隔離の検証用の部品。鍵を試す）。どちらも本番のビルドに入らない（define の定数で囲む。dist の検査が見る）。
 */
const MECHANISM = listFiles(path.join(SRC, 'plugin-host')).filter((f) => !/\.test\.ts$/.test(f));
const HANDLING = ['src/isolated-plugins/index.ts', 'src/plugin-api/registry.ts', 'src/plugin-api/types.ts', 'src/main.tsx'].map((f) => path.join(ROOT, f));
const KEY_SCOPE = [...MECHANISM, ...HANDLING];
const VERIFICATION_ONLY = ['src/isolated-plugins/e2eFixtures.ts', 'src/isolated-plugins/probe.ts'];

const FORBIDDEN = [/Tauri-Invoke-Key/, /__TAURI_INTERNALS__/, /__TAURI__/, /\binvoke\b/, /ipc:/];

describe('the IPC key and entrances never appear in the isolated-stage code', () => {
  it('covers the mechanism files and the files that handle the isolated stage', () => {
    const names = KEY_SCOPE.map(rel);
    expect(names).toEqual(
      expect.arrayContaining(['src/plugin-host/relay.js', 'src/plugin-host/host.html', 'src/plugin-host/workerHost.ts', 'src/plugin-host/protocol.ts', 'src/plugin-host/domFrame.ts', 'src/plugin-host/index.ts', 'src/isolated-plugins/index.ts', 'src/plugin-api/registry.ts', 'src/main.tsx']),
    );
    for (const f of VERIFICATION_ONLY) expect(names).not.toContain(f);
  });

  it('has none of Tauri-Invoke-Key, __TAURI_INTERNALS__, __TAURI__, invoke, ipc: (comments included)', () => {
    const hits = KEY_SCOPE.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return FORBIDDEN.filter((p) => p.test(text)).map((p) => `${rel(f)}: ${p.source}`);
    });
    expect(hits).toEqual([]);
  });

  it('the verification-only files exist and are the only places that may name them', () => {
    // 除外が空振りしていないこと（除いたファイルが実在し、実際に鍵や入口の文字列を扱う）。
    const probeAndFixtures = VERIFICATION_ONLY.map((f) => read(f));
    expect(probeAndFixtures.some((t) => FORBIDDEN.some((p) => p.test(t)))).toBe(true);
  });

  it('the forbidden patterns do catch each form (guards against a pattern that silently matches nothing)', () => {
    for (const sample of ['Tauri-Invoke-Key', 'window.__TAURI_INTERNALS__', 'window.__TAURI__.core', 'x.invoke("cmd")', 'fetch("ipc://localhost/x")', 'http://ipc.localhost']) {
      expect(FORBIDDEN.some((p) => p.test(sample)), sample).toBe(sample !== 'http://ipc.localhost');
    }
  });
});

describe('relay.js does not evaluate the part code', () => {
  const relay = read('src/plugin-host/relay.js');
  const code = relay.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('has no eval, string-to-function, script insertion, or importScripts', () => {
    for (const p of [/\beval\s*\(/, /\bnew\s+Function\b/, /(^|[^.\w])Function\s*\(/, /document\./, /createElement/, /\.innerHTML/, /\.outerHTML/, /insertAdjacent/, /importScripts/, /setTimeout\s*\(\s*['"`]/, /\bimport\s*\(/, /\bWebAssembly\b/]) {
      expect(code, p.source).not.toMatch(p);
    }
  });

  it('hands the part code to a Worker only as a Blob (the one place it is used)', () => {
    expect(code.match(/new Worker\(/g)).toHaveLength(1);
    expect(code.match(/new Blob\(/g)).toHaveLength(1);
    expect(code).toContain('new Blob([PRELUDE, source');
  });

  it('only talks to the parent and the Worker (no fetch, XHR, WebSocket, storage, or navigation)', () => {
    for (const p of [/\bfetch\b/, /XMLHttpRequest/, /WebSocket/, /localStorage/, /sessionStorage/, /indexedDB/, /location\./, /navigator\./, /\btop\b/, /\bopener\b/, /\bpostMessage\(\s*[^)]*\)\s*;?\s*\/\/\s*never/]) {
      expect(code, p.source).not.toMatch(p);
    }
  });

  it('checks event.source against the parent before reading a message', () => {
    expect(code).toMatch(/if \(event\.source !== main\) return;/);
    expect(code).toContain('var main = window.parent;');
  });

  it('the host page has no inline script and loads only relay.js', () => {
    const html = read('src/plugin-host/host.html');
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual(['<script src="relay.js">']);
    expect(html).not.toMatch(/\son\w+=/);
  });
});

describe('what the isolated-stage code may import', () => {
  it('src/plugin-host/ imports only src/plugin-api/ and its own files (not features, platform, bridge, ui, editor, or preferences)', () => {
    const violations: string[] = [];
    for (const f of listFiles(path.join(SRC, 'plugin-host')).filter((f) => f.endsWith('.ts') && !/\.test\.ts$/.test(f))) {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        const ok = spec.startsWith('./') || spec === 'vitest' || spec === 'node:fs' || spec === 'node:path' || spec === 'node:url' || spec === 'node:vm' || /^\.\.\/plugin-api(\/|$)/.test(spec);
        if (!ok) violations.push(`${rel(f)}: ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the isolated-plugin list and the registry do not import the bundled plugins, the bridge, or the platform', () => {
    for (const f of ['src/isolated-plugins/index.ts', 'src/plugin-api/registry.ts']) {
      const code = read(f);
      expect([...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!).filter((s) => /features|platform|bridge|\/ui\/|\/editor\//.test(s)), f).toEqual([]);
    }
  });

  it('the test fixtures and the probe are reached only through a build-time constant (they drop out of the production bundle)', () => {
    const code = read('src/isolated-plugins/index.ts');
    expect(code).toMatch(/if \(__E2E__\) \{[\s\S]*import\('\.\/e2eFixtures'\)/);
    expect(code).toMatch(/if \(__ISOLATION_PROBE__\) \{[\s\S]*import\('\.\/probe'\)/);
    expect([...code.matchAll(/import\('([^']+)'\)/g)].map((m) => m[1])).toEqual(['./e2eFixtures', './probe']);
    // 本番の部品の一覧は空（R5 は仕組みだけ）。
    expect(code).toMatch(/const plugins: ActionPlugin\[\] = \[\];/);
    for (const f of listFiles(SRC).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))) {
      if (VERIFICATION_ONLY.includes(rel(f).replace(/^/, '')) || rel(f) === 'src/isolated-plugins/index.ts') continue;
      const text = readFileSync(f, 'utf8');
      expect(text, rel(f)).not.toMatch(/from\s+'[^']*(e2eFixtures|isolated-plugins\/probe|\.\/probe)'/);
    }
  });
});

describe('Tauri (plug:) and the browser serve the same source files, with the same CSP', () => {
  it('the files are exactly host.html and relay.js (plus the TypeScript and tests)', () => {
    const others = readdirSync(path.join(SRC, 'plugin-host')).filter((n) => !/\.(ts)$/.test(n));
    expect(others.sort()).toEqual(['host.html', 'relay.js']);
  });

  it('plug.rs embeds those files with include_str! and serves exactly those names', () => {
    const plug = read('src-tauri/src/plug.rs');
    expect(plug).toContain('include_str!("../../src/plugin-host/host.html")');
    expect(plug).toContain('include_str!("../../src/plugin-host/relay.js")');
    expect(plug).toContain('("/host.html", "text/html; charset=utf-8", HOST_HTML)');
    expect(plug).toContain('("/relay.js", "text/javascript; charset=utf-8", RELAY_JS)');
    // ほかの 2 つは、検証用のページ（feature isolation-probe のときだけ）。cfg が直前にある。
    expect([...plug.matchAll(/include_str!\(/g)]).toHaveLength(4);
    expect([...plug.matchAll(/#\[cfg\(feature = "isolation-probe"\)\]\nconst PROBE_FRAME_(?:HTML|JS): &str = include_str!\("\.\.\/\.\.\/src\/isolated-plugins\/probe-frame\.(?:html|js)"\);/g)]).toHaveLength(2);
    // ファイルシステムから読まない（テストの部分だけが、埋め込みの確認のために読む）。
    expect(plug.split('#[cfg(test)]')[0]).not.toMatch(/std::fs|File::open|read_to_string/);
  });

  it('vite.config.ts serves and emits those same files from src/plugin-host/, and only emits them for the e2e build', () => {
    const vite = read('vite.config.ts');
    expect(vite).toContain("new URL('./src/plugin-host/', import.meta.url)");
    expect(vite).toContain("'host.html': 'text/html; charset=utf-8'");
    expect(vite).toContain("'relay.js': 'text/javascript; charset=utf-8'");
    expect(vite).toMatch(/generateBundle\(\) \{\s*if \(process\.env\.VITE_E2E !== '1'\) return;/);
    expect(vite).toContain('readFileSync(new URL(name, PLUGIN_HOST_DIR))');
  });

  const directives = (csp: string) => new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0]!, d.split(/\s+/).slice(1)] as const));

  it('the header CSP (plug.rs) and the meta CSP (host.html) agree: the meta only adds the self origin for the browser build', () => {
    const header = /pub const CSP: &str = "([^"]+)";/.exec(read('src-tauri/src/plug.rs'))![1]!;
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(read('src/plugin-host/host.html'))![1]!;
    expect(header).toBe("default-src 'none'; script-src plug:; worker-src blob:");
    const h = directives(header);
    const m = directives(meta);
    expect([...m.keys()]).toEqual([...h.keys()]);
    expect(m.get('default-src')).toEqual(["'none'"]);
    expect(m.get('worker-src')).toEqual(['blob:']);
    expect(h.get('script-src')).toEqual(['plug:']);
    expect(m.get('script-src')).toEqual(['plug:', "'self'"]);
    // ネットワークと接続を許す指定は、どちらにもない。
    for (const csp of [header, meta]) expect(csp).not.toMatch(/connect-src|img-src|frame-src|unsafe-eval|unsafe-inline|http:|https:|data:|\*/);
  });

  it('the main CSP gained only frame-src plug: (every other directive is as before)', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { app: { security: { csp: string } } };
    const csp = directives(conf.app.security.csp);
    expect(Object.fromEntries(csp)).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'font-src': ["'self'", 'data:'],
      'connect-src': ["'self'", 'ipc:', 'http://ipc.localhost'],
      'frame-src': ['plug:'],
      'object-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-ancestors': ["'none'"],
    });
  });

  it('the iframe is created with sandbox="allow-scripts" and without allow-same-origin', () => {
    const dom = read('src/plugin-host/domFrame.ts');
    const domCode = dom.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(dom).toContain("iframe.setAttribute('sandbox', 'allow-scripts');");
    expect(domCode).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals/);
  });
});
