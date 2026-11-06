import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inWorker, settle } from './relayHarness';

// 同梱の段 2 の部品「アウトライン」（src/features/outline/worker.js）のコードを、relay.js が作る Worker の前置きの上で動かす。
// 見出しの抽出は、部品の公開 API（api.document.onDidChange）に本文を渡し、api.registerPanel の panel.setItems に出る項目で確かめる。

const SOURCE = readFileSync(new URL('../features/outline/worker.js', import.meta.url), 'utf8');
const LONGFORM = readFileSync(new URL('../../phase0/fixtures/perf/C-1mb-longform.md', import.meta.url), 'utf8');

type Posted = Record<string, unknown>;
interface Item {
  text: string;
  depth: number;
  offset: number;
}

function start() {
  const w = inWorker(SOURCE, 'outline');
  w.deliver({ kind: 'init' });
  w.posted.length = 0;
  return w;
}

const itemMessages = (w: { posted: Posted[] }) => w.posted.filter((m) => m.kind === 'items');
const lastItems = (w: { posted: Posted[] }) => itemMessages(w).at(-1) as { items: Item[]; current: number | null; version: number; empty: string | null; panel: string };

/** 本文を渡して、パネルに出る項目を返す。 */
async function headings(text: string, kind: 'markdown' | 'plain' = 'markdown'): Promise<Item[]> {
  const w = start();
  w.deliver({ kind: 'doc', version: 1, textKind: kind, text });
  await settle();
  return lastItems(w).items;
}
const texts = (items: Item[]) => items.map((i) => i.text);

describe('the outline part registers a panel and asks for nothing else', () => {
  it('registers one panel in its first run, and nothing else (no command, no menu item, no call)', () => {
    const w = inWorker(SOURCE, 'outline');
    expect(w.posted).toEqual([{ kind: 'panel', id: 'outline', title: 'アウトライン' }]);
  });

  it('sends nothing until it receives the document', async () => {
    const w = start();
    await settle();
    expect(w.posted).toEqual([]);
  });
});

describe('ATX headings (CommonMark)', () => {
  it('counts # to ###### with the depth (level - 1) and the offset of the start of the heading line', async () => {
    const text = '# one\n## two\n### three\n#### four\n##### five\n###### six\n';
    const items = await headings(text);
    expect(items).toEqual([
      { text: 'one', depth: 0, offset: 0 },
      { text: 'two', depth: 1, offset: 6 },
      { text: 'three', depth: 2, offset: 13 },
      { text: 'four', depth: 3, offset: 23 },
      { text: 'five', depth: 4, offset: 33 },
      { text: 'six', depth: 5, offset: 44 },
    ]);
    for (const item of items) expect(text.slice(item.offset).startsWith('#')).toBe(true);
  });

  it('allows up to 3 leading spaces, but not 4 (an indented code block) or a tab', async () => {
    expect(texts(await headings('   # three spaces\n    # four spaces\n\t# tab\n'))).toEqual(['three spaces']);
  });

  it('needs a space or a tab after the #s (or the end of the line): #hashtag and ####### are not headings', async () => {
    expect(texts(await headings('#hashtag\n####### seven\n#\ttab after\n# ok\n'))).toEqual(['tab after', 'ok']);
  });

  it('leaves out the closing sequence of #s (only when a space comes before it) and the spaces around the text', async () => {
    const items = await headings('# closed ##   \n## kept#\n### a \\###\n#### ####\n##### x # y ##\n###### \t spaced \t \n');
    expect(texts(items)).toEqual(['closed', 'kept#', 'a \\###', 'x # y', 'spaced']);
  });

  it('skips a heading with no text', async () => {
    expect(texts(await headings('#\n# \n## ##\n# real\n'))).toEqual(['real']);
  });

  it('counts a heading on the last line with no newline, and handles CRLF text', async () => {
    expect(texts(await headings('# a\n## b'))).toEqual(['a', 'b']);
    expect(texts(await headings('# a\r\n## b ##\r\n'))).toEqual(['a', 'b']);
  });

  it('does not count setext headings (an underline of = or -)', async () => {
    expect(await headings('Title\n=====\n\nSub\n-----\n')).toEqual([]);
  });

  it('keeps inline markup as written (no markup is interpreted)', async () => {
    expect(texts(await headings('# **bold** [link](x) `code` <b>x</b>\n'))).toEqual(['**bold** [link](x) `code` <b>x</b>']);
  });

  it('cuts a long heading at 200 characters with an ellipsis, without splitting a surrogate pair', async () => {
    const items = await headings(`# ${'あ'.repeat(300)}\n# ${'a'.repeat(198)}😀tail\n`);
    expect(items[0]!.text).toBe(`${'あ'.repeat(199)}…`);
    expect(items[0]!.text).toHaveLength(200);
    // 199 文字目が絵文字の前半になる位置では、その手前で切る。
    expect(items[1]!.text).toBe(`${'a'.repeat(198)}…`);
  });

  it('keeps at most 1000 items (the host stops a part that sends more)', async () => {
    const items = await headings(Array.from({ length: 1500 }, (_, i) => `# h${i}`).join('\n'));
    expect(items).toHaveLength(1000);
    expect(items[999]!.text).toBe('h999');
  });
});

