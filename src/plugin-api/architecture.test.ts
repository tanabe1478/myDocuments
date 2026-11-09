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

  it('has the bundled plugins (typewriter, focus, list-continuation, markdown, typing-sound), each in its own folder', () => {
    expect(pluginDirs).toContain('typewriter');
    expect(pluginDirs).toContain('typing-sound');
    expect(pluginDirs).toContain('markdown');
    expect(pluginDirs).toContain('focus');
    expect(pluginDirs).toContain('list-continuation');
    expect(files.length).toBeGreaterThan(0);
  });

  it('the files of the focus plugin are covered by the import rule (checked on their own, so the rule cannot silently skip them)', () => {
    const focusFiles = files.filter((f) => isInside(f, path.join(FEATURES, 'focus'))).map(rel);
    expect(focusFiles).toEqual(
      expect.arrayContaining(['features/focus/index.ts', 'features/focus/focusMode.ts', 'features/focus/focusRange.ts', 'features/focus/theme.ts', 'features/focus/focusRange.test.ts', 'features/focus/plugin.test.ts']),
    );
    const specs = specifiers(path.join(FEATURES, 'focus', 'focusRange.ts'));
    expect(specs).toEqual(['../../plugin-api']);
    expect(specifiers(path.join(FEATURES, 'focus', 'focusMode.ts'))).toEqual(
      expect.arrayContaining(['@codemirror/state', '@codemirror/view', '../../plugin-api', './focusRange', './theme']),
    );
  });

  it('the files of the list-continuation plugin are covered by the import rule (checked on their own, so the rule cannot silently skip them)', () => {
    const own = files.filter((f) => isInside(f, path.join(FEATURES, 'list-continuation'))).map(rel);
    expect(own).toEqual(
      expect.arrayContaining([
        'features/list-continuation/index.ts',
        'features/list-continuation/listContinuation.ts',
        'features/list-continuation/listContinuation.test.ts',
        'features/list-continuation/plugin.test.ts',
      ]),
    );
    expect(specifiers(path.join(FEATURES, 'list-continuation', 'index.ts'))).toEqual(['../../plugin-api', './listContinuation']);
    expect(specifiers(path.join(FEATURES, 'list-continuation', 'listContinuation.ts'))).toEqual(
      expect.arrayContaining(['@codemirror/lang-markdown', '@codemirror/state', '@codemirror/view']),
    );
    // ホストの設定の型（src/preferences/）を import しない（部品が自分の型を持つ）。
    for (const f of files.filter((f) => isInside(f, path.join(FEATURES, 'list-continuation')))) {
      expect(specifiers(f).filter((spec) => spec.includes('preferences')), rel(f)).toEqual([]);
    }
  });

  it('the files of the typing-sound plugin are covered by the import rule (checked on their own, so the rule cannot silently skip them)', () => {
    const own = files.filter((f) => isInside(f, path.join(FEATURES, 'typing-sound'))).map(rel);
    expect(own).toEqual(
      expect.arrayContaining([
        'features/typing-sound/index.ts',
        'features/typing-sound/extension.ts',
        'features/typing-sound/keys.ts',
        'features/typing-sound/player.ts',
        'features/typing-sound/onset.ts',
        'features/typing-sound/sounds.ts',
        'features/typing-sound/e2eProbe.ts',
        'features/typing-sound/keys.test.ts',
        'features/typing-sound/player.test.ts',
        'features/typing-sound/onset.test.ts',
        'features/typing-sound/plugin.test.ts',
      ]),
    );
    expect(specifiers(path.join(FEATURES, 'typing-sound', 'extension.ts'))).toEqual(expect.arrayContaining(['@codemirror/state', '@codemirror/view', './player']));
    // 素材は、自分のフォルダの sounds/ の中のものだけを、Vite の ?url で取り込む（キーボード 10 個、加工後のタイプライター 8 個）。
    // 元の録音（sounds/typewriter/original/）は import しない（dist に入れない）。
    const sounds = specifiers(path.join(FEATURES, 'typing-sound', 'sounds.ts'));
    expect(sounds).toHaveLength(18);
    expect(sounds.filter((spec) => /^\.\/sounds\/keypress-\d{3}\.wav\?url$/.test(spec))).toHaveLength(10);
    expect(sounds.filter((spec) => /^\.\/sounds\/typewriter\/typewriter-[1-8]\.wav\?url$/.test(spec))).toHaveLength(8);
    expect(sounds.some((spec) => spec.includes('original'))).toBe(false);
    // 本体の設定・OS の判定・ネイティブへの入口（bridge）・本体の画面を、部品は直接 import しない。
    for (const f of files.filter((f) => isInside(f, path.join(FEATURES, 'typing-sound')))) {
      const bad = specifiers(f).filter((spec) => /preferences|shortcuts|platform|bridge|\/ui\/|\/editor\//.test(spec));
      expect(bad, rel(f)).toEqual([]);
    }
  });

  it('the files of the markdown plugin are covered by the import rule (checked on their own, so the rule cannot silently skip them)', () => {
    const own = files.filter((f) => isInside(f, path.join(FEATURES, 'markdown'))).map(rel);
    expect(own).toEqual(
      expect.arrayContaining([
        'features/markdown/index.ts',
        'features/markdown/markdownDecorations.ts',
        'features/markdown/liveMarkup.ts',
        'features/markdown/lineKinds.ts',
        'features/markdown/taskToggle.ts',
        'features/markdown/linkOpen.ts',
        'features/markdown/theme.ts',
        'features/markdown/tableModel.ts',
        'features/markdown/tableDisplay.ts',
        'features/markdown/tableKeys.ts',
        'features/markdown/liveMarkup.test.ts',
        'features/markdown/lineKinds.test.ts',
        'features/markdown/taskToggle.test.ts',
        'features/markdown/tableModel.test.ts',
        'features/markdown/tableDisplay.test.ts',
        'features/markdown/tableKeys.test.ts',
        'features/markdown/plugin.test.ts',
      ]),
    );
    expect(specifiers(path.join(FEATURES, 'markdown', 'index.ts'))).toEqual(
      expect.arrayContaining(['../../plugin-api', './linkOpen', './markdownDecorations', './markupDisplay', './tableDisplay', './tableKeys', './taskToggle', './theme']),
    );
    // 表の部品は、弱く表示する部品（フォーカスモード）を知らない。plugin-api の共通の約束だけで協調する。
    for (const f of ['tableModel.ts', 'tableDisplay.ts', 'tableKeys.ts']) {
      const text = readFileSync(path.join(FEATURES, 'markdown', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(text, f).not.toMatch(/focusMode|focusRange|cm-md-dim|typewriter/i);
    }
    // 表の DOM は、createElement と文字だけで組み立てる（文書の文字を HTML として解釈する API を使わない）。
    const display = readFileSync(path.join(FEATURES, 'markdown', 'tableDisplay.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(display).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|document\.write/);
    expect(display).toContain('createElement');
    // 本体の設定・OS の判定・ネイティブへの入口（bridge）を、部品は直接 import しない。本体が貸す機能（plugin-api の HostServices）だけを使う。
    for (const f of files.filter((f) => isInside(f, path.join(FEATURES, 'markdown')))) {
      const bad = specifiers(f).filter((spec) => /preferences|shortcuts|platform|bridge|\/ui\/|\/editor\//.test(spec));
      expect(bad, rel(f)).toEqual([]);
    }
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
    'editor/codemirror/textKind.ts',
    'ui/EditingSettings.tsx',
    'ui/SettingsDialog.tsx',
    'ui/RadioSettingsItem.tsx',
    'ui/SoundSettings.tsx',
  ];

  it('lists files that exist', () => {
    for (const f of HOST) expect(existsSync(path.join(SRC, f)), f).toBe(true);
  });

  // 部品の名前、部品の中の識別子、部品が持つ DOM の class（コメントを含む。大文字小文字を問わない）。
  const NAMES = [
    /typewriter/i,
    /focusMode/i,
    /focusRange/i,
    /cm-md-dim/i,
    /setFocusMode/i,
    /listContinuation/i,
    /ListContinuation/i,
    /insertNewlineContinue/i,
    /setListContinuation/i,
    // R4: Markdown の見た目（記法の隠し方、チェックボックス、リンクを開く操作）。素のテキストの空行の class（cm-md-blank）だけは本体のもの。
    /markupDisplay/i,
    /liveMarkup/i,
    /taskToggle/i,
    /linkOpen/i,
    /markdownDecorations/i,
    /lineKinds/i,
    /cm-md-(?!blank\b)/i,
    // R9: タイピング音。
    /typingSound/i,
    /typing-sound/i,
    /typing sound/i,
  ];

  it('has no plugin names in the host files (typewriter, focusMode, focusRange, cm-md-dim, setFocusMode, listContinuation, insertNewlineContinue, setListContinuation, markupDisplay, liveMarkup, taskToggle, linkOpen, markdownDecorations, lineKinds, cm-md-* except cm-md-blank, typingSound, typing-sound; any case, comments included)', () => {
    const hits = HOST.flatMap((f) => {
      const text = readFileSync(path.join(SRC, f), 'utf8');
      return NAMES.filter((n) => n.test(text)).map((n) => `${f}: ${n.source}`);
    });
    expect(hits).toEqual([]);
  });

  it('cm-md-blank (the blank line of plain text, owned by the host) is the only cm-md- name the host may have', () => {
    const blank = NAMES.find((n) => n.source.includes('cm-md-(?!'))!;
    expect(blank.test('.cm-md-blank')).toBe(false);
    expect(blank.test("'.cm-md-blank': {")).toBe(false);
    expect(blank.test('cm-md-blankish')).toBe(true);
    expect(blank.test('cm-md-bullet')).toBe(true);
  });

  it('the name check itself catches each name (guards against a pattern that silently matches nothing)', () => {
    for (const sample of [
      'TypeWriter',
      'prefs.focusMode',
      'FOCUSRANGE',
      "'.cm-md-dim'",
      'adapter.setFocusMode(true)',
      'prefs.listContinuation',
      'type ListContinuation',
      'LISTCONTINUATION',
      'insertNewlineContinueTight',
      'adapter.setListContinuation(mode)',
      'prefs.markupDisplay',
      'type MarkupDisplay',
      'import { collectMarkup } from ./liveMarkup',
      'TaskToggle',
      'LINKOPEN',
      "from './markdownDecorations'",
      'lineKinds',
      "'.cm-md-h1'",
      "'cm-md-task-done'",
      'prefs.typingSound',
      'prefs.typingSoundVolume',
      "from './features/typing-sound'",
      'the typing sound plugin',
    ]) {
      expect(NAMES.some((n) => n.test(sample)), sample).toBe(true);
    }
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

describe('the e2e-only probe of the typing sound does not reach the production bundle (ADR-002, R9)', () => {
  const MARK = '__mdeE2ETypingSound';
  const all = listFiles(SRC);
  const code = (f: string) => readFileSync(f, 'utf8');

  it('among the files that can be bundled (not tests), the mark string is only in e2eProbe.ts', () => {
    const carriers = all.filter((f) => !/\.test\./.test(f) && code(f).includes(MARK)).map(rel).sort();
    expect(carriers).toEqual(['features/typing-sound/e2eProbe.ts']);
  });

  it('the only non-test use of the probe is behind __E2E__, so the build constant false removes it', () => {
    const users = all.filter((f) => !/\.test\./.test(f) && /createTypingSoundE2EProbe/.test(code(f)) && !f.endsWith('e2eProbe.ts'));
    expect(users.map(rel)).toEqual(['features/typing-sound/index.ts']);
    const body = code(users[0]!);
    expect([...body.matchAll(/createTypingSoundE2EProbe\(\)/g)]).toHaveLength(1);
    expect(body).toMatch(/__E2E__\s*\?\s*createTypingSoundE2EProbe\(\)\s*:\s*undefined/);
  });

  it('__E2E__ is true only for VITE_E2E=1 (vite.config.ts), and check-probe-absent looks for the mark in dist/', () => {
    const config = readFileSync(path.resolve(SRC, '..', 'vite.config.ts'), 'utf8');
    expect(config).toMatch(/__E2E__:\s*JSON\.stringify\(process\.env\.VITE_E2E === '1'\)/);
    const checker = readFileSync(path.resolve(SRC, '..', '.pi/skills/verify-mydocuments/scripts/check-probe-absent.mjs'), 'utf8');
    expect(checker).toContain(`'${MARK}'`);
  });
});
