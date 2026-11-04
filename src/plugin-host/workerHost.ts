import type { IsolatedPluginHost, IsolatedPluginListener } from '../plugin-api';
import { LIMITS, parseRelayMessage, runMessage, startMessage, stopMessage, type MainMessage } from './protocol';

/** 本体が持つ、仲介の iframe への入口。DOM の実装は domFrame.ts。単体テストでは偽物を渡す。 */
export interface FrameHandle {
  /** 仲介のコード（iframe の中）へメッセージを送る。 */
  post(message: MainMessage): void;
  /** このメッセージの送り元が、この iframe の窓か（event.source が contentWindow と同一か）。origin は不透明（'null'）なので使わない。 */
  owns(source: unknown): boolean;
  dispose(): void;
}

/** 観測用の記録（e2e のビルドが、本体の側で何が起きたかを確かめる。本番は渡さない）。 */
export type HostTrace =
  | { readonly type: 'start'; readonly plugin: string }
  | { readonly type: 'command'; readonly plugin: string; readonly command: string }
  | { readonly type: 'ready'; readonly plugin: string }
  | { readonly type: 'run'; readonly plugin: string; readonly command: string; readonly req: number }
  | { readonly type: 'done'; readonly plugin: string; readonly command: string; readonly req: number }
  | { readonly type: 'stopped'; readonly plugin: string; readonly reason: string };

export interface WorkerHostOptions {
  /** 観測用の記録。 */
  trace?: (event: HostTrace) => void;
  /** iframe を作る（最初の start のときだけ呼ぶ）。 */
  createFrame(): FrameHandle;
  /** message イベントの受け口を付ける（iframe を作るときだけ）。戻り値で外す。 */
  listen(handler: (event: { readonly source: unknown; readonly data: unknown }) => void): () => void;
  /** 部品のコードの最初の実行が、この時間（ミリ秒）で終わらなければ止める。iframe の読み込みを含む。 */
  activateTimeoutMs?: number;
  /** コマンドの実行が、この時間で終わらなければ止める。 */
  runTimeoutMs?: number;
  /** 無視したメッセージの記録先（部品を止めた記録は、レジストリが残す）。 */
  report?: (level: 'warn', message: string) => void;
}

export const DEFAULT_ACTIVATE_TIMEOUT_MS = 5000;
export const DEFAULT_RUN_TIMEOUT_MS = 5000;
/** 結果待ちの実行の数の上限。超えた実行の要求は捨てる（キーの連打で積み上げない）。 */
const MAX_PENDING_RUNS = 16;

