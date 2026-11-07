import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * R7 の縛り（ADR-005）。R5・R6 の縛りを、R7 で足したコード（パネル、本文の通知、同梱の部品「アウトライン」）にも効かせる。
 * - 鍵と入口の文字列が、R7 のコードに出てこない。
 * - ホストのファイルに、同梱の段 2 の部品「アウトライン」の名前が出てこない。部品のフォルダは、公開 API と自分の worker.js だけを import する。
 * - パネルの描画は、部品の文字列を HTML として解釈しない。
 * - 部品はカーソルを動かせない（移動を頼むメッセージも API もない）。
 * - 新しい iframe がない（R8 で、仲介は srcdoc になり、独自プロトコル plug: はなくなった。本体の CSP の全指令は architecture.test.ts）。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const FORBIDDEN = [/Tauri-Invoke-Key/, /__TAURI_INTERNALS__/, /__TAURI__/, /\binvoke\b/, /ipc:/];

function listFiles(dir: string): string[] {
  return (readdirSync(path.join(ROOT, dir), { recursive: true }) as string[]).map((f) => path.join(dir, f).split(path.sep).join('/')).filter((f) => statSync(path.join(ROOT, f)).isFile());
}

const R7_FILES = ['src/panels/documentFeed.ts', 'src/ui/PluginPanels.tsx', 'src/features/outline/index.ts', 'src/features/outline/worker.js', 'src/plugin-api/permissions.ts', 'src/editor/EditorAdapter.ts'];

describe('the IPC key and entrances do not appear in the R7 code', () => {
  it('lists files that exist', () => {
    for (const f of R7_FILES) expect(() => read(f), f).not.toThrow();
  });
  it('has none of the forbidden strings (comments included)', () => {
    expect(R7_FILES.flatMap((f) => FORBIDDEN.filter((p) => p.test(read(f))).map((p) => `${f}: ${p.source}`))).toEqual([]);
  });
});

describe('the host does not know the bundled outline part by name', () => {
  const HOST = [
    'src/App.tsx',
    'src/main.tsx',
    'src/ui/Sidebar.tsx',
    'src/ui/PluginPanels.tsx',
    'src/ui/SettingsDialog.tsx',
    'src/panels/documentFeed.ts',
    'src/plugin-api/registry.ts',
    'src/plugin-api/types.ts',
    'src/plugin-api/permissions.ts',
    'src/plugin-api/index.ts',
    'src/editor/EditorAdapter.ts',
    'src/editor/codemirror/CodeMirrorAdapter.ts',
    'src/isolated-plugins/index.ts',
    ...listFiles('src/plugin-host').filter((f) => !/\.test\.ts$/.test(f)),
  ];
  const NAMES = [/アウトライン/, /\boutline\b/i, /outlinePlugin/];

  it('has no part name in the host files (comments included)', () => {
    expect(HOST.flatMap((f) => NAMES.filter((n) => n.test(read(f))).map((n) => `${f}: ${n.source}`))).toEqual([]);
  });

  it('the name check catches each form (guards against a pattern that matches nothing)', () => {
    for (const sample of ['outline', 'Outline', 'outlinePlugin', 'アウトライン']) expect(NAMES.some((n) => n.test(sample)), sample).toBe(true);
  });

  it('the part folder imports only the public API and its raw worker text', () => {
    const specs = [...strip(read('src/features/outline/index.ts')).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specs).toEqual(['../../plugin-api', './worker.js?raw']);
    expect(listFiles('src/features/outline').sort()).toEqual(['src/features/outline/index.ts', 'src/features/outline/worker.js']);
  });

  it('the list of bundled action plugins is the only place that imports the part', () => {
    const importers = listFiles('src').filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && /from\s+'\.\/outline'|features\/outline/.test(read(f)));
    expect(importers).toEqual(['src/features/index.ts']);
  });
});

