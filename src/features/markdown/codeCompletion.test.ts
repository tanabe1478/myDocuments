// @vitest-environment jsdom
import { CompletionContext, completionStatus, currentCompletions, selectedCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPluginRegistry, tabHandlers, type EditorExtensionEnvironment } from '../../plugin-api';
import { languageSource } from './codeCompletion';
import { markdownPlugin } from '.';

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  const rects = Object.assign([], { item: () => null });
  Range.prototype.getClientRects = () => rects as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Element.prototype.getClientRects = () => rects as unknown as DOMRectList;
});

let host: HTMLElement;
let view: EditorView | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  view?.destroy();
  view = null;
  host.remove();
});

const env: EditorExtensionEnvironment = { textKind: 'markdown', openExternalUrl: () => {}, isMacPlatform: () => false };

function stateOf(marked: string): EditorState {
  const state = EditorState.create({
    doc: marked.replace('|', ''),
    selection: { anchor: marked.indexOf('|') },
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, state.doc.length, 10_000);
  return state;
}

const source = (marked: string, explicit: boolean) => {
  const state = stateOf(marked);
  return languageSource(new CompletionContext(state, state.selection.main.head, explicit));
};

/** 本体と同じ並びの編集画面。Tab は、本体の字下げのキー割り当ての代わりに、部品の tabHandlers を呼ぶ。 */
function mount(marked: string): EditorView {
  const [ext] = createPluginRegistry([markdownPlugin]).editorExtensions;
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: marked.replace('|', ''),
      selection: { anchor: marked.indexOf('|') },
      extensions: [
        history(),
        markdown({ base: markdownLanguage }),
        ext!.create('cursorLine', env),
        keymap.of([{ key: 'Tab', run: (v) => v.state.facet(tabHandlers).some((h) => h(v, false)) }, ...defaultKeymap]),
      ],
    }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 10_000);
  view.dispatch({});
  return view;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timeout');
    await wait(10);
  }
}

/** 文字を打つ（input.type の transaction。補完は打った後に出る）。 */
function type(v: EditorView, s: string): void {
  const at = v.state.selection.main.head;
  v.dispatch({ changes: { from: at, insert: s }, selection: { anchor: at + s.length }, userEvent: 'input.type' });
}

function press(v: EditorView, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, code: key, keyCode: key === 'Enter' ? 13 : key === 'Tab' ? 9 : 0, bubbles: true, cancelable: true, ...init });
  v.contentDOM.dispatchEvent(event);
  return event;
}

describe('language completion source (ADR-004 追補（コードブロック）)', () => {
  it('offers the names for the first word of an opening fence, replacing the first word only (the range stops before the colon)', () => {
    const result = source('```p|', false)!;
    expect(result).not.toBeNull();
    expect({ from: result.from, to: result.to }).toEqual({ from: 3, to: 4 });
    const labels = result.options.map((o) => o.label);
    expect(labels).toEqual(expect.arrayContaining(['python', 'php', 'perl', 'py']));
    const withFile = source('```pyt|:main.py', false)!;
    expect({ from: withFile.from, to: withFile.to }).toEqual({ from: 3, to: 6 });
    const mid = source('```pyth|onx:main.py', false)!;
    expect({ from: mid.from, to: mid.to }).toEqual({ from: 3, to: 10 });
  });

  it('starts from the first typed character; with nothing typed, only on Ctrl+Space (explicit)', () => {
    expect(source('```|', false)).toBeNull();
    expect(source('```|', true)!.options.length).toBeGreaterThan(100);
    expect(source('``` |', false)).toBeNull();
    expect(source('~~~j|', false)).not.toBeNull();
  });

  it('does not open for a word that is already a name, alias or short name (so that Enter reaches the closing fence), unless asked', () => {
    for (const word of ['ts', 'TS', 'py', 'python', 'text', 'c++']) expect(source(`\`\`\`${word}|`, false), word).toBeNull();
    expect(source('```ts|', true)).not.toBeNull();
  });

  it('is only for the language part of an opening fence line', () => {
    expect(source('```python:ma|in.py', false)).toBeNull();
    expect(source('```ts ti|tle', false)).toBeNull();
    expect(source('```ts\nco|de\n```', false)).toBeNull();
    expect(source('```ts\nfoo\n```|', true)).toBeNull();
    expect(source('t|ext', true)).toBeNull();
    expect(source('# heading|', true)).toBeNull();
    expect(source('plain `code`|', true)).toBeNull();
    expect(source('```ts\n```j|\n```', false)).toBeNull();
  });
});

