import { describe, expect, it } from 'vitest';
import { LIMITS, PROTOCOL_VERSION, parseRelayMessage, runMessage, startMessage, stopMessage } from './protocol';

const ok = (data: unknown) => {
  const r = parseRelayMessage(data);
  if (!r.ok) throw new Error(r.problem);
  return r.message;
};
const bad = (data: unknown) => {
  const r = parseRelayMessage(data);
  expect(r.ok, JSON.stringify(data)).toBe(false);
};

describe('parseRelayMessage: accepts only the decided kinds in the decided shape', () => {
  it('accepts each kind', () => {
    expect(ok({ v: 0, kind: 'hello' })).toEqual({ kind: 'hello' });
    expect(ok({ v: 0, kind: 'command', plugin: 'a-1', id: 'copy', title: 'コピー' })).toEqual({ kind: 'command', plugin: 'a-1', id: 'copy', title: 'コピー' });
    expect(ok({ v: 0, kind: 'command', plugin: 'a', id: 'x', title: 't', shortcut: 'Mod+T', ignoreInTextEntry: true })).toEqual({
      kind: 'command',
      plugin: 'a',
      id: 'x',
      title: 't',
      shortcut: 'Mod+T',
      ignoreInTextEntry: true,
    });
    expect(ok({ v: 0, kind: 'ready', plugin: 'a' })).toEqual({ kind: 'ready', plugin: 'a' });
    expect(ok({ v: 0, kind: 'done', plugin: 'a', req: 3 })).toEqual({ kind: 'done', plugin: 'a', req: 3 });
    expect(ok({ v: 0, kind: 'failed', plugin: 'a', req: 3, reason: 'boom' })).toEqual({ kind: 'failed', plugin: 'a', req: 3, reason: 'boom' });
    expect(ok({ v: 0, kind: 'stopped', plugin: 'a', reason: 'boom' })).toEqual({ kind: 'stopped', plugin: 'a', reason: 'boom' });
  });

  it('rejects anything that is not a plain object, or has a wrong version', () => {
    for (const data of [null, undefined, 'ready', 1, true, [], [{ kind: 'hello' }], new Map(), Object.create({ kind: 'hello', v: 0 }), { kind: 'hello' }, { v: 1, kind: 'hello' }, { v: '0', kind: 'hello' }]) bad(data);
  });

  it('rejects unknown kinds and extra or missing fields', () => {
    bad({ v: 0, kind: 'steal' });
    bad({ v: 0, kind: 'invoke', cmd: 'open_document' });
    bad({ v: 0 });
    bad({ v: 0, kind: 'hello', extra: 1 });
    bad({ v: 0, kind: 'ready' });
    bad({ v: 0, kind: 'ready', plugin: 'a', extra: 1 });
    bad({ v: 0, kind: 'done', plugin: 'a' });
    bad({ v: 0, kind: 'done', plugin: 'a', req: 1, extra: 1 });
    bad({ v: 0, kind: 'command', plugin: 'a', id: 'x' });
    bad({ v: 0, kind: 'command', plugin: 'a', id: 'x', title: 't', extra: 1 });
    bad({ v: 0, kind: 'failed', plugin: 'a', req: 1 });
    bad({ v: 0, kind: 'stopped', plugin: 'a' });
  });

  it('checks types and lengths', () => {
    bad({ v: 0, kind: 'ready', plugin: 'A' });
    bad({ v: 0, kind: 'ready', plugin: '' });
    bad({ v: 0, kind: 'ready', plugin: 'a'.repeat(LIMITS.idLength + 1) });
    bad({ v: 0, kind: 'ready', plugin: 1 });
    for (const req of [0, -1, 1.5, NaN, Infinity, '1', null, 2 ** 53]) bad({ v: 0, kind: 'done', plugin: 'a', req });
    bad({ v: 0, kind: 'command', plugin: 'a', id: 'Bad Id', title: 't' });
    bad({ v: 0, kind: 'command', plugin: 'a', id: '', title: 't' });
    bad({ v: 0, kind: 'command', plugin: 'a', id: 'x', title: '' });
    bad({ v: 0, kind: 'command', plugin: 'a', id: 'x', title: 't'.repeat(LIMITS.titleLength + 1) });
    bad({ v: 0, kind: 'command', plugin: 'a', id: 'x', title: 7 });
    bad({ v: 0, kind: 'command', plugin: 'a', id: 'x', title: 't', shortcut: '' });
    bad({ v: 0, kind: 'command', plugin: 'a', id: 'x', title: 't', shortcut: 'M'.repeat(LIMITS.shortcutLength + 1) });
    bad({ v: 0, kind: 'command', plugin: 'a', id: 'x', title: 't', shortcut: 1 });
    bad({ v: 0, kind: 'command', plugin: 'a', id: 'x', title: 't', ignoreInTextEntry: 'yes' });
    bad({ v: 0, kind: 'failed', plugin: 'a', req: 1, reason: '' });
    bad({ v: 0, kind: 'failed', plugin: 'a', req: 1, reason: 'r'.repeat(LIMITS.reasonLength + 1) });
    bad({ v: 0, kind: 'stopped', plugin: 'a', reason: 'r'.repeat(LIMITS.reasonLength + 1) });
    bad({ v: 0, kind: 'stopped', plugin: 'a', reason: { message: 'x' } });
  });

  it('does not accept a payload that only looks like a plain object (a prototype with extra data)', () => {
    class Msg {
      v = 0;
      kind = 'hello';
    }
    bad(new Msg());
  });
});

describe('messages the host sends', () => {
  it('carry the protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(0);
    expect(startMessage('a', 'code')).toEqual({ v: 0, kind: 'start', plugin: 'a', source: 'code' });
    expect(runMessage('a', 2, 'x')).toEqual({ v: 0, kind: 'run', plugin: 'a', req: 2, command: 'x' });
    expect(stopMessage('a')).toEqual({ v: 0, kind: 'stop', plugin: 'a' });
  });
});
