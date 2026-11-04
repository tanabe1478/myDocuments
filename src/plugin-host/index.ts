/**
 * 隔離した操作（段 2）の仕組み（ADR-005 の R5、案 2a）。
 * - host.html と relay.js: sandbox の iframe の中身。Tauri 版は独自プロトコル plug: が、ブラウザ版（e2e と dev）は同じオリジンから配信する。
 * - workerHost.ts: 本体側。iframe を作り、部品ごとの Worker とやりとりし、例外・時間切れ・不正なメッセージで部品を止める。
 * - protocol.ts: メッセージの形。
 * ネイティブへの入口（IPC）には触れない。
 */
import type { IsolatedPluginHost } from '../plugin-api';
import { createDomFrame, listenWindowMessages } from './domFrame';
import { createWorkerHost, type WorkerHostOptions } from './workerHost';

export { createWorkerHost, DEFAULT_ACTIVATE_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS } from './workerHost';
export type { FrameHandle, HostTrace, WorkerHostOptions } from './workerHost';
export { LIMITS, PROTOCOL_VERSION, parseRelayMessage } from './protocol';
export { pluginHostUrl } from './hostUrl';

/** 実際の iframe と窓の message で動く、本体の仕組み。段 2 の部品があるときだけ作る。 */
export function createIsolatedPluginHost(options: { hostUrl: string; activateTimeoutMs?: number; runTimeoutMs?: number; trace?: WorkerHostOptions['trace'] }): IsolatedPluginHost {
  return createWorkerHost({
    createFrame: () => createDomFrame(options.hostUrl),
    listen: listenWindowMessages,
    ...(options.activateTimeoutMs !== undefined ? { activateTimeoutMs: options.activateTimeoutMs } : {}),
    ...(options.runTimeoutMs !== undefined ? { runTimeoutMs: options.runTimeoutMs } : {}),
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
    report: (level, message) => console[level](message),
  });
}
