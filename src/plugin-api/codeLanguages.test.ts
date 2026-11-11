import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODE_LANGUAGE_RETRY_MS,
  PLAIN_LANGUAGE_NAMES,
  SHORT_LANGUAGE_NAMES,
  isKnownLanguageName,
  languageCandidates,
  matchCodeLanguage,
  resolveCodeLanguage,
} from './codeLanguages';

const nameOf = (info: string) => matchCodeLanguage(info)?.name ?? null;

describe('how the language of a code block is chosen (ADR-004 追補（コードブロック）)', () => {
  it('1: matches a name or an alias exactly, ignoring case', () => {
    expect(nameOf('python')).toBe('Python');
    expect(nameOf('Python')).toBe('Python');
    expect(nameOf('TYPESCRIPT')).toBe('TypeScript');
    expect(nameOf('ts')).toBe('TypeScript');
    expect(nameOf('tsx')).toBe('TSX');
    expect(nameOf('js')).toBe('JavaScript');
    expect(nameOf('jsx')).toBe('JSX');
    expect(nameOf('sh')).toBe('Shell');
    expect(nameOf('bash')).toBe('Shell');
    expect(nameOf('zsh')).toBe('Shell');
    expect(nameOf('shell')).toBe('Shell');
    expect(nameOf('yml')).toBe('YAML');
    expect(nameOf('c++')).toBe('C++');
    expect(nameOf('cs')).toBe('C#');
    expect(nameOf('rb')).toBe('Ruby');
    expect(nameOf('Dockerfile')).toBe('Dockerfile');
  });

  it('2: matches the short names of the table, and every target of the table exists in language-data', () => {
    expect(nameOf('py')).toBe('Python');
    expect(nameOf('rs')).toBe('Rust');
    expect(nameOf('md')).toBe('Markdown');
    expect(nameOf('golang')).toBe('Go');
    expect(nameOf('kt')).toBe('Kotlin');
    expect(nameOf('ps1')).toBe('PowerShell');
    expect(nameOf('PY')).toBe('Python');
    const known = new Set(languages.map((l) => l.name));
    for (const [short, target] of Object.entries(SHORT_LANGUAGE_NAMES)) {
      expect(known.has(target), `${short} -> ${target}`).toBe(true);
      expect(short, 'a short name is lowercase').toBe(short.toLowerCase());
    }
    // 表には、language-data の別名にないものだけを載せる（別名にあるものは 1 の規則で選ばれる）。
    for (const short of Object.keys(SHORT_LANGUAGE_NAMES)) {
      expect(LanguageDescription.matchLanguageName(languages, short, false), short).toBeNull();
    }
  });

  it('3: matches a file name or an extension', () => {
    expect(nameOf('main.py')).toBe('Python');
    expect(nameOf('Main.PY')).toBe('Python');
    expect(nameOf('app.tsx')).toBe('TSX');
    expect(nameOf('index.html')).toBe('HTML');
    expect(nameOf('lib.rs')).toBe('Rust');
    expect(nameOf('Dockerfile')).toBe('Dockerfile');
    expect(nameOf('Gemfile')).toBe('Ruby');
    expect(nameOf('script.sh')).toBe('Shell');
    expect(nameOf('a/b/config.yaml')).toBe('YAML');
  });

  it('4: reads language:filename (Zenn and Qiita), and :filename', () => {
    expect(nameOf('python:main.py')).toBe('Python');
    expect(nameOf('ts:src/index.ts')).toBe('TypeScript');
    expect(nameOf('py:foo.txt')).toBe('Python');
    expect(nameOf(':main.py')).toBe('Python');
    expect(nameOf(':Dockerfile')).toBe('Dockerfile');
    // 言語が書いてあれば、言語だけで選ぶ。分からない言語は、ファイル名が分かっても色なし。
    expect(nameOf('foo:main.py')).toBeNull();
    expect(nameOf('text:main.py')).toBeNull();
    expect(nameOf(':')).toBeNull();
    expect(nameOf('python:')).toBe('Python');
  });

  it('uses no fuzzy matching: text, txt, plain, plaintext, an empty string and unknown names get no language', () => {
    for (const name of [...PLAIN_LANGUAGE_NAMES, 'Text', 'PLAINTEXT', '', '  ', 'nonexistent', 'foo', 'p', 'java-script', 'typescripts', 'my-python', 'v1.2', 'notes.txt', 'notes.text', 'readme', 'x.unknownext']) {
      expect(matchCodeLanguage(name), JSON.stringify(name)).toBeNull();
    }
    // language-data の fuzzy では、text は LaTeX に当たってしまう。
    expect(LanguageDescription.matchLanguageName(languages, 'text', true)?.name).toBe('LaTeX');
    expect(nameOf('latex')).toBe('LaTeX');
    expect(nameOf('tex')).toBe('LaTeX');
  });

  it('looks only at the first word of the info string', () => {
    expect(nameOf('ts {1,3}')).toBe('TypeScript');
    expect(nameOf('  python title="a"')).toBe('Python');
    expect(nameOf('text python')).toBeNull();
  });

  it('knows which words are already a name (so no completion is needed)', () => {
    for (const w of ['ts', 'TS', 'py', 'python', 'text', 'txt', 'c++']) expect(isKnownLanguageName(w), w).toBe(true);
    for (const w of ['t', 'pyt', 'main.py', '', 'foo']) expect(isKnownLanguageName(w), w).toBe(false);
  });

  it('offers completion candidates from language-data and the table, one word each, without duplicates', () => {
    const labels = languageCandidates.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of ['python', 'ts', 'typescript', 'py', 'rs', 'md', 'golang', 'c++', 'yml', 'dockerfile']) expect(labels, l).toContain(l);
    for (const l of labels) expect(l).not.toMatch(/\s/);
    expect(labels).not.toContain('mariadb sql');
    expect(languageCandidates.find((c) => c.label === 'py')?.detail).toBe('Python');
    for (const c of languageCandidates) expect(matchCodeLanguage(c.label), c.label).not.toBeNull();
  });
});

describe('loading a language', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a lazy description: not loaded at first, loaded on demand, the same for the same language', async () => {
    const found = resolveCodeLanguage('rust')!;
    expect(found).toBeInstanceOf(LanguageDescription);
    expect(found.name).toBe('Rust');
    expect(resolveCodeLanguage('rs')).toBe(found);
    expect(resolveCodeLanguage('text')).toBeNull();
    expect(resolveCodeLanguage('nonexistent')).toBeNull();
    const support = await found.load();
    expect(support.language.name).toBe('rust');
    expect(found.support).toBe(support);
  });

  it('a failed load gives a colorless language, no rejection, and the load is tried again after a while', async () => {
    vi.useFakeTimers();
    const base = languages.find((l) => l.name === 'Lua')!;
    const failing = vi.spyOn(base, 'load').mockRejectedValueOnce(new Error('chunk failed'));
    const first = resolveCodeLanguage('lua')!;
    const support = await first.load();
    expect(support.language.parser).toBeDefined();
    expect(failing).toHaveBeenCalledTimes(1);
    // 失敗した直後は、同じ記述（読み込み済みの、色なしの言語）を返す。
    expect(resolveCodeLanguage('lua')).toBe(first);
    failing.mockRestore();
    await vi.advanceTimersByTimeAsync(CODE_LANGUAGE_RETRY_MS + 1);
    const again = resolveCodeLanguage('lua')!;
    expect(again).not.toBe(first);
    const real = await again.load();
    expect(real.language.name).toBe('lua');
  });
});
