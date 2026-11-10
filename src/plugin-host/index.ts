/**
 * 隔離した操作（段 2）の仕組み（ADR-005 の R5、案 2a）。
 * - host.html と relay.js: sandbox の iframe の中身。host.html は srcdoc（?raw で取り込む）、relay.js は本体と同じオリジンの /plugin-host/relay.js（R8）。
 * - workerHost.ts: 本体側。iframe を作り、部品ごとの Worker とやりとりし、例外・時間切れ・不正なメッセージで部品を止める。
 * - protocol.ts: メッセージの形。
 * ネイティブへの入口（IPC）には触れない。
 */
import type { IsolatedPluginHost } from '../plugin-api';
import { createDomFrame, listenWindowMessages } from './domFrame';
import hostHtml from './host.html?raw';
import { createWorkerHost, type WorkerHostOptions } from './workerHost';

export { createWorkerHost, DEFAULT_ACTIVATE_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS } from './workerHost';
export type { FrameHandle, HostTrace, WorkerHostOptions } from './workerHost';
export { LIMITS, PROTOCOL_VERSION, parseRelayMessage } from './protocol';

/** 実際の iframe と窓の message で動く、本体の仕組み。段 2 の部品があるときだけ作る。 */
export function createIsolatedPluginHost(options: { activateTimeoutMs?: number; runTimeoutMs?: number; trace?: WorkerHostOptions['trace']; perf?: WorkerHostOptions['perf'] }): IsolatedPluginHost {
  return createWorkerHost({
    createFrame: () => createDomFrame(hostHtml),
    listen: listenWindowMessages,
    ...(options.activateTimeoutMs !== undefined ? { activateTimeoutMs: options.activateTimeoutMs } : {}),
    ...(options.runTimeoutMs !== undefined ? { runTimeoutMs: options.runTimeoutMs } : {}),
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
    ...(options.perf !== undefined ? { perf: options.perf } : {}),
    report: (level, message) => console[level](message),
  });
}
