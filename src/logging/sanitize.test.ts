import { describe, expect, it } from 'vitest';
import { basenameOf, clip, errorFields, errorKind, scrubHome } from './sanitize';

describe('scrubHome', () => {
  it('replaces the home directory of macOS, Linux and Windows paths with ~ (the rest of the path stays)', () => {
    expect(scrubHome('open /Users/alice/Documents/note.md failed')).toBe('open ~/Documents/note.md failed');
    expect(scrubHome('/home/bob/.config/app')).toBe('~/.config/app');
    expect(scrubHome('C:\\Users\\carol\\Documents\\a.md')).toBe('~\\Documents\\a.md');
    expect(scrubHome('c:/users/carol/a.md')).toBe('~/a.md');
    expect(scrubHome('file:///Users/alice/a.md')).toBe('file://~/a.md');
    expect(scrubHome('/Users/あいう/メモ.md')).toBe('~/メモ.md');
  });

  it('replaces every occurrence, and a home directory at the end or inside quotes', () => {
    expect(scrubHome('from /Users/a/x to /Users/b/y')).toBe('from ~/x to ~/y');
    expect(scrubHome('home=/Users/alice')).toBe('home=~');
    expect(scrubHome('"/Users/alice/a" and (/home/bob/b)')).toBe('"~/a" and (~/b)');
  });

  it('leaves text without a home directory alone', () => {
    for (const text of ['', 'plain text', 'Cannot read properties of undefined', '/usr/local/bin', 'src/App.tsx', '/Users/', '/Users']) {
      expect(scrubHome(text)).toBe(text);
    }
  });
});

describe('clip', () => {
  it('cuts to 300 characters by default (code points) after replacing the home path', () => {
    expect(clip('a'.repeat(300))).toHaveLength(300);
    expect(clip('a'.repeat(301))).toHaveLength(300);
    expect(Array.from(clip('😀'.repeat(400)))).toHaveLength(300);
    // 置き換えてから切る（置き換えで短くなった分、後ろまで残る）。
    expect(clip(`/Users/alice/${'a'.repeat(300)}`)).toBe(`~/${'a'.repeat(298)}`);
  });

  it('takes another limit', () => {
    expect(clip('abcdef', 3)).toBe('abc');
  });
});

describe('basenameOf', () => {
  it('returns the last name of a URL or a path, without the query and the hash', () => {
    expect(basenameOf('tauri://localhost/assets/index-AbC123.js')).toBe('index-AbC123.js');
    expect(basenameOf('http://127.0.0.1:4173/assets/index-x.js?v=1#top')).toBe('index-x.js');
    expect(basenameOf('/Users/alice/work/app.js')).toBe('app.js');
    expect(basenameOf('C:\\Users\\alice\\app.js')).toBe('app.js');
  });

  it('is null when there is no name', () => {
    expect(basenameOf('')).toBeNull();
    expect(basenameOf('/')).toBeNull();
  });
});

describe('errorKind and errorFields', () => {
  it('uses the error name, and the kind of a BridgeError-like error, never the message', () => {
    class BridgeLike extends Error {
      constructor(readonly kind: string) {
        super('secret /Users/alice/a.md');
        this.name = 'BridgeError';
      }
    }
    expect(errorKind(new BridgeLike('not-found'))).toEqual({ error: 'BridgeError', kind: 'not-found' });
    expect(errorKind(new TypeError('x'))).toEqual({ error: 'TypeError' });
    expect(errorKind('text')).toEqual({ error: 'string' });
    expect(errorKind({ a: 1 })).toEqual({ error: 'object' });
    expect(errorKind(undefined)).toEqual({ error: 'undefined' });
    expect(JSON.stringify(errorKind(new BridgeLike('io')))).not.toContain('secret');
  });

  it('adds the message cut to 300 characters with the home path replaced', () => {
    const fields = errorFields(new RangeError(`bad /Users/alice/x ${'z'.repeat(400)}`));
    expect(fields.error).toBe('RangeError');
    expect(fields.message.startsWith('bad ~/x zzz')).toBe(true);
    expect(fields.message).toHaveLength(300);
    expect(errorFields('a string reason')).toEqual({ error: 'string', message: 'a string reason' });
    expect(errorFields({ any: 'object' })).toEqual({ error: 'object', message: '' });
  });
});
