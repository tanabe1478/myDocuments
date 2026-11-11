/*
 * コードブロックの言語の選び方（ADR-004 追補（コードブロック））。開きのフェンスの情報文字列（``` の後ろの文字列）から、色を付ける言語を決める。
 * 本体（Markdown の言語に渡す codeLanguages）と、言語名の補完を出す Markdown の部品が、同じ表を使う。
 *
 * 選ぶ順（最初に決まったものを使う。あいまい照合は使わない）:
 *   1. 名前と別名の完全一致（大文字小文字を区別しない）。
 *   2. よく使う短い名前の表（SHORT_LANGUAGE_NAMES）。
 *   3. ファイル名か拡張子（main.py、Dockerfile）。
 *   4. 言語:ファイル名（Zenn と Qiita の書き方。python:main.py、:main.py）。
 * text、txt、plain、plaintext と、分からない名前は、色を付けない（null）。
 *
 * 言語は使うときに読み込む（@codemirror/language-data の遅延読み込み）。読み込みの前と、読み込みに失敗したときは、色なしのまま。
 * 読み込みの失敗は、本文の表示と入力を止めず、コンソールにも出さない。一定時間の後、次の解析で読み込みを試し直す。
 */
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

/** 色を付けない名前（情報文字列の最初の語）。小文字で比べる。 */
export const PLAIN_LANGUAGE_NAMES: readonly string[] = ['text', 'txt', 'plain', 'plaintext'];

/**
 * よく使う短い名前から、language-data の言語名への表。language-data の別名にないものだけを載せる
 * （別名にあるもの: ts、tsx、js、jsx、sh、bash、zsh、shell、yml、c++、cs、rb など）。
 * 値は language-data にある言語の名前で、ないものは載せない（codeLanguages.test.ts が確かめる）。
 */
export const SHORT_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  py: 'Python',
  py3: 'Python',
  python3: 'Python',
  rs: 'Rust',
  md: 'Markdown',
  golang: 'Go',
  kt: 'Kotlin',
  kts: 'Kotlin',
  ps1: 'PowerShell',
  pwsh: 'PowerShell',
  hs: 'Haskell',
  ml: 'OCaml',
  jl: 'Julia',
  pl: 'Perl',
  fs: 'F#',
  vb: 'VB.NET',
  erl: 'Erlang',
  clj: 'Clojure',
  cljs: 'ClojureScript',
  proto: 'ProtoBuf',
  docker: 'Dockerfile',
  shellscript: 'Shell',
  jsonc: 'JSON',
  htm: 'HTML',
  svg: 'XML',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  h: 'C',
  hpp: 'C++',
  cc: 'C++',
  cxx: 'C++',
};

const byName = new Map<string, LanguageDescription>();
for (const d of languages) byName.set(d.name.toLowerCase(), d);

/** 別名（language-data）と短い名前の表を、小文字の名前から引く。 */
function byNameOrAlias(name: string): LanguageDescription | null {
  const lower = name.toLowerCase();
  const alias = LanguageDescription.matchLanguageName(languages, lower, false);
  if (alias) return alias;
  const short = SHORT_LANGUAGE_NAMES[lower];
  return short !== undefined ? (byName.get(short.toLowerCase()) ?? null) : null;
}

/** 拡張子が数字だけ（v1.2、man の節）か、素のテキストの拡張子（.text。language-data では LaTeX）のとき、色を付けない。 */
function fileLanguage(filename: string): LanguageDescription | null {
  const ext = /\.([^.]+)$/.exec(filename)?.[1];
  if (ext !== undefined && (/^\d+$/.test(ext) || PLAIN_LANGUAGE_NAMES.includes(ext.toLowerCase()))) return null;
  return LanguageDescription.matchFilename(languages, filename) ?? (ext !== undefined ? LanguageDescription.matchFilename(languages, filename.toLowerCase()) : null);
}

