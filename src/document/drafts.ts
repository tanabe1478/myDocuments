import type { Draft, DocumentBridge } from '../platform';
import type { PluginPerf } from '../plugin-api';
import { isDirty, type DocumentState } from './state';

/** 入力が止まってから草稿を書くまでの待ち（仕様 §13「自動保存の間隔」。docs/decision-001 に決定を記録）。 */
export const DRAFT_DELAY_MS = 2000;

/** 文書の現在の状態から、草稿を作る。 */
export function buildDraft(state: DocumentState, updatedAt: number): Draft {
  return {
    draftId: state.draftId,
    path: state.path,
    text: state.text,
    format: state.format,
    baseRevision: state.diskRevision,
    updatedAt,
  };
}

export interface DraftKeeperDeps {
  bridge: Pick<DocumentBridge, 'writeDraft' | 'deleteDraft'>;
  /** 書く・消すの失敗を伝える（連続する失敗は 1 回にまとめる）。 */
  onError(e: unknown): void;
  /** 性能の計測（R16）。草稿の書き込み（writeDraft の往復）を区間 document.draft-write として数える。省略か無効の間は、何もしない。 */
  perf?: PluginPerf;
  delayMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * 草稿の自動保存。文書の状態が変わるたびに observe を呼ぶ。
 * - 未保存の変更がある間、入力が delayMs 止まったら草稿を書く（入力のたびに待ち直す）。
 * - 未保存の変更がなくなったら（保存・読み直し・破棄）、その文書の草稿を消す。
 * - 別の文書に切り替わったら、前の文書の保留中の書き込みを取りやめ、草稿があれば消す。
 * 書く・消すは順番に実行する（消した後に古い書き込みが追い越して、草稿が復活しないように）。
 */
export class DraftKeeper {
  private currentId: string | null = null;
  private latest: DocumentState | null = null;
  private timer: unknown = null;
  /** ディスクに草稿があるかもしれない draftId（書いた、または復旧で引き継いだ）。 */
  private readonly known = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private failing = false;

  constructor(private readonly deps: DraftKeeperDeps) {}

  /** 復旧した草稿を引き継ぐ。未保存の変更がなくなったときに、その草稿を消せるようにする。 */
  adopt(draftId: string): void {
    this.known.add(draftId);
  }

  observe(state: DocumentState): void {
    if (this.currentId !== state.draftId) {
      this.cancelTimer();
      if (this.currentId !== null) this.removeIfKnown(this.currentId);
      this.currentId = state.draftId;
    }
    this.latest = state;

    if (isDirty(state)) {
      this.cancelTimer();
      const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
      this.timer = set(() => this.flush(), this.deps.delayMs ?? DRAFT_DELAY_MS);
    } else {
      this.cancelTimer();
      this.removeIfKnown(state.draftId);
    }
  }

  /** 保留中の書き込みを、待たずに実行する。 */
  flush(): void {
    this.cancelTimer();
    const state = this.latest;
    if (!state || !isDirty(state)) return;
    const draft = buildDraft(state, (this.deps.now ?? Date.now)());
    this.known.add(draft.draftId);
    this.enqueue(async () => {
      const end = this.deps.perf?.span('document.draft-write');
      try {
        await this.deps.bridge.writeDraft(draft);
      } finally {
        end?.();
      }
      this.failing = false;
    });
  }

  /** この文書の草稿を、いますぐ消す（保留中の書き込みも取りやめる）。消し終わるまで待てる。 */
  discard(draftId: string): Promise<void> {
    if (this.currentId === draftId) this.cancelTimer();
    this.removeIfKnown(draftId);
    return this.queue;
  }

  /** 完了待ち（テスト用）。 */
  idle(): Promise<void> {
    return this.queue;
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private removeIfKnown(draftId: string): void {
    if (!this.known.delete(draftId)) return;
    this.enqueue(() => this.deps.bridge.deleteDraft(draftId));
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((e) => {
      if (this.failing) return;
      this.failing = true;
      this.deps.onError(e);
    });
  }
}
