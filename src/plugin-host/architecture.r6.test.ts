import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * R6 の縛り（ADR-005）。R5 の縛り（architecture.test.ts）を、R6 で足したコードにもそのまま効かせる。
 * - 鍵と入口の文字列（Tauri-Invoke-Key、__TAURI_INTERNALS__、__TAURI__、invoke、ipc:）が、段 2 の権限・確認・API・同梱の部品のコードに出てこない。
 * - ホストのファイルに、同梱の段 2 の部品の名前が出てこない。
 * - クリップボードの許可は、自前のコマンドの許可だけ（clipboard-manager の JavaScript 向けの許可と npm の依存は入れない）。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const FORBIDDEN = [/Tauri-Invoke-Key/, /__TAURI_INTERNALS__/, /__TAURI__/, /\binvoke\b/, /ipc:/];

function listFiles(dir: string): string[] {
  return (readdirSync(path.join(ROOT, dir), { recursive: true }) as string[]).map((f) => path.join(dir, f).split(path.sep).join('/')).filter((f) => statSync(path.join(ROOT, f)).isFile());
}

/** R6 で足した、段 2 の権限・確認・API・同梱の部品のコード（検証用のコードは含まない）。 */
const R6_FILES = [
  'src/plugin-api/permissions.ts',
  'src/permissions/controller.ts',
  'src/platform/hostServices.ts',
  'src/ui/PermissionDialog.tsx',
  'src/ui/PluginPermissionsSettings.tsx',
  'src/ui/Sidebar.tsx',
  'src/ui/TreeContextMenu.tsx',
  'src/ui/SettingsDialog.tsx',
  'src/features/copy-path/index.ts',
  'src/features/copy-path/worker.js',
  'src/features/index.ts',
  'src/plugin-api/shortcut.ts',
  'src/isolated-plugins/index.ts',
];

