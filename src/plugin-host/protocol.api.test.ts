import { describe, expect, it } from 'vitest';
import { LIMITS, parseRelayMessage, resultMessage, runMenuMessage } from './protocol';

// R6: 仲介 → 本体のメッセージ（menu、call）の形の検査と、本体 → 仲介のメッセージ（runMenu、result）の作り方。relay.js の検査と同じ規則。

const ok = (data: unknown) => parseRelayMessage(data);

describe('parseRelayMessage: menu', () => {
  it('accepts the exact shape', () => {
    expect(ok({ v: 0, kind: 'menu', plugin: 'a', id: 'copy', title: 'コピー', where: 'tree' })).toEqual({ ok: true, message: { kind: 'menu', plugin: 'a', id: 'copy', title: 'コピー', where: 'tree' } });
  });
  it.each([
    ['another place', { where: 'editor' }],
    ['no place', { where: undefined }],
    ['an uppercase id', { id: 'Copy' }],
    ['an empty title', { title: '' }],
    ['a title over the limit', { title: 'x'.repeat(LIMITS.titleLength + 1) }],
    ['an extra field', { run: 'x' }],
  ])('rejects %s', (_n, over) => {
    expect(ok({ v: 0, kind: 'menu', plugin: 'a', id: 'copy', title: 't', where: 'tree', ...over }).ok).toBe(false);
  });
});

describe('parseRelayMessage: call', () => {
  it('accepts the two methods with their exact fields', () => {
    expect(ok({ v: 0, kind: 'call', plugin: 'a', call: 3, method: 'clipboardWriteText', text: '/a' })).toEqual({
      ok: true,
      message: { kind: 'call', plugin: 'a', call: 3, method: 'clipboardWriteText', text: '/a' },
    });
    expect(ok({ v: 0, kind: 'call', plugin: 'a', call: 1, method: 'currentPath' })).toEqual({ ok: true, message: { kind: 'call', plugin: 'a', call: 1, method: 'currentPath' } });
    // 上限ちょうどの文字数。
    expect(ok({ v: 0, kind: 'call', plugin: 'a', call: 1, method: 'clipboardWriteText', text: 'x'.repeat(LIMITS.clipboardTextLength) }).ok).toBe(true);
  });
  it.each([
    ['an unknown method', { method: 'readClipboard' }],
    ['text on currentPath', { method: 'currentPath', text: 'x' }],
    ['no text on a write', { method: 'clipboardWriteText' }],
    ['an empty text', { method: 'clipboardWriteText', text: '' }],
    ['a text over the limit', { method: 'clipboardWriteText', text: 'x'.repeat(LIMITS.clipboardTextLength + 1) }],
    ['a non-string text', { method: 'clipboardWriteText', text: 1 }],
    ['number 0', { method: 'currentPath', call: 0 }],
    ['a non-integer number', { method: 'currentPath', call: 1.5 }],
    ['a string number', { method: 'currentPath', call: '1' }],
    ['a bad plugin id', { method: 'currentPath', plugin: 'A b' }],
    ['an extra field', { method: 'currentPath', extra: 1 }],
  ])('rejects %s', (_n, over) => {
    expect(ok({ v: 0, kind: 'call', plugin: 'a', call: 1, ...over }).ok).toBe(false);
  });
  it('rejects a wrong protocol version', () => {
    expect(ok({ v: 1, kind: 'call', plugin: 'a', call: 1, method: 'currentPath' }).ok).toBe(false);
  });
});

describe('messages from the host to the relay', () => {
  it('builds runMenu and result messages with the version', () => {
    expect(runMenuMessage('a', 2, 'copy', '/w/a.md', 'file')).toEqual({ v: 0, kind: 'runMenu', plugin: 'a', req: 2, item: 'copy', path: '/w/a.md', targetKind: 'file' });
    expect(resultMessage('a', 4, { ok: true, value: null })).toEqual({ v: 0, kind: 'result', plugin: 'a', call: 4, ok: true, value: null });
    expect(resultMessage('a', 4, { ok: true, value: '/p' })).toEqual({ v: 0, kind: 'result', plugin: 'a', call: 4, ok: true, value: '/p' });
  });
  it('cuts a long reason to the limit and never sends an empty one (the relay would refuse it)', () => {
    const long = resultMessage('a', 1, { ok: false, reason: 'x'.repeat(1000) });
    expect(long.kind === 'result' && !long.ok && long.reason.length).toBe(LIMITS.reasonLength);
    const empty = resultMessage('a', 1, { ok: false, reason: '' });
    expect(empty.kind === 'result' && !empty.ok && empty.reason).toBe('error');
  });
});
