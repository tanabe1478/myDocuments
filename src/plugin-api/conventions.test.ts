import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AFTER_COMPOSITION_MS } from '.';

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