describe('the IPC key and entrances do not appear in the R6 code either', () => {
  it('lists files that exist, and checks the R6 files plus every non-test file of src/plugin-host/', () => {
    for (const f of R6_FILES) expect(() => read(f), f).not.toThrow();
    const hostFiles = listFiles('src/plugin-host').filter((f) => !/\.test\.ts$/.test(f));
    expect(hostFiles).toEqual(expect.arrayContaining(['src/plugin-host/relay.js', 'src/plugin-host/relayHarness.ts']));
  });

  it('has none of the forbidden strings (comments included)', () => {
    const hostFiles = listFiles('src/plugin-host').filter((f) => !/\.test\.ts$/.test(f));
    const hits = [...R6_FILES, ...hostFiles, 'src/plugin-api/registry.ts', 'src/plugin-api/types.ts', 'src/main.tsx'].flatMap((f) => FORBIDDEN.filter((p) => p.test(read(f))).map((p) => `${f}: ${p.source}`));
    expect(hits).toEqual([]);
  });

  it('the part code is a plain script: no network, no storage, no evaluation, no import', () => {
    const code = read('src/features/copy-path/worker.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const p of [/\bfetch\b/, /XMLHttpRequest/, /WebSocket/, /importScripts/, /\beval\b/, /new\s+Function/, /\bimport\b/, /localStorage/, /postMessage/, /\bself\b/]) expect(code, p.source).not.toMatch(p);
    // 使う API は、api だけ。
    expect([...new Set([...code.matchAll(/\bapi\.([A-Za-z.]+)/g)].map((m) => m[1]))].sort()).toEqual(['clipboard.writeText', 'document.currentPath', 'registerCommand', 'registerContextMenuItem']);
  });
});

describe('the host does not know the bundled action part by name', () => {
  const HOST = [
    'src/App.tsx',
    'src/main.tsx',
    'src/ui/Sidebar.tsx',
    'src/ui/TreeContextMenu.tsx',
    'src/ui/SettingsDialog.tsx',
    'src/ui/PermissionDialog.tsx',
    'src/ui/PluginPermissionsSettings.tsx',
    'src/permissions/controller.ts',
    'src/platform/hostServices.ts',
    'src/plugin-api/registry.ts',
    'src/plugin-api/types.ts',
    'src/plugin-api/permissions.ts',
    'src/plugin-api/shortcut.ts',
    'src/isolated-plugins/index.ts',
    ...listFiles('src/plugin-host').filter((f) => !/\.test\.ts$/.test(f)),
  ];
  const NAMES = [/copy-?path/i, /パスをコピー/, /copyPath/];

  it('has no part name in the host files (comments included)', () => {
    expect(HOST.flatMap((f) => NAMES.filter((n) => n.test(read(f))).map((n) => `${f}: ${n.source}`))).toEqual([]);
  });

  it('the name check catches each form (guards against a pattern that matches nothing)', () => {
    for (const sample of ['copy-path', 'CopyPath', 'copyPathPlugin', 'パスをコピー']) expect(NAMES.some((n) => n.test(sample)), sample).toBe(true);
  });

  it('the part folder imports only the public API, and the raw worker text', () => {
    const specs = [...read('src/features/copy-path/index.ts').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specs).toEqual(['../../plugin-api', './worker.js?raw']);
  });
});

describe('the clipboard permission is only the own command (no JavaScript-facing clipboard-manager permission, no npm dependency)', () => {
  it('capabilities/default.json grants allow-write-clipboard-text and no clipboard-manager permission', () => {
    const caps = JSON.parse(read('src-tauri/capabilities/default.json')) as { permissions: string[] };
    expect(caps.permissions).toEqual(expect.arrayContaining(['allow-write-clipboard-text', 'allow-load-plugin-permissions', 'allow-save-plugin-permissions']));
    expect(caps.permissions.filter((p) => /clipboard/.test(p))).toEqual(['allow-write-clipboard-text']);
  });

  it('package.json and the lock file have no @tauri-apps/plugin-clipboard-manager, and no source imports it', () => {
    expect(read('package.json')).not.toContain('clipboard-manager');
    expect(read('package-lock.json')).not.toContain('clipboard-manager');
    const sources = listFiles('src').filter((f) => /\.(ts|tsx|js)$/.test(f) && !/architecture\.r6\.test\.ts$/.test(f));
    expect(sources.filter((f) => read(f).includes('plugin-clipboard-manager'))).toEqual([]);
  });

  it('the Rust side uses the clipboard-manager crate at 2.5.0, through its Rust API only', () => {
    expect(read('src-tauri/Cargo.toml')).toMatch(/^tauri-plugin-clipboard-manager = "2\.5\.0"$/m);
    const clipboard = read('src-tauri/src/clipboard.rs');
    expect(clipboard).toContain('tauri_plugin_clipboard_manager::ClipboardExt');
    expect(clipboard).toContain('write_text');
    expect(clipboard).not.toMatch(/read_text|read_image|clear\(\)/);
    const lib = read('src-tauri/src/lib.rs');
    expect(lib).toContain('write_clipboard_text');
    expect(lib).not.toMatch(/clipboard-manager:/);
  });

  it('the native commands are called from the bridge only (and from the verification-only probe, which calls write_clipboard_text as the key-holding control)', () => {
    const callers = listFiles('src').filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && /'(write_clipboard_text|load_plugin_permissions|save_plugin_permissions)'/.test(read(f)));
    expect(callers).toEqual(['src/isolated-plugins/probe.ts', 'src/platform/tauriBridge.ts']);
    // 検証用の部品は、本番のビルドに入らない（define の定数で囲む。R5 の縛り）。
    expect(read('src/isolated-plugins/probe.ts')).toContain('write_clipboard_text');
    expect(read('src/isolated-plugins/index.ts')).toMatch(/if \(__ISOLATION_PROBE__\) \{[\s\S]*import\('\.\/probe'\)/);
  });
});
