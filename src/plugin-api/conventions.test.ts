import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { AFTER_COMPOSITION_MS, DIMMED_BLOCK_CLASS, dimExemptLines, isDimmedBlock, tabHandlers } from '.';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(path.join(SRC, file), 'utf8');

describe('AFTER_COMPOSITION_MS (N-R2-3: one shared wait after an IME composition ends)', () => {
  it('is 60 ms (the value both users had before it was shared)', () => {
    expect(AFTER_COMPOSITION_MS).toBe(60);
  });

  it('is defined once, in the public API (src/plugin-api/conventions.ts)', () => {
    const definitions = ['plugin-api/conventions.ts', 'features/markdown/markdownDecorations.ts', 'features/focus/focusMode.ts'].filter((f) =>
      /\b(?:const|let|var)\s+AFTER_COMPOSITION_MS\b/.test(read(f)),
    );
    expect(definitions).toEqual(['plugin-api/conventions.ts']);
  });

  it('is used by the Markdown plugin (markup hiding) and by the focus plugin, both importing it from the public API', () => {
    for (const file of ['features/markdown/markdownDecorations.ts', 'features/focus/focusMode.ts']) {
      const code = read(file);
      expect(code, file).toMatch(/import\s*\{[^}]*\bAFTER_COMPOSITION_MS\b[^}]*\}\s*from\s*'(?:\.\.\/)+plugin-api'/);
      expect(code, file).toMatch(/\},\s*AFTER_COMPOSITION_MS\s*\)/);
    }
  });

  it('no other wait of 60 ms is left behind in the two files', () => {
    for (const file of ['features/markdown/markdownDecorations.ts', 'features/focus/focusMode.ts']) {
      expect(read(file), file).not.toMatch(/\b60\b/);
    }
  });
});

describe('isDimmedBlock (a block that the line decorations cannot reach asks whether to dim)', () => {
  const state = (...providers: Array<ReturnType<typeof dimExemptLines.of>>) => EditorState.create({ doc: 'a\nb\nc\nd\ne', extensions: providers });

  it('does not dim anything when no part provides an exempt range', () => {
    expect(isDimmedBlock(state(), 1, 5)).toBe(false);
  });

  it('dims a block that does not overlap the exempt range (lines are 1-based, both ends included), and not one that overlaps it, even partly', () => {
    const s = state(dimExemptLines.of(() => ({ from: 2, to: 3 })));
    expect(isDimmedBlock(s, 4, 5)).toBe(true);
    expect(isDimmedBlock(s, 1, 1)).toBe(true);
    expect(isDimmedBlock(s, 3, 4)).toBe(false);
    expect(isDimmedBlock(s, 1, 2)).toBe(false);
    expect(isDimmedBlock(s, 2, 3)).toBe(false);
  });

  it('does not dim when the part has nothing to keep (null), and reads the state it is given', () => {
    expect(isDimmedBlock(state(dimExemptLines.of(() => null)), 4, 5)).toBe(false);
    const s = state(dimExemptLines.of((st) => ({ from: st.doc.lines, to: st.doc.lines })));
    expect(isDimmedBlock(s, 1, 2)).toBe(true);
    expect(isDimmedBlock(s, 5, 5)).toBe(false);
  });

  it('has a class name that is a plain CSS identifier', () => {
    expect(DIMMED_BLOCK_CLASS).toMatch(/^[a-z][a-z-]*$/);
  });
});

describe('tabHandlers (a part may take Tab before the host indents)', () => {
  it('collects the handlers of every part, in order, and is empty when nothing provides one', () => {
    const a = () => true;
    const b = () => false;
    expect(EditorState.create({}).facet(tabHandlers)).toEqual([]);
    expect(EditorState.create({ extensions: [tabHandlers.of(a), tabHandlers.of(b)] }).facet(tabHandlers)).toEqual([a, b]);
  });
});
