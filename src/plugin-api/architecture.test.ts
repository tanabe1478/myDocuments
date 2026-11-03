import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * 部品の仕組みの縛り（ADR-005 の R1）。ファイルの import と名前を読んで確かめる。
 * - src/features/ の部品は、公開 API（src/plugin-api/）と CodeMirror・lezer・react だけを import する。部品どうしは import しない。
 * - ホストのファイルは、特定の部品の名前を持たない（ホストは部品の一覧を読むだけ）。
 * - 同梱の部品は src/features/index.ts の一覧からだけ読み込まれる。
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEATURES = path.join(SRC, 'features');
const PLUGIN_API = path.join(SRC, 'plugin-api');

function listFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => path.join(dir, f))
    .filter((f) => statSync(f).isFile() && /\.(ts|tsx)$/.test(f));
}

/** コメントを除いた import / export ... from / import() の指定子。 */
function specifiers(file: string): string[] {
  const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found: string[] = [];
  const patterns = [/\b(?:import|export)\s[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g];
  for (const p of patterns) for (const m of code.matchAll(p)) found.push(m[1]!);
  return found;
}

const isInside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
const stripExt = (p: string) => p.replace(/\.(ts|tsx)$/, '');
const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');

describe('src/features/: what a bundled plugin may import', () => {
  const files = listFiles(FEATURES);
  const pluginDirs = readdirSync(FEATURES).filter((d) => statSync(path.join(FEATURES, d)).isDirectory());

  it('has at least the typewriter plugin, in its own folder', () => {
    expect(pluginDirs).toContain('typewriter');
    expect(files.length).toBeGreaterThan(0);
  });

  it('imports only src/plugin-api/, @codemirror/*, @lezer/*, react, and its own folder (no other plugin, no host)', () => {
    const violations: string[] = [];
    for (const file of files) {
      const isTest = /\.test\.(ts|tsx)$/.test(file);
      const own = pluginDirs.find((d) => isInside(file, path.join(FEATURES, d)));
      for (const spec of specifiers(file)) {
        if (spec.startsWith('.')) {
          const target = path.resolve(path.dirname(file), spec);
          // 一覧（src/features/index.ts）だけは、各部品のフォルダを読み込んでよい。
          const isList = file === path.join(FEATURES, 'index.ts') && pluginDirs.some((d) => stripExt(target) === path.join(FEATURES, d));
          const ok = isList || isInside(target, PLUGIN_API) || (own !== undefined && isInside(target, path.join(FEATURES, own)));
          if (!ok) violations.push(`${rel(file)}: ${spec}`);
        } else {
          const ok = /^@codemirror\//.test(spec) || /^@lezer\//.test(spec) || spec === 'react' || spec.startsWith('react/') || (isTest && spec === 'vitest');
          if (!ok) violations.push(`${rel(file)}: ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('does not import another plugin (checked on its own, so a loosened rule above would still be caught)', () => {
    const violations: string[] = [];
    for (const file of files) {
      const own = pluginDirs.find((d) => isInside(file, path.join(FEATURES, d)));
      if (own === undefined) continue; // src/features/index.ts（一覧）
      for (const spec of specifiers(file)) {
        if (!spec.startsWith('.')) continue;
        const target = path.resolve(path.dirname(file), spec);
        const other = pluginDirs.find((d) => d !== own && isInside(target, path.join(FEATURES, d)));
        if (other !== undefined || target === FEATURES || stripExt(target) === path.join(FEATURES, 'index')) violations.push(`${rel(file)}: ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the checker itself sees import forms (guards against a regex that silently finds nothing)', () => {
    const probe = specifiers(path.join(FEATURES, 'typewriter', 'typewriterMode.ts'));
    expect(probe).toContain('@codemirror/view');
    expect(probe).toContain('../../plugin-api');
    expect(probe).toContain('./theme');
  });
});

describe('the host does not know any plugin by name', () => {
  const HOST = [
    'App.tsx',
    'editor/codemirror/CodeMirrorAdapter.ts',
    'editor/EditorAdapter.ts',
    'ui/shortcuts.ts',
    'ui/AppearanceSettings.tsx',
    'preferences/preferences.ts',
    'editor/codemirror/keepCursorVisible.ts',
    'editor/codemirror/readingPosition.ts',
    'editor/codemirror/theme.ts',
    'editor/codemirror/taskToggle.ts',
  ];

  it('lists files that exist', () => {
    for (const f of HOST) expect(existsSync(path.join(SRC, f)), f).toBe(true);
  });

  it('has no "typewriter" (any case, comments included) in the host files', () => {
    const hits = HOST.filter((f) => /typewriter/i.test(readFileSync(path.join(SRC, f), 'utf8')));
    expect(hits).toEqual([]);
  });
});

describe('bundled plugins are loaded only from the list in src/features/index.ts', () => {
  const all = listFiles(SRC);

  it('outside src/features/, only the index (the list) is imported', () => {
    const violations: string[] = [];
    for (const file of all) {
      if (isInside(file, FEATURES)) continue;
      for (const spec of specifiers(file)) {
        if (!spec.startsWith('.')) continue;
        const target = stripExt(path.resolve(path.dirname(file), spec));
        if (isInside(target, FEATURES) && target !== FEATURES && target !== path.join(FEATURES, 'index')) violations.push(`${rel(file)}: ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the list imports every plugin folder, and only plugin folders', () => {
    const pluginDirs = readdirSync(FEATURES).filter((d) => statSync(path.join(FEATURES, d)).isDirectory());
    const imported = specifiers(path.join(FEATURES, 'index.ts'))
      .filter((s) => s.startsWith('.') && !isInside(path.resolve(FEATURES, s), PLUGIN_API))
      .map((s) => path.relative(FEATURES, path.resolve(FEATURES, s)));
    expect(imported.sort()).toEqual(pluginDirs.sort());
  });

  it('the app reads the list in exactly one place (main.tsx) and hands the registry to the host', () => {
    const readers = all.filter((f) => !/\.test\./.test(f) && !isInside(f, FEATURES) && specifiers(f).some((s) => /(^|\/)features$/.test(s)));
    expect(readers.map(rel)).toEqual(['main.tsx']);
  });

  it('the public API imports nothing from the host or from plugins', () => {
    const violations: string[] = [];
    for (const file of listFiles(PLUGIN_API)) {
      if (/\.test\./.test(file)) continue;
      for (const spec of specifiers(file)) {
        if (spec.startsWith('.') && !isInside(path.resolve(path.dirname(file), spec), PLUGIN_API)) violations.push(`${rel(file)}: ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
