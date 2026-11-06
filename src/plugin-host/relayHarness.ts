import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/*
 * relay.js を、偽の window・Worker・Blob の上で動かすテスト用の道具（relay.test.ts と同じ作り。R6 のテストが共有する）。
 * Worker の前置き（部品のコードの前に置く文字列）は、relay.js が Blob に渡したものを取り出し、偽の self の上で動かす。
 * テストの外（本番のコード）からは import されない。
 */

export const RELAY_SOURCE = readFileSync(new URL('./relay.js', import.meta.url), 'utf8');

export class FakeWorker {
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

/**
 * @param now 仲介が時刻を読む Date.now の代わり（setItems の頻度の上限の窓を、テストが進める）。省略は本物の Date。
 */
export function bootRelay(now?: () => number) {
  FakeWorker.all = [];
  const blobs = new Map<string, unknown[]>();
  const toMain: unknown[] = [];
  const listeners: Array<(e: { source: unknown; data: unknown }) => void> = [];
  const mainWindow = { postMessage: (m: unknown) => toMain.push(m) };
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
      revokeObjectURL: () => {},
    },
    ...(now ? { Date: { now } } : {}),
    Map,
    Set,
    Object,
    Array,
    Number,
    String,
  };
  vm.runInNewContext(RELAY_SOURCE, context);
  const fromMain = (data: unknown) => listeners.forEach((l) => l({ source: mainWindow, data }));
  const sent = () => toMain as Array<Record<string, unknown>>;
  return { fromMain, sent, blobs };
}

export const startMessage = (plugin = 'a', source = 'api.registerCommand({})') => ({ v: 0, kind: 'start', plugin, source });

/** 部品のコードを、relay.js が作る Worker の前置きと一緒に、偽の self の上で動かす。 */
export function inWorker(partSource: string, plugin = 'a') {
  const relay = bootRelay();
  relay.fromMain(startMessage(plugin, partSource));
  const worker = FakeWorker.all[0]!;
  const [prelude, source] = relay.blobs.get(worker.url) as [string, string];
  const posted: Array<Record<string, unknown>> = [];
  const self: Record<string, unknown> = { postMessage: (m: Record<string, unknown>) => posted.push(m), setTimeout, Promise };
  self.self = self;
  const context = vm.createContext(self);
  vm.runInContext(`${prelude}\n${source}\n`, context);
  const deliver = (data: unknown) => (self.onmessage as (e: { data: unknown }) => void)({ data });
  return { posted, deliver, self, relay, worker };
}

export const settle = () => new Promise((r) => setTimeout(r, 0));
