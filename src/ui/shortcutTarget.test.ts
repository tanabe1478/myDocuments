// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { isTextEntryTarget, shouldRunPluginCommand } from './shortcuts';

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

describe('shouldRunPluginCommand', () => {
  const body = () => mount('<input id="i"><div class="cm-editor"><div class="cm-content" contenteditable="true" id="e"></div></div>');
  const modeToggle = { ignoreInTextEntry: true };
  const anywhere = { ignoreInTextEntry: false };

  it('ignores the mode toggles (ignoreInTextEntry) while an input has focus', () => {
    const input = body().querySelector('#i');
    expect(shouldRunPluginCommand(modeToggle, input)).toBe(false);
  });

  it('runs a command that does not ask to be ignored, even in an input', () => {
    const input = body().querySelector('#i');
    expect(shouldRunPluginCommand(anywhere, input)).toBe(true);
  });

  it('runs the mode toggles in the editor body and elsewhere', () => {
    const editor = body().querySelector('#e');
    expect(shouldRunPluginCommand(modeToggle, editor)).toBe(true);
    expect(shouldRunPluginCommand(modeToggle, document.body)).toBe(true);
    expect(shouldRunPluginCommand(modeToggle, null)).toBe(true);
  });
});