interface Slot {
  readonly id: string;
  readonly listener: IsolatedPluginListener;
  state: 'starting' | 'ready' | 'stopped';
  readonly commands: Set<string>;
  readonly pending: Map<number, { readonly command: string; readonly timer: ReturnType<typeof setTimeout> }>;
  activateTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * 隔離した操作（段 2）の部品を動かす本体側の仕組み（ADR-005 の案 2a）。
 * 部品ごとに、sandbox の iframe（1 つを共有）の中の blob の Worker を動かす。iframe は最初の start のときに作る
 * （段 2 の部品がなければ、iframe も message の受け口も作らない）。
 *
 * 規則:
 * - 受け取るのは、event.source がその iframe の窓であるメッセージだけ。形は parseRelayMessage で検査する。
 * - 部品ごとに状態機械（starting → ready → stopped）。決めた順序に外れるメッセージ（ready の後の command、要求していない番号の done、
 *   同じ id の command の重なり、ready の 2 回）は不正として止める。
 * - 止める（stop）のは、Worker の例外、最初の実行・コマンドの実行の時間切れ、不正なメッセージ。止めたら仲介に terminate させ、
 *   以降のその部品のメッセージは何も通さない。ほかの部品と本体は動き続ける。
 */
export function createWorkerHost(options: WorkerHostOptions): IsolatedPluginHost & { readonly frameCreated: boolean } {
  const activateTimeoutMs = options.activateTimeoutMs ?? DEFAULT_ACTIVATE_TIMEOUT_MS;
  const runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const slots = new Map<string, Slot>();
  let frame: FrameHandle | null = null;
  let unlisten: (() => void) | null = null;
  let helloReceived = false;
  /** hello（仲介のコードの準備ができた合図）の前に送ろうとしたメッセージ。 */
  let queue: MainMessage[] = [];
  let nextReq = 1;
  let disposed = false;

  const post = (message: MainMessage): void => {
    if (!frame) return;
    if (!helloReceived) queue.push(message);
    else frame.post(message);
  };

  const trace = (event: HostTrace): void => {
    try {
      options.trace?.(event);
    } catch {
      // 観測の失敗で部品の扱いを変えない。
    }
  };

  const clearTimers = (slot: Slot): void => {
    if (slot.activateTimer !== null) clearTimeout(slot.activateTimer);
    slot.activateTimer = null;
    for (const { timer } of slot.pending.values()) clearTimeout(timer);
    slot.pending.clear();
  };

  /** 部品を止める。何度呼んでもよい。notify が true のときだけ、listener に知らせる。 */
  const stopSlot = (slot: Slot, reason: string, notify: boolean): void => {
    if (slot.state === 'stopped') return;
    slot.state = 'stopped';
    clearTimers(slot);
    // 仲介に terminate させる。hello の前なら、start がまだ届いていないので、start ごと取り消す。
    if (!helloReceived) queue = queue.filter((m) => !(m.kind === 'start' && m.plugin === slot.id));
    else post(stopMessage(slot.id));
    if (notify) {
      trace({ type: 'stopped', plugin: slot.id, reason });
      slot.listener.onStopped(reason);
    }
  };

  const violation = (slot: Slot, problem: string): void => stopSlot(slot, `不正なメッセージ: ${problem}`, true);

  const handle = (event: { readonly source: unknown; readonly data: unknown }): void => {
    if (!frame || !frame.owns(event.source)) return;
    const parsed = parseRelayMessage(event.data);
    if (!parsed.ok) {
      // どの部品のメッセージか分からない。仲介のコードが決めた形以外を出すことはないので、記録だけ残す。
      options.report?.('warn', `[plugin-host] 形の違うメッセージを無視しました: ${parsed.problem}`);
      return;
    }
    const message = parsed.message;
    if (message.kind === 'hello') {
      if (helloReceived) return;
      helloReceived = true;
      const queued = queue;
      queue = [];
      for (const m of queued) frame.post(m);
      return;
    }
    const slot = slots.get(message.plugin);
    if (!slot) {
      options.report?.('warn', `[plugin-host] 知らない部品のメッセージを無視しました: ${message.plugin}`);
      return;
    }
    // 止めたあとは何も通さない。
    if (slot.state === 'stopped') return;
    switch (message.kind) {
      case 'command': {
        if (slot.state !== 'starting') return violation(slot, '部品のコードの最初の実行のあとに、コマンドを登録しようとしました');
        if (slot.commands.has(message.id)) return violation(slot, `command の id「${message.id}」が重なっています`);
        if (slot.commands.size >= LIMITS.commandsPerPlugin) return violation(slot, 'コマンドが多すぎます');
        slot.commands.add(message.id);
        trace({ type: 'command', plugin: slot.id, command: message.id });
        try {
          slot.listener.onCommand({
            id: message.id,
            title: message.title,
            ...(message.shortcut !== undefined ? { shortcut: message.shortcut } : {}),
            ...(message.ignoreInTextEntry !== undefined ? { ignoreInTextEntry: message.ignoreInTextEntry } : {}),
          });
        } catch (error) {
          stopSlot(slot, error instanceof Error ? error.message : String(error), true);
        }
        return;
      }
      case 'ready': {
        if (slot.state !== 'starting') return violation(slot, 'ready を 2 回送りました');
        slot.state = 'ready';
        trace({ type: 'ready', plugin: slot.id });
        if (slot.activateTimer !== null) clearTimeout(slot.activateTimer);
        slot.activateTimer = null;
        try {
          slot.listener.onReady();
        } catch (error) {
          stopSlot(slot, error instanceof Error ? error.message : String(error), true);
        }
        return;
      }
      case 'done': {
        const run = slot.pending.get(message.req);
        if (!run) return violation(slot, '要求していない番号の done です');
        clearTimeout(run.timer);
        slot.pending.delete(message.req);
        trace({ type: 'done', plugin: slot.id, command: run.command, req: message.req });
        return;
      }
      case 'failed': {
        const run = slot.pending.get(message.req);
        if (!run) return violation(slot, '要求していない番号の failed です');
        return stopSlot(slot, `コマンド「${run.command}」が例外を出しました: ${message.reason}`, true);
      }
      case 'stopped':
        return stopSlot(slot, message.reason, true);
    }
  };

  const ensureFrame = (): void => {
    if (frame || disposed) return;
    unlisten = options.listen(handle);
    frame = options.createFrame();
  };

  return {
    get frameCreated() {
      return frame !== null;
    },

    start(id, source, listener) {
      if (disposed) throw new Error('部品のホストは解除済みです');
      if (slots.has(id)) throw new Error(`部品「${id}」は起動済みです`);
      if (source.length > LIMITS.sourceLength) throw new Error('部品のコードが大きすぎます');
      ensureFrame();
      const slot: Slot = { id, listener, state: 'starting', commands: new Set(), pending: new Map(), activateTimer: null };
      slots.set(id, slot);
      slot.activateTimer = setTimeout(() => {
        slot.activateTimer = null;
        stopSlot(slot, `部品のコードの最初の実行が ${activateTimeoutMs} ミリ秒で終わりませんでした`, true);
      }, activateTimeoutMs);
      trace({ type: 'start', plugin: id });
      post(startMessage(id, source));
    },

    run(id, commandId) {
      const slot = slots.get(id);
      if (!slot || slot.state !== 'ready' || !slot.commands.has(commandId)) return;
      if (slot.pending.size >= MAX_PENDING_RUNS) return;
      const req = nextReq++;
      const timer = setTimeout(() => {
        stopSlot(slot, `コマンド「${commandId}」が ${runTimeoutMs} ミリ秒で終わりませんでした`, true);
      }, runTimeoutMs);
      slot.pending.set(req, { command: commandId, timer });
      trace({ type: 'run', plugin: id, command: commandId, req });
      post(runMessage(id, req, commandId));
    },

    stop(id) {
      const slot = slots.get(id);
      if (slot) stopSlot(slot, '', false);
    },

    dispose() {
      if (disposed) return;
      for (const slot of slots.values()) stopSlot(slot, '', false);
      disposed = true;
      unlisten?.();
      unlisten = null;
      frame?.dispose();
      frame = null;
    },
  };
}