describe('what is not counted', () => {
  it('headings inside a fenced code block (``` and ~~~) are not counted; the text after the closing fence is', async () => {
    const text = ['# before', '```sh', '# comment', '## another', '```', '## between', '~~~', '# in tilde', '~~~', '# after'].join('\n');
    expect(texts(await headings(text))).toEqual(['before', 'between', 'after']);
  });

  it('a fence closes only with the same character and at least the same length; an info string with a backtick is not a backtick fence', async () => {
    const text = ['````', '# a', '```', '# still code', '~~~~', '# still code', '````', '# out', '``` x`y', '# also out'].join('\n');
    expect(texts(await headings(text))).toEqual(['out', 'also out']);
  });

  it('an unclosed fence runs to the end of the document', async () => {
    expect(texts(await headings('# a\n```\n# b\n# c\n'))).toEqual(['a']);
  });

  it('a fence indented by 4 spaces is not a fence', async () => {
    expect(texts(await headings('    ```\n# counted\n'))).toEqual(['counted']);
  });

  it('the front matter at the top (--- to ---) is not counted; the heading right after it is', async () => {
    const text = '---\ntitle: x\n# not a heading\n---\n# first\n';
    const items = await headings(text);
    expect(items).toEqual([{ text: 'first', depth: 0, offset: text.indexOf('# first') }]);
  });

  it('a --- that is not on the first line is not a front matter; an unclosed one is not a front matter either', async () => {
    expect(texts(await headings('# a\n---\n# b\n---\n# c\n'))).toEqual(['a', 'b', 'c']);
    expect(texts(await headings('---\n# a\n# b\n'))).toEqual(['a', 'b']);
  });

  it('a plain text document has no headings, and says so', async () => {
    const w = start();
    w.deliver({ kind: 'doc', version: 3, textKind: 'plain', text: '# looks like a heading\n## another\n' });
    await settle();
    expect(lastItems(w)).toEqual({ kind: 'items', panel: 'outline', version: 3, items: [], current: null, empty: '見出しはありません' });
  });

  it('a Markdown document with no headings says the same', async () => {
    const w = start();
    w.deliver({ kind: 'doc', version: 1, textKind: 'markdown', text: 'just text\n' });
    await settle();
    expect(lastItems(w)).toMatchObject({ items: [], empty: '見出しはありません' });
  });
});

