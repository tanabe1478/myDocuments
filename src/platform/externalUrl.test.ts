import { describe, expect, it } from 'vitest';
import { isOpenableExternalUrl } from './externalUrl';

describe('isOpenableExternalUrl', () => {
  it('http と https で、ホストのあるものだけを許可する', () => {
    for (const url of [
      'http://example.com',
      'https://example.com/path?q=1#frag',
      'https://example.com:8443/a',
      'https://user@example.com/',
      'http://127.0.0.1:4173/',
      'https://[::1]/',
      'HTTPS://EXAMPLE.COM/',
      'https://日本語.example/パス',
    ]) {
      expect(isOpenableExternalUrl(url), url).toBe(true);
    }
  });

  it('それ以外のスキームは許可しない', () => {
    for (const url of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'file:///etc/passwd',
      'mailto:a@example.com',
      'tel:+81312345678',
      'ftp://example.com/',
      'data:text/html,<b>x</b>',
      'vscode://open',
      'blob:https://example.com/uuid',
    ]) {
      expect(isOpenableExternalUrl(url), url).toBe(false);
    }
  });

  it('相対パス・アンカー・崩れた書き方・空白つきは許可しない', () => {
    for (const url of [
      '',
      ' ',
      '#section',
      './note.md',
      '../note.md',
      '/etc/passwd',
      'note.md',
      'example.com',
      '//example.com/',
      'https://',
      'http:///path',
      'https:example.com',
      ' https://example.com',
      'https://example.com ',
      'https://exa mple.com/',
    ]) {
      expect(isOpenableExternalUrl(url), JSON.stringify(url)).toBe(false);
    }
  });

  it('長すぎる URL は許可しない', () => {
    expect(isOpenableExternalUrl(`https://example.com/${'a'.repeat(8192)}`)).toBe(false);
  });
});
