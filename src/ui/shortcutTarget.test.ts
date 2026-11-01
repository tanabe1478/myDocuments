// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { isTextEntryTarget, shouldHandleShortcut } from './shortcuts';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isTextEntryTarget', () => {
  it('is true for input, textarea, select and contenteditable outside the editor', () => {
    const body = mount(
      '<input id="i"><textarea id="t"></textarea><select id="s"><option>a</option></select>' +
        '<div id="c" contenteditable="true"><span id="cc">x</span></div><div id="p" contenteditable="plaintext-only"></div>' +
        '<input id="r" type="range"><input id="k" type="checkbox">',
    );
    for (const id of ['i', 't', 's', 'c', 'cc', 'p', 'r', 'k']) {
      expect(isTextEntryTarget(body.querySelector(`#${id}`)), id).toBe(true);
    }
  });

  it('is false for the CodeMirror content, even though it is contenteditable', () => {
    const body = mount('<div class="cm-editor"><div class="cm-content" contenteditable="true"><div class="cm-line" id="l">x</div></div></div>');
    expect(isTextEntryTarget(body.querySelector('.cm-content'))).toBe(false);
    expect(isTextEntryTarget(body.querySelector('#l'))).toBe(false);
  });

  it('is true for an input inside the editor chrome (the search panel)', () => {
    const body = mount('<div class="cm-editor"><div class="cm-content" contenteditable="true"></div><div class="cm-panels"><input id="q"></div></div>');
    expect(isTextEntryTarget(body.querySelector('#q'))).toBe(true);
  });

  it('is false for buttons, contenteditable="false", the body and non-elements', () => {
    const body = mount('<button id="b">x</button><div id="n" contenteditable="false"></div><div id="d"></div>');
    for (const id of ['b', 'n', 'd']) expect(isTextEntryTarget(body.querySelector(`#${id}`)), id).toBe(false);
    expect(isTextEntryTarget(document.body)).toBe(false);
    expect(isTextEntryTarget(window)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});

describe('shouldHandleShortcut', () => {
  const body = () => mount('<input id="i"><div class="cm-editor"><div class="cm-content" contenteditable="true" id="e"></div></div>');

  it('ignores the mode toggles while an input has focus', () => {
    const input = body().querySelector('#i');
    expect(shouldHandleShortcut('focusMode', input)).toBe(false);
    expect(shouldHandleShortcut('typewriterMode', input)).toBe(false);
  });

  it('keeps the other shortcuts working in an input (panel toggle, save, fullscreen...)', () => {
    const input = body().querySelector('#i');
    for (const a of ['new', 'open', 'save', 'saveAs', 'settings', 'sidebar', 'fullscreen'] as const) {
      expect(shouldHandleShortcut(a, input), a).toBe(true);
    }
  });

  it('handles the mode toggles in the editor body and elsewhere', () => {
    const editor = body().querySelector('#e');
    expect(shouldHandleShortcut('focusMode', editor)).toBe(true);
    expect(shouldHandleShortcut('typewriterMode', editor)).toBe(true);
    expect(shouldHandleShortcut('focusMode', document.body)).toBe(true);
    expect(shouldHandleShortcut('focusMode', null)).toBe(true);
  });
});
