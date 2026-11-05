import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// relay.js（sandbox の iframe の中の仲介のコード）を、偽の window・Worker・Blob の上で動かして確かめる。
// 部品のコードは動かない（Blob にして Worker に渡すだけ）ことを、渡した Blob の中身と、Worker の作成の呼び出しで見る。
// テストの側が vm で動かすのは relay.js 自身と、Worker の前置き（部品のコードの前に置く文字列）だけ。

const RELAY = readFileSync(new URL('./relay.js', import.meta.url), 'utf8');

class FakeWorker {
  static all: FakeWorker[] = [];
  sent: unknown[] = [];
  terminated = 0;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onerror: ((e: { message?: string; preventDefault(): void }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWorker.all.push(this);
  }
  postMessage(m: unknown) {
    this.sent.push(m);
  }
  terminate() {
    this.terminated++;
  }
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}

function boot() {
  FakeWorker.all = [];
  const blobs = new Map<string, unknown[]>();
  const revoked: string[] = [];
  const toMain: unknown[] = [];
  const listeners: Array<(e: { source: unknown; data: unknown }) => void> = [];
  const mainWindow = { postMessage: (m: unknown, target: string) => toMain.push({ m, target }) };
  let n = 0;
  const context = {
    window: { parent: mainWindow, addEventListener: (_: string, l: never) => listeners.push(l) },
    Worker: FakeWorker,
    Blob: class {
      constructor(readonly parts: unknown[]) {}
    },
    URL: {
      createObjectURL: (b: { parts: unknown[] }) => {
        const url = `blob:null/${++n}`;
        blobs.set(url, b.parts);
        return url;
      },
      revokeObjectURL: (u: string) => revoked.push(u),
    },
    Map,
    Set,
    Object,
    Array,
    Number,
    String,
  };
  vm.runInNewContext(RELAY, context);
  const fromMain = (data: unknown) => listeners.forEach((l) => l({ source: mainWindow, data }));
  const from = (source: unknown, data: unknown) => listeners.forEach((l) => l({ source, data }));
  const sent = () => toMain.map((x) => (x as { m: unknown }).m);
  return { fromMain, from, sent, toMain, blobs, revoked, listenerCount: () => listeners.length };
}

const start = (plugin = 'a', source = 'api.registerCommand({})') => ({ v: 0, kind: 'start', plugin, source });

describe('relay.js', () => {
  it('says hello to the parent when it is ready, with target origin "*" (the iframe origin is opaque, so nothing else can match)', () => {
    const r = boot();
    expect(r.sent()).toEqual([{ kind: 'hello', v: 0 }]);
    expect((r.toMain[0] as { target: string }).target).toBe('*');
  });

  it('ignores messages whose source is not the parent window', () => {
    const r = boot();
    r.from({ other: true }, start());
    expect(FakeWorker.all).toHaveLength(0);
  });

  it('makes a Worker from a blob of [prelude, source] and does not evaluate the source itself', () => {
    const r = boot();
    r.fromMain(start('a', 'SOURCE-TEXT'));
    expect(FakeWorker.all).toHaveLength(1);
    const worker = FakeWorker.all[0]!;
    const parts = r.blobs.get(worker.url)!;
    expect(parts).toHaveLength(3);
    expect(String(parts[0])).toContain('registerCommand');
    expect(parts[1]).toBe('SOURCE-TEXT');
    expect(worker.sent).toEqual([{ kind: 'init' }]);
  });

  it('does not start a part twice, and validates what the parent sends', () => {
    const r = boot();
    r.fromMain(start('a'));
    r.fromMain(start('a'));
    r.fromMain({ ...start('b'), extra: 1 });
    r.fromMain({ ...start('Bad Id') });
    r.fromMain({ v: 1, kind: 'start', plugin: 'c', source: 'x' });
    r.fromMain({ v: 0, kind: 'start', plugin: 'd', source: 5 });
    r.fromMain({ v: 0, kind: 'unknown', plugin: 'a' });
    r.fromMain(null);
    expect(FakeWorker.all).toHaveLength(1);
  });

  it('forwards the decided messages, adding the plugin id, and numbers pass through', () => {
    const r = boot();
    r.fromMain(start('a'));
    const w = FakeWorker.all[0]!;
    w.emit({ kind: 'command', id: 'copy', title: 'コピー', shortcut: 'Mod+Alt+C', ignoreInTextEntry: true });
    w.emit({ kind: 'ready' });
    r.fromMain({ v: 0, kind: 'run', plugin: 'a', req: 7, command: 'copy' });
    expect(w.sent.at(-1)).toEqual({ kind: 'run', req: 7, command: 'copy' });
    w.emit({ kind: 'done', req: 7 });
    r.fromMain({ v: 0, kind: 'run', plugin: 'a', req: 8, command: 'copy' });
    w.emit({ kind: 'failed', req: 8, reason: 'boom' });
    expect(r.sent().slice(1)).toEqual([
      { kind: 'command', plugin: 'a', id: 'copy', title: 'コピー', shortcut: 'Mod+Alt+C', ignoreInTextEntry: true, v: 0 },
      { kind: 'ready', plugin: 'a', v: 0 },
      { kind: 'done', plugin: 'a', req: 7, v: 0 },
      { kind: 'failed', plugin: 'a', req: 8, reason: 'boom', v: 0 },
    ]);
    expect(w.terminated).toBe(0);
  });

  it('does not run a command that was not registered, or before ready', () => {
    const r = boot();
    r.fromMain(start('a'));
    const w = FakeWorker.all[0]!;
    w.emit({ kind: 'command', id: 'copy', title: 't' });
    r.fromMain({ v: 0, kind: 'run', plugin: 'a', req: 1, command: 'copy' });
    w.emit({ kind: 'ready' });
    r.fromMain({ v: 0, kind: 'run', plugin: 'a', req: 2, command: 'other' });
    expect(w.sent).toEqual([{ kind: 'init' }]);
  });

  it.each([
    ['an unknown kind', { kind: 'steal' }],
    ['not an object', 'ready'],
    ['null', null],
    ['an array', [{ kind: 'ready' }]],
    ['an extra field in command', { kind: 'command', id: 'x', title: 't', extra: 1 }],
    ['a bad command id', { kind: 'command', id: 'Bad', title: 't' }],
    ['a long title', { kind: 'command', id: 'x', title: 't'.repeat(201) }],
    ['a non-string shortcut', { kind: 'command', id: 'x', title: 't', shortcut: 5 }],
    ['done for an unknown request', { kind: 'done', req: 5 }],
    ['failed for an unknown request', { kind: 'failed', req: 5, reason: 'x' }],
    ['ready with extra fields', { kind: 'ready', extra: 1 }],
  ])('terminates the worker and reports it stopped on %s', (_name, message) => {
    const r = boot();
    r.fromMain(start('a'));
    r.fromMain(start('b'));
    const [a, b] = FakeWorker.all as [FakeWorker, FakeWorker];
    a.emit(message);
    expect(a.terminated).toBe(1);
    expect(r.revoked).toContain(a.url);
    expect(r.sent().at(-1)).toMatchObject({ kind: 'stopped', plugin: 'a', v: 0 });
    expect((r.sent().at(-1) as { reason: string }).reason).toContain('不正なメッセージ');
    // 止めたあとは何も通さない。
    const count = r.sent().length;
    a.emit({ kind: 'command', id: 'late', title: 't' });
    a.emit({ kind: 'ready' });
    expect(r.sent()).toHaveLength(count);
    // ほかの部品は止めない。
    expect(b.terminated).toBe(0);
    b.emit({ kind: 'ready' });
    expect(r.sent().at(-1)).toMatchObject({ kind: 'ready', plugin: 'b' });
  });

  it('rejects a command after ready, a second ready, and the 33rd command', () => {
    const late = boot();
    late.fromMain(start('a'));
    FakeWorker.all[0]!.emit({ kind: 'ready' });
    FakeWorker.all[0]!.emit({ kind: 'command', id: 'x', title: 't' });
    expect(FakeWorker.all[0]!.terminated).toBe(1);

    const twice = boot();
    twice.fromMain(start('a'));
    FakeWorker.all[0]!.emit({ kind: 'ready' });
    FakeWorker.all[0]!.emit({ kind: 'ready' });
    expect(FakeWorker.all[0]!.terminated).toBe(1);

    const many = boot();
    many.fromMain(start('a'));
    for (let i = 0; i < 33; i++) FakeWorker.all[0]!.emit({ kind: 'command', id: `c${i}`, title: 't' });
    expect(FakeWorker.all[0]!.terminated).toBe(1);
    expect(many.sent().filter((m) => (m as { kind: string }).kind === 'command')).toHaveLength(32);
  });

  it('terminates on a script error and on an unreadable message', () => {
    const r = boot();
    r.fromMain(start('a'));
    r.fromMain(start('b'));
    const [a, b] = FakeWorker.all as [FakeWorker, FakeWorker];
    let prevented = false;
    a.onerror!({ message: 'Uncaught Error: activate boom', preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(a.terminated).toBe(1);
    expect(r.sent().at(-1)).toMatchObject({ kind: 'stopped', plugin: 'a' });
    expect((r.sent().at(-1) as { reason: string }).reason).toContain('activate boom');
    b.onmessageerror!();
    expect(b.terminated).toBe(1);
  });

  it('terminates on a stop from the parent, once, and the stopped part sends nothing more', () => {
    const r = boot();
    r.fromMain(start('a'));
    const w = FakeWorker.all[0]!;
    r.fromMain({ v: 0, kind: 'stop', plugin: 'a' });
    r.fromMain({ v: 0, kind: 'stop', plugin: 'a' });
    r.fromMain({ v: 0, kind: 'stop', plugin: 'ghost' });
    expect(w.terminated).toBe(1);
    w.emit({ kind: 'ready' });
    expect(r.sent()).toEqual([{ kind: 'hello', v: 0 }]);
  });

  it('reports a stopped part when the Worker cannot be created', () => {
    const r = boot();
    FakeWorker.all = [];
    // 作成に失敗する Worker に差し替えた環境で、もう一度起動する。
    const toMain: unknown[] = [];
    const listeners: Array<(e: { source: unknown; data: unknown }) => void> = [];
    const parent = { postMessage: (m: unknown) => toMain.push(m) };
    vm.runInNewContext(RELAY, {
      window: { parent, addEventListener: (_: string, l: never) => listeners.push(l) },
      Worker: class {
        constructor() {
          throw new Error('CSP blocked the worker');
        }
      },
      Blob: class {},
      URL: { createObjectURL: () => 'blob:null/x', revokeObjectURL: () => {} },
      Map,
      Set,
      Object,
      Array,
      Number,
      String,
    });
    listeners[0]!({ source: parent, data: start('a') });
    expect(toMain.at(-1)).toMatchObject({ kind: 'stopped', plugin: 'a' });
    expect((toMain.at(-1) as { reason: string }).reason).toContain('CSP blocked the worker');
    expect(r.listenerCount()).toBe(1);
  });
});

describe('the code that runs inside the Worker (the prelude)', () => {
  /** Worker の前置きを、偽の self の上で動かす。部品のコードは、前置きのあとに同じ文脈で動く。 */
  function inWorker(partSource: string) {
    const r = boot();
    r.fromMain(start('a', partSource));
    const w = FakeWorker.all[0]!;
    const [prelude, source] = r.blobs.get(w.url) as [string, string];
    const posted: unknown[] = [];
    // Worker では self がグローバルそのもの。
    const self: Record<string, unknown> = { postMessage: (m: unknown) => posted.push(m), setTimeout };
    self.self = self;
    const context = vm.createContext(self);
    vm.runInContext(`${prelude}\n${source}\n`, context);
    const deliver = (data: unknown) => (self.onmessage as (e: { data: unknown }) => void)({ data });
    return { posted, deliver, self };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('gives the part the api (the enumerable members are the whole list), and registration is only possible before init', async () => {
    const { posted, deliver, self } = inWorker(`api.registerCommand({ id: 'hi', title: 'Hi', shortcut: 'Mod+H', run: async () => {} });`);
    expect(Object.keys(self.api as object)).toEqual(['registerCommand', 'registerContextMenuItem', 'clipboard', 'document']);
    expect(Object.isFrozen(self.api)).toBe(true);
    expect(posted).toEqual([{ kind: 'command', id: 'hi', title: 'Hi', shortcut: 'Mod+H' }]);
    deliver({ kind: 'init' });
    expect(posted.at(-1)).toEqual({ kind: 'ready' });
    expect(() => (self.api as { registerCommand(r: unknown): void }).registerCommand({ id: 'late', title: 't', run: () => {} })).toThrow();
  });

  it('runs a command asynchronously and answers done or failed with the request number', async () => {
    const { posted, deliver } = inWorker(
      `api.registerCommand({ id: 'ok', title: 'ok', run: async () => { await null; } });
       api.registerCommand({ id: 'bad', title: 'bad', run: async () => { throw new Error('boom'); } });
       api.registerCommand({ id: 'sync-bad', title: 'sync', run: () => { throw new Error('sync boom'); } });`,
    );
    deliver({ kind: 'init' });
    posted.length = 0;
    deliver({ kind: 'run', req: 1, command: 'ok' });
    deliver({ kind: 'run', req: 2, command: 'bad' });
    deliver({ kind: 'run', req: 3, command: 'sync-bad' });
    deliver({ kind: 'run', req: 4, command: 'missing' });
    await settle();
    expect(posted).toEqual(
      expect.arrayContaining([
        { kind: 'done', req: 1 },
        { kind: 'failed', req: 2, reason: 'boom' },
        { kind: 'failed', req: 3, reason: 'sync boom' },
        { kind: 'failed', req: 4, reason: '登録されていないコマンドです' },
      ]),
    );
    expect(posted).toHaveLength(4);
  });

  it('rejects malformed registrations inside the Worker (a part error, not a message)', () => {
    for (const bad of [
      `api.registerCommand({ id: 'Bad', title: 't', run() {} })`,
      `api.registerCommand({ id: 'x', title: '', run() {} })`,
      `api.registerCommand({ id: 'x', title: 't' })`,
      `api.registerCommand(null)`,
      `api.registerCommand({ id: 'x', title: 't', run() {} }); api.registerCommand({ id: 'x', title: 't', run() {} })`,
    ]) {
      expect(() => inWorker(bad), bad).toThrow();
    }
  });
});
