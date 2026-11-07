import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * 隔離した操作（段 2）の仕組みの縛り（ADR-005 の R5）。ファイルの中身を読んで確かめる。
 * - IPC の鍵と入口の文字列が、段 2 の仕組みのコードに出てこない（鍵を段 1・段 2 に渡さない規則を、コードの側で縛る）。
 * - 仲介のコード（relay.js）が、部品のコードを評価しない。
 * - 段 2 の仕組みのコードが、特定の部品やネイティブへの入口（platform）を import しない。
 * - 仲介の iframe は sandbox の srcdoc（host.html を ?raw で取り込む）、relay.js は本体と同じオリジンの /plugin-host/relay.js から、本番とe2e で同じバイト列で配信される。
 *   独自プロトコル（plug:）はない。本体の CSP の全指令。capabilities に remote がない（ADR-005 の R8）。
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

  it('the host page has no inline script and loads only relay.js, from the fixed same-origin path', () => {
    const html = read('src/plugin-host/host.html');
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual(['<script src="/plugin-host/relay.js">']);
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

describe('the srcdoc iframe, the same-origin relay.js, and the CSPs (R8)', () => {
  const directives = (csp: string) => new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0]!, d.split(/\s+/).slice(1)] as const));

  it('the files are exactly host.html and relay.js (plus the TypeScript and tests)', () => {
    const others = readdirSync(path.join(SRC, 'plugin-host')).filter((n) => !/\.(ts)$/.test(n));
    expect(others.sort()).toEqual(['host.html', 'relay.js']);
  });

  it('there is no custom protocol: plug.rs, hostUrl.ts, the registration, and frame-src plug: are gone', () => {
    expect(existsSync(path.join(ROOT, 'src-tauri/src/plug.rs'))).toBe(false);
    expect(existsSync(path.join(ROOT, 'src/plugin-host/hostUrl.ts'))).toBe(false);
    for (const f of listFiles(path.join(ROOT, 'src-tauri/src')).filter((f) => f.endsWith('.rs'))) {
      const text = readFileSync(f, 'utf8');
      expect(text, rel(f)).not.toMatch(/register_uri_scheme_protocol|register_asynchronous_uri_scheme_protocol|mod plug;/);
    }
    expect(read('src-tauri/tauri.conf.json')).not.toMatch(/plug:|plug\b/);
    expect(read('src-tauri/Cargo.toml')).not.toMatch(/\bplug\b/);
  });

  it('the iframe gets its content as srcdoc (the raw host.html), never as a URL', () => {
    const dom = read('src/plugin-host/domFrame.ts');
    const domCode = dom.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(domCode).toContain('iframe.srcdoc = hostHtml;');
    expect(domCode).not.toMatch(/\.src\s*=|setAttribute\(\s*['"]src['"]/);
    const index = read('src/plugin-host/index.ts');
    expect(index).toContain("import hostHtml from './host.html?raw';");
    expect(index).toContain('createDomFrame(hostHtml)');
  });

  it('vite.config.ts serves and emits relay.js from src/plugin-host/ at /plugin-host/relay.js, in every build (no e2e-only condition)', () => {
    const vite = read('vite.config.ts');
    expect(vite).toContain("new URL('./src/plugin-host/', import.meta.url)");
    expect(vite).toContain("'relay.js': { source: new URL('relay.js', PLUGIN_HOST_DIR), type: 'text/javascript; charset=utf-8' }");
    expect(vite).toContain("server.middlewares.use('/plugin-host'");
    expect(vite).toContain('fileName: `plugin-host/${name}`');
    const generate = /generateBundle\(\) \{([\s\S]*?)\n    \},/.exec(vite)![1]!;
    expect(generate).not.toMatch(/VITE_E2E|VITE_ISOLATION_PROBE|return;/);
    // 検証用のファイルは、VITE_ISOLATION_PROBE=1 のときだけ。
    expect(vite).toMatch(/if \(process\.env\.VITE_ISOLATION_PROBE === '1'\) files\['probe-frame\.js'\]/);
  });

  it('the build emits plugin-host/relay.js with exactly the bytes of src/plugin-host/relay.js, and nothing else (no probe file) without VITE_ISOLATION_PROBE', async () => {
    const config = (await import('../../vite.config')).default as { plugins: Array<{ name?: string; generateBundle?: (this: { emitFile(f: unknown): void }) => void }> };
    const plugin = config.plugins.flat().find((p) => p && p.name === 'plugin-host-files');
    expect(plugin).toBeDefined();
    const emitted: Array<{ type: string; fileName: string; source: Buffer }> = [];
    plugin!.generateBundle!.call({ emitFile: (f) => emitted.push(f as (typeof emitted)[number]) });
    expect(process.env.VITE_ISOLATION_PROBE).not.toBe('1');
    expect(emitted.map((e) => [e.type, e.fileName])).toEqual([['asset', 'plugin-host/relay.js']]);
    expect(Buffer.compare(emitted[0]!.source, readFileSync(path.join(SRC, 'plugin-host', 'relay.js')))).toBe(0);
  });

  it('the meta CSP of the host page narrows the inherited main CSP: only relay.js (self) and blob workers; connection, images, frames are none', () => {
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(read('src/plugin-host/host.html'))![1]!;
    expect(Object.fromEntries(directives(meta))).toEqual({
      'default-src': ["'none'"],
      'script-src': ["'self'"],
      'worker-src': ['blob:'],
      'connect-src': ["'none'"],
      'img-src': ["'none'"],
      'frame-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
    });
    expect(meta).not.toMatch(/unsafe-eval|unsafe-inline|http:|https:|data:|\*|plug:|ipc/);
  });

  it('the verification page (probe-frame.html) has the same meta CSP as the host page, and loads its script from the same path family', () => {
    const metaOf = (f: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(read(f))![1]!;
    expect(metaOf('src/isolated-plugins/probe-frame.html')).toBe(metaOf('src/plugin-host/host.html'));
    expect(read('src/isolated-plugins/probe-frame.html')).toContain('<script src="/plugin-host/probe-frame.js"></script>');
  });

  it('the main CSP: every directive is listed; this Run added worker-src blob: and narrowed frame-src to none', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { app: { security: { csp: string } } };
    const csp = directives(conf.app.security.csp);
    expect(Object.fromEntries(csp)).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'font-src': ["'self'", 'data:'],
      'connect-src': ["'self'", 'ipc:', 'http://ipc.localhost'],
      'frame-src': ["'none'"],
      'worker-src': ['blob:'],
      'object-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-ancestors': ["'none'"],
    });
  });

  it('capabilities have no remote entry, and grant only the main window (a srcdoc context is Remote for Tauri; a remote grant could include it)', () => {
    const caps = JSON.parse(read('src-tauri/capabilities/default.json')) as Record<string, unknown>;
    expect(Object.keys(caps)).not.toContain('remote');
    expect(caps.windows).toEqual(['main']);
    expect(existsSync(path.join(ROOT, 'src-tauri/capabilities'))).toBe(true);
    expect(readdirSync(path.join(ROOT, 'src-tauri/capabilities')).sort()).toEqual(['default.json']);
    expect(read('src-tauri/tauri.conf.json')).not.toMatch(/"remote"|dangerousRemoteDomainIpcAccess/);
  });

  it('the iframe is created with sandbox="allow-scripts" and without allow-same-origin', () => {
    const dom = read('src/plugin-host/domFrame.ts');
    const domCode = dom.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(dom).toContain("iframe.setAttribute('sandbox', 'allow-scripts');");
    expect(domCode).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals/);
  });
});