/** 情報文字列の最初の語から、language-data の言語を選ぶ（読み込みの仕組みを通す前の、素の記述）。選べなければ null。 */
export function matchCodeLanguage(info: string): LanguageDescription | null {
  const word = /\S*/.exec(info.trim())![0];
  if (word === '') return null;
  if (PLAIN_LANGUAGE_NAMES.includes(word.toLowerCase())) return null;
  // 1 と 2: 名前と別名、短い名前。
  const named = byNameOrAlias(word);
  if (named) return named;
  // 3: ファイル名か拡張子。
  const colon = word.indexOf(':');
  if (colon < 0) return fileLanguage(word);
  // 4: 言語:ファイル名。言語が書いてあれば言語だけで選び、言語が空（:main.py）のときだけファイル名で選ぶ。
  const lang = word.slice(0, colon);
  const file = word.slice(colon + 1);
  if (lang === '') return file === '' ? null : fileLanguage(file);
  if (PLAIN_LANGUAGE_NAMES.includes(lang.toLowerCase())) return null;
  return byNameOrAlias(lang);
}

/** 読み込みに失敗した言語の代わり。何も色を付けない。 */
const NO_COLOR = new LanguageSupport(
  StreamLanguage.define({
    token(stream) {
      stream.skipToEnd();
      return null;
    },
  }),
);

/** 読み込みに失敗してから、次の解析で読み込みを試し直すまでの時間。 */
export const CODE_LANGUAGE_RETRY_MS = 30_000;

/** 読み込みの失敗を握りつぶす言語の記述。language-data の記述ごとに 1 つ。 */
const safe = new WeakMap<LanguageDescription, LanguageDescription>();

function withSafeLoad(base: LanguageDescription): LanguageDescription {
  let wrapped = safe.get(base);
  if (wrapped) return wrapped;
  wrapped = LanguageDescription.of({
    name: base.name,
    alias: base.alias,
    extensions: base.extensions,
    filename: base.filename,
    load: () =>
      base.load().catch(() => {
        // 色なしで済ませ、しばらく後は新しい記述を作らせて、読み込みを試し直す（language-data の記述は、失敗を覚えていない）。
        setTimeout(() => safe.delete(base), CODE_LANGUAGE_RETRY_MS);
        return NO_COLOR;
      }),
  });
  safe.set(base, wrapped);
  return wrapped;
}

/**
 * Markdown の言語の codeLanguages に渡す関数。情報文字列から言語を選び、読み込みが済むまでは色なしにする
 * （読み込みが済むと、構文木が自動で解析し直される）。選べなければ null。
 */
export function resolveCodeLanguage(info: string): LanguageDescription | null {
  const found = matchCodeLanguage(info);
  return found ? withSafeLoad(found) : null;
}

/** 言語名の補完の候補 1 つ。label は、情報文字列に置く名前。 */
export interface LanguageCandidate {
  readonly label: string;
  /** 言語の正式な名前（TypeScript など）。 */
  readonly detail: string;
  /** よく使う言語を上に出すための重み。 */
  readonly boost: number;
}

const COMMON = new Set([
  'javascript', 'typescript', 'tsx', 'jsx', 'python', 'json', 'yaml', 'shell', 'html', 'css', 'sql', 'go', 'rust', 'java', 'c', 'c++', 'ruby', 'php', 'markdown', 'diff', 'dockerfile', 'toml', 'xml', 'kotlin', 'swift',
]);

function buildCandidates(): LanguageCandidate[] {
  const seen = new Map<string, LanguageCandidate>();
  const add = (label: string, detail: string) => {
    if (label === '' || /\s/.test(label) || seen.has(label)) return;
    seen.set(label, { label, detail, boost: COMMON.has(label) ? 1 : 0 });
  };
  for (const d of languages) for (const alias of d.alias) add(alias, d.name);
  for (const [short, target] of Object.entries(SHORT_LANGUAGE_NAMES)) add(short, target);
  return [...seen.values()];
}

/** 補完の候補。language-data の名前と別名と、短い名前の表。空白を含む別名（mariadb sql など）は情報文字列の最初の語にならないので除く。 */
export const languageCandidates: readonly LanguageCandidate[] = buildCandidates();

/** その語が、名前、別名、短い名前のどれかに完全一致するか（大文字小文字を区別しない）。 */
export function isKnownLanguageName(word: string): boolean {
  const lower = word.toLowerCase();
  return PLAIN_LANGUAGE_NAMES.includes(lower) || byNameOrAlias(lower) !== null;
}
