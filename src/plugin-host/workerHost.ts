import type { IsolatedCall, IsolatedCallResult, IsolatedPluginHost, IsolatedPluginListener, MenuTarget } from '../plugin-api';
import { LIMITS, parseRelayMessage, resultMessage, runMenuMessage, runMessage, startMessage, stopMessage, type MainMessage } from './protocol';

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
  | { readonly type: 'menu'; readonly plugin: string; readonly item: string }
  | { readonly type: 'ready'; readonly plugin: string }
  /** 部品が本体の機能を呼んだ（method は clipboardWriteText か currentPath）と、その結果を返した。 */
  | { readonly type: 'call'; readonly plugin: string; readonly method: IsolatedCall['method']; readonly call: number }
  | { readonly type: 'result'; readonly plugin: string; readonly method: IsolatedCall['method']; readonly call: number; readonly ok: boolean }
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

/**
 * 止められる時間切れ。確認の画面を出しているあいだ（suspendTimeouts）は計測を止め、再開すると残りの時間から数え直す
 * （確認の画面を何度も出させて、時間切れを先延ばしにできない）。
 */
interface Timeout {
  readonly fire: () => void;
  remaining: number;
  startedAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Slot {
  readonly id: string;
  readonly listener: IsolatedPluginListener;
  state: 'starting' | 'ready' | 'stopped';
  readonly commands: Set<string>;
  readonly menus: Set<string>;
  readonly pending: Map<number, { readonly command: string; readonly timeout: Timeout }>;
  /** 結果待ちの呼び出し（部品の中の番号 → 呼び出しの種類）。 */
  readonly calls: Map<number, IsolatedCall['method']>;
  activate: Timeout | null;
  /** suspendTimeouts を呼んで、まだ再開していない数。0 より大きい間、時間切れの計測は止まる。 */
  suspended: number;
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

  const runTimeout = (timeout: Timeout): void => {
    timeout.startedAt = Date.now();
    timeout.timer = setTimeout(() => {
      timeout.timer = null;
      timeout.startedAt = null;
      timeout.remaining = 0;
      timeout.fire();
    }, Math.max(0, timeout.remaining));
  };
  const pauseTimeout = (timeout: Timeout): void => {
    if (timeout.timer === null) return;
    clearTimeout(timeout.timer);
    timeout.timer = null;
    if (timeout.startedAt !== null) timeout.remaining -= Date.now() - timeout.startedAt;
    timeout.startedAt = null;
  };
  /** 時間切れを作る。確認の画面を出している間（suspended）に作ったものは、再開まで数え始めない。 */
  const armTimeout = (slot: Slot, ms: number, fire: () => void): Timeout => {
    const timeout: Timeout = { fire, remaining: ms, startedAt: null, timer: null };
    if (slot.suspended === 0) runTimeout(timeout);
    return timeout;
  };
  const cancelTimeout = (timeout: Timeout | null): void => {
    if (timeout === null) return;
    pauseTimeout(timeout);
    timeout.remaining = Number.POSITIVE_INFINITY;
  };
  const timeoutsOf = (slot: Slot): Timeout[] => [...(slot.activate ? [slot.activate] : []), ...Array.from(slot.pending.values(), (p) => p.timeout)];

  const clearTimers = (slot: Slot): void => {
    cancelTimeout(slot.activate);
    slot.activate = null;
    for (const { timeout } of slot.pending.values()) cancelTimeout(timeout);
    slot.pending.clear();
    slot.calls.clear();
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

  /** 呼び出しを本体の側（listener）に任せ、結果を Worker に返す。拒否や失敗は、結果の失敗として返す（部品は止めない）。 */
  const answerCall = async (slot: Slot, call: number, request: IsolatedCall): Promise<void> => {
    let result: IsolatedCallResult;
    try {
      result = slot.listener.onCall ? await slot.listener.onCall(request) : { ok: false, reason: 'この環境では使えません' };
    } catch {
      result = { ok: false, reason: '本体の側でエラーが起きました' };
    }
    // 待っている間に部品が止まったら、結果は返さない。
    if (slot.state === 'stopped' || !slot.calls.has(call)) return;
    slot.calls.delete(call);
    trace({ type: 'result', plugin: slot.id, method: request.method, call, ok: result.ok });
    post(resultMessage(slot.id, call, result));
  };

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
      case 'menu': {
        if (slot.state !== 'starting') return violation(slot, '部品のコードの最初の実行のあとに、メニューの項目を登録しようとしました');
        if (slot.menus.has(message.id)) return violation(slot, `menu の id「${message.id}」が重なっています`);
        if (slot.menus.size >= LIMITS.menuItemsPerPlugin) return violation(slot, 'メニューの項目が多すぎます');
        if (!slot.listener.onMenuItem) return violation(slot, 'ツリーの右クリックの項目は、この環境では使えません');
        slot.menus.add(message.id);
        trace({ type: 'menu', plugin: slot.id, item: message.id });
        try {
          slot.listener.onMenuItem({ id: message.id, title: message.title, where: message.where });
        } catch (error) {
          stopSlot(slot, error instanceof Error ? error.message : String(error), true);
        }
        return;
      }
      case 'call': {
        if (slot.calls.has(message.call)) return violation(slot, '結果待ちの番号と重なった call です');
        if (slot.calls.size >= LIMITS.pendingCalls) return violation(slot, '結果待ちの呼び出しが多すぎます');
        const call: IsolatedCall =
          message.method === 'clipboardWriteText' ? { method: 'clipboardWriteText', text: message.text } : { method: 'currentPath' };
        slot.calls.set(message.call, message.method);
        trace({ type: 'call', plugin: slot.id, method: message.method, call: message.call });
        void answerCall(slot, message.call, call);
        return;
      }
      case 'ready': {
        if (slot.state !== 'starting') return violation(slot, 'ready を 2 回送りました');
        slot.state = 'ready';
        trace({ type: 'ready', plugin: slot.id });
        cancelTimeout(slot.activate);
        slot.activate = null;
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
        cancelTimeout(run.timeout);
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
      const slot: Slot = { id, listener, state: 'starting', commands: new Set(), menus: new Set(), pending: new Map(), calls: new Map(), activate: null, suspended: 0 };
      slots.set(id, slot);
      slot.activate = armTimeout(slot, activateTimeoutMs, () => {
        slot.activate = null;
        stopSlot(slot, `部品のコードの最初の実行が ${activateTimeoutMs} ミリ秒で終わりませんでした`, true);
      });
      trace({ type: 'start', plugin: id });
      post(startMessage(id, source));
    },

    run(id, commandId) {
      const slot = slots.get(id);
      if (!slot || slot.state !== 'ready' || !slot.commands.has(commandId)) return;
      if (slot.pending.size >= MAX_PENDING_RUNS) return;
      const req = nextReq++;
      const timeout = armTimeout(slot, runTimeoutMs, () => {
        stopSlot(slot, `コマンド「${commandId}」が ${runTimeoutMs} ミリ秒で終わりませんでした`, true);
      });
      slot.pending.set(req, { command: commandId, timeout });
      trace({ type: 'run', plugin: id, command: commandId, req });
      post(runMessage(id, req, commandId));
    },

    runMenu(id, itemId, target: MenuTarget) {
      const slot = slots.get(id);
      if (!slot || slot.state !== 'ready' || !slot.menus.has(itemId)) return;
      if (slot.pending.size >= MAX_PENDING_RUNS) return;
      if (target.path === '' || target.path.length > LIMITS.pathLength) return;
      const req = nextReq++;
      const label = `menu:${itemId}`;
      const timeout = armTimeout(slot, runTimeoutMs, () => {
        stopSlot(slot, `メニューの項目「${itemId}」が ${runTimeoutMs} ミリ秒で終わりませんでした`, true);
      });
      slot.pending.set(req, { command: label, timeout });
      trace({ type: 'run', plugin: id, command: label, req });
      post(runMenuMessage(id, req, itemId, target.path, target.kind));
    },

    suspendTimeouts(id) {
      const slot = slots.get(id);
      if (!slot || slot.state === 'stopped') return () => {};
      slot.suspended++;
      if (slot.suspended === 1) for (const t of timeoutsOf(slot)) pauseTimeout(t);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        slot.suspended--;
        if (slot.suspended === 0 && slot.state !== 'stopped') for (const t of timeoutsOf(slot)) if (t.timer === null && Number.isFinite(t.remaining)) runTimeout(t);
      };
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
