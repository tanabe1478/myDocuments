import type { Notice } from '../document/controller';
import type { DocumentBridge } from '../platform';
import {
  normalizePermissionsFile,
  type Permission,
  type PermissionDecision,
  type PermissionDecisions,
  type PermissionGate,
  type PermissionOutcome,
} from '../plugin-api';

/** 確認の画面に出す内容。permissions は、この部品が宣言した権限のうち、まだ決めていないもの（まとめて聞く）。 */
export interface PermissionPrompt {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly permissions: readonly Permission[];
}

export interface PermissionsState {
  /** 保存済みの決定を読み込んだか（読む前は、決定がないものとして扱わない: authorize は読んでから判断する）。 */
  readonly loaded: boolean;
  /** 部品の id → 決めた権限の結果。決めていないものは、キーがない。 */
  readonly decisions: Readonly<Record<string, PermissionDecisions>>;
  /** いま出している確認の画面。なければ null。同時に出すのは 1 つで、ほかは順番を待つ。 */
  readonly prompt: PermissionPrompt | null;
}

export interface PermissionControllerDeps {
  readonly bridge: Pick<DocumentBridge, 'loadPluginPermissions' | 'savePluginPermissions'>;
  /** 保存に失敗したことなどを利用者に知らせる（トースト）。 */
  readonly notify: (notice: Notice) => void;
}

interface Waiting {
  readonly prompt: PermissionPrompt;
  readonly resolve: (outcome: PermissionOutcome) => void;
}

/**
 * 段 2 の部品の権限の、利用者の決定と、確認の画面（ADR-005 の R6）。
 * - 決定の保存は、ネイティブ側の plugin-permissions.json（設定とは別のファイル）。起動では読まない。最初に必要になったとき
 *   （権限の確認、設定画面）に読む（起動の経路を長くしない）。
 * - 決めていない権限を部品が使うとき、確認の画面を出す。宣言した権限のうち、決めていないものをまとめて聞く。
 *   「許可する」「許可しない」は、聞いた権限すべてに同じ結果を保存する。閉じる（Esc、閉じるボタン）は、保存せず、今回だけ断る。
 * - 同じ部品の確認が出ている間に来た呼び出しは、その確認の結果を待つ（画面を重ねない）。別の部品の確認は順番を待つ。
 * - 保存に失敗しても、今回の起動の間は、決めた結果を使う（トーストで知らせる）。
 */
export class PermissionController implements PermissionGate {
  private state: PermissionsState = { loaded: false, decisions: {}, prompt: null };
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private readonly queue: Waiting[] = [];
  private current: Waiting | null = null;
  /** 部品の id → その部品の、確認の結果を待っている Promise（重ねて聞かないため）。 */
  private readonly inflight = new Map<string, Promise<PermissionOutcome>>();
  /** 保存は、順番に行う（古い値で上書きしない）。 */
  private saving: Promise<void> = Promise.resolve();

  private notifier: (notice: Notice) => void;

  constructor(private readonly deps: PermissionControllerDeps) {
    this.notifier = deps.notify;
  }

  /** トーストの出し方を結ぶ（App が、トーストの持ち主として結ぶ。結ぶまでは deps.notify）。戻り値で、元に戻す。 */
  bindNotify = (notify: (notice: Notice) => void): (() => void) => {
    this.notifier = notify;
    return () => {
      if (this.notifier === notify) this.notifier = this.deps.notify;
    };
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getState = (): PermissionsState => this.state;

  private set(patch: Partial<PermissionsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of Array.from(this.listeners)) listener();
  }

  /** 保存済みの決定を読む（1 回だけ。読めなければ、決定がないものとして続ける）。 */
  load = (): Promise<void> => {
    this.loading ??= (async () => {
      let decisions: PermissionsState['decisions'] = {};
      try {
        decisions = normalizePermissionsFile(await this.deps.bridge.loadPluginPermissions()).plugins;
      } catch {
        // 読めないときは、決定がないものとして続ける（起動と編集を止めない）。
      }
      // 読んでいる間に決まったもの（あれば）を残す。
      this.set({ loaded: true, decisions: { ...decisions, ...this.state.decisions } });
    })();
    return this.loading;
  };

  authorize: PermissionGate['authorize'] = async (plugin, declared, needed) => {
    for (;;) {
      await this.load();
      const decided = this.state.decisions[plugin.id]?.[needed];
      if (decided) return decided;
      const waiting = this.inflight.get(plugin.id);
      if (waiting) {
        // 同じ部品の確認が出ている。結果を待って、決まっていれば、それに従う。
        if ((await waiting) === 'dismissed') return 'dismissed';
        continue;
      }
      const undecided = declared.filter((p) => !this.state.decisions[plugin.id]?.[p]);
      const asked = this.ask({ pluginId: plugin.id, pluginName: plugin.name, permissions: undecided.length > 0 ? undecided : [needed] });
      this.inflight.set(plugin.id, asked);
      try {
        if ((await asked) === 'dismissed') return 'dismissed';
      } finally {
        this.inflight.delete(plugin.id);
      }
    }
  };

  /** 確認の画面を、順番に出す。 */
  private ask(prompt: PermissionPrompt): Promise<PermissionOutcome> {
    return new Promise((resolve) => {
      this.queue.push({ prompt, resolve });
      this.showNext();
    });
  }

  private showNext(): void {
    if (this.current !== null) return;
    const next = this.queue.shift();
    if (!next) return;
    this.current = next;
    this.set({ prompt: next.prompt });
  }

  /** 確認の画面の答え。granted / denied は聞いた権限すべてに保存し、dismissed は保存しない。 */
  answer = (choice: PermissionOutcome): void => {
    const waiting = this.current;
    if (!waiting) return;
    this.current = null;
    if (choice === 'dismissed') {
      this.set({ prompt: null });
    } else {
      const { pluginId, permissions } = waiting.prompt;
      const decided: PermissionDecisions = { ...this.state.decisions[pluginId] };
      for (const permission of permissions) decided[permission] = choice satisfies PermissionDecision;
      this.set({ prompt: null, decisions: { ...this.state.decisions, [pluginId]: decided } });
      this.persist();
    }
    waiting.resolve(choice);
    this.showNext();
  };

  /** 部品の決定を、すべて取り消す（未決に戻す。次の使用で、もう一度聞く）。 */
  revoke = (pluginId: string): void => {
    if (!(pluginId in this.state.decisions)) return;
    const { [pluginId]: _removed, ...rest } = this.state.decisions;
    this.set({ decisions: rest });
    this.persist();
  };

  private persist(): void {
    const snapshot = { version: 1 as const, plugins: this.state.decisions };
    this.saving = this.saving
      .then(() => this.deps.bridge.savePluginPermissions(snapshot))
      .catch(() => this.notifier({ kind: 'error', message: '部品の権限の決定を保存できませんでした（今回の起動の間は、決めたとおりに扱います）' }));
  }
}
