import { describe, expect, it } from 'vitest';
import {
  MARKDOWN_EXTENSIONS,
  OPENABLE_EXTENSIONS,
  PLAIN_TEXT_EXTENSIONS,
  extensionOf,
  isOpenableFile,
  textKindOf,
} from './fileKinds';

describe('extensionOf', () => {
  it('lowercases and drops the dot', () => {
    expect(extensionOf('Note.MD')).toBe('md');
    expect(extensionOf('/a/b/readme.Markdown')).toBe('markdown');
    expect(extensionOf('C:\\docs\\memo.TXT')).toBe('txt');
  });

  it('uses the last dot only', () => {
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('v1.2.md')).toBe('md');
  });

  it('has no extension for a bare name, a trailing dot or a leading-dot name', () => {
    expect(extensionOf('Makefile')).toBe('');
    expect(extensionOf('name.')).toBe('');
    expect(extensionOf('.md')).toBe('');
    expect(extensionOf('/dir.d/Makefile')).toBe('');
  });
});

describe('openable files', () => {
  it('lists every Markdown and text extension, and nothing else', () => {
    expect([...OPENABLE_EXTENSIONS].sort()).toEqual(['markdown', 'md', 'mdown', 'mdx', 'mkd', 'text', 'txt']);
    expect(OPENABLE_EXTENSIONS).toEqual([...MARKDOWN_EXTENSIONS, ...PLAIN_TEXT_EXTENSIONS]);
  });

  it.each(['a.md', 'a.markdown', 'a.mdown', 'a.mkd', 'a.mdx', 'a.txt', 'a.text', 'A.MD', 'B.TXT', 'C.Text'])(
    'opens %s',
    (name) => expect(isOpenableFile(name)).toBe(true),
  );

  it.each(['a.png', 'a.json', 'a.mdc', 'a.md.bak', 'a', '.md', '.txt', 'a.textx', 'a.rtf'])(
    'does not open %s',
    (name) => expect(isOpenableFile(name)).toBe(false),
  );
});

describe('textKindOf', () => {
  it('is plain for .txt and .text only (case-insensitive)', () => {
    expect(textKindOf('/a/b.txt')).toBe('plain');
    expect(textKindOf('/a/b.TEXT')).toBe('plain');
  });

  it('is markdown for Markdown files, untitled documents and unknown extensions', () => {
    expect(textKindOf('/a/b.md')).toBe('markdown');
    expect(textKindOf('/a/b.mdx')).toBe('markdown');
    expect(textKindOf(null)).toBe('markdown');
    expect(textKindOf('/a/README')).toBe('markdown');
    expect(textKindOf('/a/b.log')).toBe('markdown');
  });
});