describe('the panel is drawn by the host, and a part string is never HTML', () => {
  it('PluginPanels and the feed use no HTML injection (no dangerouslySetInnerHTML, innerHTML, insertAdjacentHTML, outerHTML, document.write, eval)', () => {
    for (const f of ['src/ui/PluginPanels.tsx', 'src/panels/documentFeed.ts']) {
      const code = strip(read(f));
      for (const p of [/dangerouslySetInnerHTML/, /innerHTML/, /outerHTML/, /insertAdjacent/, /document\.write/, /\beval\b/, /new\s+Function/, /createContextualFragment/, /DOMParser/]) expect(code, `${f} ${p.source}`).not.toMatch(p);
    }
  });

  it('PluginPanels puts no part string into a URL, a style, an event handler, or a link: the only props taken from a part are text, aria-label, and aria-current', () => {
    const code = strip(read('src/ui/PluginPanels.tsx'));
    for (const p of [/\bhref=/, /\bsrc=/, /\bstyle=/, /\bon[A-Z][A-Za-z]*=\{[^}]*(?:item|panel)\.(?:text|title|empty)/, /dangerously/]) expect(code, p.source).not.toMatch(p);
    // 部品の文字列（title、text、empty）が出てくる場所は、子の文字と aria-label だけ。
    const uses = [...code.matchAll(/\{([^{}]*(?:panel\.title|item\.text|panel\.empty)[^{}]*)\}/g)].map((m) => m[1]!.trim());
    // section の aria-label、見出しボタンの文字、一覧の aria-label（テンプレートの中）、項目の文字、項目がないときの文言。
    expect(uses.sort()).toEqual(['item.text', 'panel.empty ?? DEFAULT_EMPTY_TEXT', 'panel.title', 'panel.title', 'panel.title']);
  });

  it('PluginPanels and the feed import only react, the public API, and their own types', () => {
    for (const f of ['src/ui/PluginPanels.tsx', 'src/panels/documentFeed.ts']) {
      const specs = [...strip(read(f)).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
      expect(specs.filter((s) => s !== 'react' && !/^\.\.\/plugin-api$/.test(s)), f).toEqual([]);
    }
  });
});

describe('a part cannot move the cursor', () => {
  it('the messages a part can send are exactly the known ones: none of them names a cursor, a selection, a position to go to, or an edit', () => {
    const relay = strip(read('src/plugin-host/relay.js'));
    const kinds = [...relay.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]!);
    // check() の種類（Worker → 仲介）。
    expect(kinds.slice(0, 8)).toEqual(['command', 'menu', 'panel', 'items', 'call', 'ready', 'done', 'failed']);
    const protocol = strip(read('src/plugin-host/protocol.ts'));
    const relayMessage = /export type RelayMessage =([\s\S]*?);\n\nexport type ParseResult/.exec(protocol)![1]!;
    expect([...relayMessage.matchAll(/kind: '([a-zA-Z]+)'/g)].map((m) => m[1])).toEqual(['hello', 'command', 'menu', 'panel', 'items', 'call', 'call', 'ready', 'done', 'failed', 'stopped']);
  });

  it('the public API and the registry do not know the editor’s move operation, and the Worker’s api has no way to ask for it', () => {
    for (const f of ['src/plugin-api/types.ts', 'src/plugin-api/registry.ts', 'src/plugin-api/index.ts', 'src/plugin-host/relay.js', 'src/plugin-host/workerHost.ts', 'src/plugin-host/protocol.ts']) {
      expect(strip(read(f)), f).not.toMatch(/goToLineStart|setSelection|moveCursor|scrollIntoView/);
    }
  });

  it('only the host’s App calls goToLineStart, and only from the item handler (which checks the version)', () => {
    const callers = listFiles('src').filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && /goToLineStart\(/.test(read(f)));
    expect(callers.sort()).toEqual(['src/App.tsx', 'src/editor/EditorAdapter.ts', 'src/editor/codemirror/CodeMirrorAdapter.ts'].sort());
    const app = read('src/App.tsx');
    expect(app).toContain('panel.version !== feed.version');
    expect((app.match(/goToLineStart\(/g) ?? []).length).toBe(1);
  });
});

describe('no new iframe, and the isolated stage still has the one relay page', () => {
  it('src/plugin-host/ still has exactly host.html and relay.js as non-TypeScript files, and creates the one iframe', () => {
    expect(readdirSync(path.join(ROOT, 'src/plugin-host')).filter((n) => !/\.ts$/.test(n)).sort()).toEqual(['host.html', 'relay.js']);
    const iframes = listFiles('src').filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && /createElement\(\s*['"]iframe['"]/.test(read(f)));
    expect(iframes.sort()).toEqual(['src/plugin-host/domFrame.ts', 'src/isolated-plugins/probe.ts'].sort());
  });

  it('tauri.conf.json’s CSP keeps script-src \'self\' (R8 added only worker-src blob: and narrowed frame-src to none)', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { app: { security: { csp: string } } };
    expect(conf.app.security.csp).toContain("frame-src 'none'");
    expect(conf.app.security.csp).toContain("worker-src blob:");
    expect(conf.app.security.csp).toContain("script-src 'self'");
  });
});

describe('document.read is declaration-only: it is not in the saved set', () => {
  it('KNOWN_PERMISSIONS in plugin_permissions.rs and the TypeScript PERMISSIONS are the same two, without document.read', () => {
    const rust = read('src-tauri/src/plugin_permissions.rs');
    expect(rust).not.toContain('document.read');
    const known = /pub const KNOWN_PERMISSIONS: \[&str; 2\] = \[([^\]]*)\];/.exec(rust)![1]!;
    expect([...known.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual(['clipboard.write', 'paths.read']);
    expect(strip(read('src/plugin-api/permissions.ts'))).toMatch(/PERMISSIONS = \['clipboard\.write', 'paths\.read'\] as const/);
  });
});