describe('the current section, and what is sent', () => {
  const text = 'intro\n# A\nbody\n## B\nbody\n# C\n';
  const offsetOf = (needle: string) => text.indexOf(needle);

  it('highlights the last heading at or before the cursor (null before the first heading)', async () => {
    const w = start();
    w.deliver({ kind: 'doc', version: 1, textKind: 'markdown', text });
    w.deliver({ kind: 'selection', version: 1, anchor: 0, head: 0 });
    await settle();
    expect(lastItems(w).current).toBeNull();
    for (const [head, expected] of [
      [offsetOf('# A'), 0],
      [offsetOf('body\n## B'), 0],
      [offsetOf('## B'), 1],
      [offsetOf('## B') + 3, 1],
      [offsetOf('# C') + 2, 2],
      [text.length, 2],
    ] as const) {
      w.deliver({ kind: 'selection', version: 1, anchor: head, head });
      await settle();
      expect(lastItems(w).current, `head ${head}`).toBe(expected);
    }
  });

  it('sends one message for a document and a selection that arrive together, and nothing for an unchanged result', async () => {
    const w = start();
    w.deliver({ kind: 'doc', version: 1, textKind: 'markdown', text });
    w.deliver({ kind: 'selection', version: 1, anchor: 8, head: 8 });
    await settle();
    expect(itemMessages(w)).toHaveLength(1);
    expect(lastItems(w)).toMatchObject({ version: 1, current: 0, items: [{ text: 'A' }, { text: 'B' }, { text: 'C' }] });
    // 同じ版・同じ内容・同じ強調は送らない。
    w.deliver({ kind: 'selection', version: 1, anchor: 9, head: 9 });
    w.deliver({ kind: 'doc', version: 1, textKind: 'markdown', text });
    await settle();
    expect(itemMessages(w)).toHaveLength(1);
    // 版が変われば、同じ項目でも送る（項目の版が古いままだと、本体は移さない）。
    w.deliver({ kind: 'doc', version: 2, textKind: 'markdown', text });
    await settle();
    expect(itemMessages(w)).toHaveLength(2);
    expect(lastItems(w).version).toBe(2);
  });

  it('every message it sends passes the host-side shape check', async () => {
    const w = start();
    w.deliver({ kind: 'doc', version: 1, textKind: 'markdown', text });
    await settle();
    const { parseRelayMessage } = await import('./protocol');
    // Worker は別の文脈（vm）なので、postMessage の構造化複製の代わりに、JSON を通して本体の文脈の値にする。
    expect(parseRelayMessage(JSON.parse(JSON.stringify({ v: 0, plugin: 'outline', ...lastItems(w) }))).ok).toBe(true);
  });
});

describe('the part code is a plain script that only uses the public API', () => {
  it('has no network, storage, evaluation, import, or self; uses only registerPanel and document.onDidChange / onDidChangeSelection', () => {
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const p of [/\bfetch\b/, /XMLHttpRequest/, /WebSocket/, /importScripts/, /\beval\b/, /new\s+Function/, /\bimport\b/, /localStorage/, /postMessage/, /\bself\b/, /innerHTML/]) expect(code, p.source).not.toMatch(p);
    expect([...new Set([...code.matchAll(/\bapi\.([A-Za-z.]+)/g)].map((m) => m[1]))].sort()).toEqual(['document.onDidChange', 'document.onDidChangeSelection', 'registerPanel']);
  });
});

describe('a 1 MB document (the C fixture)', () => {
  it('is read in the Worker without trouble: 7 chapters, offsets that point at the heading lines, in a short time', async () => {
    expect(LONGFORM.length).toBeGreaterThan(400_000);
    const w = start();
    const t0 = performance.now();
    w.deliver({ kind: 'doc', version: 1, textKind: 'markdown', text: LONGFORM });
    const compute = performance.now() - t0;
    await settle();
    const message = lastItems(w);
    expect(message.items.length).toBeGreaterThanOrEqual(7);
    for (const item of message.items) expect(LONGFORM.slice(item.offset, item.offset + item.depth + 2)).toBe(`${'#'.repeat(item.depth + 1)} `);
    // 目安（機械による）: 数十 ms。厳しく縛らず、桁が外れていないことだけを見る。計算は Worker の中で、本体の入力は待たない。
    expect(compute).toBeLessThan(500);
  });
});