describe('language completion in the editor (ADR-004 追補（コードブロック）)', () => {
  it('opens when typing the first character after the fence, and the typed name closes it', async () => {
    const v = mount('```|');
    expect(completionStatus(v.state)).toBeNull();
    type(v, 'p');
    await waitFor(() => completionStatus(v.state) === 'active');
    expect(currentCompletions(v.state).map((c) => c.label)).toContain('python');
    type(v, 'yt');
    await waitFor(() => currentCompletions(v.state).length > 0 && currentCompletions(v.state)[0]!.label === 'python');
    // 名前に完全一致したら、補完を閉じる。
    type(v, 'hon');
    await waitFor(() => completionStatus(v.state) === null);
    expect(v.state.doc.toString()).toBe('```python');
  });

  it('Enter accepts the selected candidate, replacing the first word and keeping :filename', async () => {
    const v = mount('```p|:main.py');
    v.dispatch({ selection: { anchor: 4 } });
    // 開いたときに、Enter が届くまでの待ち（interactionDelay）を過ぎてから押す。
    type(v, 'yt');
    await waitFor(() => completionStatus(v.state) === 'active');
    await wait(120);
    expect(selectedCompletion(v.state)!.label).toBe('python');
    expect(press(v, 'Enter').defaultPrevented).toBe(true);
    expect(v.state.doc.toString()).toBe('```python:main.py');
    expect(v.state.doc.toString()).not.toContain('\n');
    expect(completionStatus(v.state)).toBeNull();
  });

  it('Tab accepts the selected candidate while the list is open, and does nothing special when it is not', async () => {
    const v = mount('```|');
    type(v, 'rus');
    await waitFor(() => completionStatus(v.state) === 'active');
    await wait(120);
    expect(selectedCompletion(v.state)!.label).toBe('rust');
    expect(press(v, 'Tab').defaultPrevented).toBe(true);
    expect(v.state.doc.toString()).toBe('```rust');
    // 開いていないとき: tabHandlers は受けない。
    const w = mount('plain|');
    expect(w.state.facet(tabHandlers).some((h) => h(w, false))).toBe(false);
    const x = mount('```ts|');
    expect(x.state.facet(tabHandlers).some((h) => h(x, false))).toBe(false);
  });

  it('Enter with the list closed is not taken by the completion (the closing fence is added)', async () => {
    const v = mount('```ts|');
    expect(press(v, 'Enter').defaultPrevented).toBe(true);
    expect(v.state.doc.toString()).toBe('```ts\n\n```');
  });

  it('Enter while the list is open on a name that is already complete is not swallowed: it adds the closing fence', async () => {
    const v = mount('```|');
    // 一覧を、Ctrl+Space で出す（完全一致の語でも出る）。
    type(v, 'ts');
    v.dispatch({ effects: [] });
    press(v, ' ', { ctrlKey: true, code: 'Space' });
    await waitFor(() => completionStatus(v.state) === 'active');
    await wait(120);
    expect(selectedCompletion(v.state)!.label).toBe('ts');
    press(v, 'Enter');
    expect(v.state.doc.toString()).toBe('```ts\n\n```');
  });

  it('Escape closes the list; the list does not open in the body text', async () => {
    const v = mount('```|');
    type(v, 'p');
    await waitFor(() => completionStatus(v.state) === 'active');
    press(v, 'Escape');
    expect(completionStatus(v.state)).toBeNull();
    const w = mount('hello|');
    type(w, ' wor');
    await wait(300);
    expect(completionStatus(w.state)).toBeNull();
  });

  it('draws the list without motion: the theme has no transition or animation', async () => {
    const v = mount('```|');
    type(v, 'p');
    await waitFor(() => completionStatus(v.state) === 'active');
    const css = Array.from(document.querySelectorAll('style'), (s) => s.textContent ?? '').join('\n');
    const ours = css.split('}').filter((rule) => rule.includes('cm-tooltip-autocomplete') && rule.includes('var(--md-color-panel)'));
    expect(ours.length).toBeGreaterThan(0);
    for (const rule of ours) expect(rule).not.toMatch(/transition|animation/);
  });
});
