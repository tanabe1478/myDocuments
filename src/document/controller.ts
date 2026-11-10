import { errorKind } from '../logging/sanitize';
import { BridgeError, type DocumentBridge, type Draft, type DraftSummary, type SaveResult as BridgeSaveResult } from '../platform';
import { DraftKeeper, buildDraft, type DraftKeeperDeps } from './drafts';
import {
  NO_EXTERNAL_CHANGE,
  diskTextForDiff,
  isDeleted,
  keepMine,
  observeDisk,
  savePolicy,
  type ChangedOnDisk,
  type DiskObservation,
  type ExternalState,
} from './external';
import { isSameOrInside, relocatePath } from '../explorer/names';
import { planStartup, restoreFromDraft, type OriginalOnDisk } from './recovery';
import {
  documentTitle,
  isDirty,
  mixedEolNotice,
  needsDiscardConfirmation,
  newDocumentState,
  openedDocumentState,
  planSave,
  reloadedDocumentState,
  savedDocumentState,
  suggestedFileName,
  withText,
  type DocumentState,
  type SavePlan,
} from './state';

/** 編集エンジンとの接点。EditorAdapter のうち、controller が使う部分だけ。 */
export interface DocumentIo {
  getText(): string;
  setText(text: string): void;
}

export type DiscardChoice = 'save' | 'discard' | 'cancel';
export type RecoveryChoice = 'restore' | 'discard' | 'later';

export interface Notice {
  readonly kind: 'info' | 'error';
  readonly message: string;
}

export interface ControllerDeps {
  bridge: DocumentBridge;
  io: DocumentIo;
  /** 未保存の変更があるまま新規・開く・終了を実行するときの確認。 */
  confirmDiscard(documentName: string): Promise<DiscardChoice>;
  /** 削除されたファイルを、保存で作り直してよいかの確認。 */
  confirmRecreate(documentName: string): Promise<boolean>;
  /** 起動時に、復旧できる草稿があるときの確認。others はそれ以外の草稿の件数。 */
  askRecovery(draft: DraftSummary, others: number): Promise<RecoveryChoice>;
  notify(notice: Notice): void;
  /**
   * アプリのログ（ADR-007）への記録口。source は document。開く、保存、別名保存、草稿の書き込みの失敗のとき、操作の名前とエラーの種類だけを渡す
   * （本文とパスは渡さない）。ない環境では、記録しない。
   */
  log?(level: 'error', event: string, data: Record<string, string>): void;
  /** 草稿の識別子の生成（既定は crypto.randomUUID）。 */
  newDraftId?: () => string;
  /** 草稿の自動保存のタイマー（テストで差し替える）。 */
  draftTimers?: Pick<DraftKeeperDeps, 'delayMs' | 'now' | 'setTimer' | 'clearTimer'>;
}

export type SaveResult = 'written' | 'unchanged' | 'noop' | 'cancelled' | 'conflict' | 'failed';

export function describeError(e: unknown): string {
  if (e instanceof BridgeError) {
    switch (e.kind) {
      case 'not-utf8':
        return 'UTF-8 ではないファイルは開けません（文字化けを避けるため、読み込みません）。';
      case 'permission-denied':
        return '権限がないため、読み書きできませんでした。';
      case 'not-found':
        return 'ファイルが見つかりません。';
      case 'not-allowed':
        return 'このファイルには保存できません。「別名で保存」を使ってください。';
      case 'invalid-input':
        return '指定されたパスは使えません。';
      case 'already-exists':
        return '同じ名前の項目がすでにあります。';
      case 'io':
        return `ファイルの読み書きに失敗しました（${e.message}）。`;
    }
  }
  return `予期しないエラーが発生しました（${e instanceof Error ? e.message : String(e)}）。`;
}

const DELETED_NOTICE = 'ファイルが削除されました。本文はそのまま残しています。保存すると作り直します。';
const CONFLICT_NOTICE = 'ファイルが外部で変更されました。画面上部の競合バーで、どうするか選んでください。';

/**
 * 新規・開く・保存・別名保存・外部変更・草稿・終了の副作用層。判断（何をするか）は
 * state.ts / external.ts / recovery.ts の純関数に任せ、ここは bridge・編集エンジン・通知を順に呼ぶだけにする。
 * 操作の実行中は、ほかの操作（ショートカットの連打など）を受け付けない。
 * 外部変更の確認と、窓を閉じる要求は、実行中なら捨てずに、終わった後に処理する。
 */
export class DocumentController {
  private state: DocumentState;
  private external: ExternalState = NO_EXTERNAL_CHANGE;
  private listeners = new Set<() => void>();
  private busy = false;
  private recheck = false;
  /** 操作の実行中に、窓を閉じる要求が届いた。終わった後に処理する。 */
  private closeRequested = false;
  /** 窓を閉じる処理の最中（確認ダイアログの表示中を含む）。この間に届いた二重の要求は捨てる。 */
  private closing = false;
  private started = false;
  private watchFailed = false;
  /** 読めなかった外部の版の revision（同じ版で通知を繰り返さない）。 */
  private unreadableRevision: string | null = null;
  private readonly keeper: DraftKeeper;
  private readonly newId: () => string;

  constructor(private readonly deps: ControllerDeps) {
    this.newId = deps.newDraftId ?? (() => crypto.randomUUID());
    this.state = newDocumentState(this.newId());
    this.keeper = new DraftKeeper({
      bridge: deps.bridge,
      onError: (e) => {
        this.logFailure('draft-write', e);
        deps.notify({ kind: 'error', message: `草稿を保存できませんでした。${describeError(e)}` });
      },
      ...deps.draftTimers,
    });
  }

  /** 失敗をアプリのログに残す（操作の名前とエラーの種類だけ。本文もパスも、メッセージも書かない）。記録の失敗は、操作に影響させない。 */
  private logFailure(op: 'open' | 'save' | 'save-as' | 'draft-write', e: unknown): void {
    try {
      this.deps.log?.('error', `${op}-failed`, { op, ...errorKind(e) });
    } catch {
      // 記録の失敗で、文書の操作を止めない。
    }
  }

  getState = (): DocumentState => this.state;

  getExternal = (): ExternalState => this.external;

  /** 差分表示に使う、ディスクの内容（衝突していなければ null）。 */
  getDiskTextForDiff = (): string | null => diskTextForDiff(this.external);

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  private setState(next: DocumentState): void {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.emit();
    this.keeper.observe(next);
    if (prev.path !== next.path) this.followPath(next.path);
  }

  private setExternal(next: ExternalState): void {
    if (next === this.external) return;
    this.external = next;
    this.emit();
  }

  /** 開いている文書のパスが変わったら、監視を付け替え、前回の文書として覚える。 */
  private followPath(path: string | null): void {
    this.watch(path);
    // 無題の文書に切り替えたら、前回の文書の記録を消す（消さないと、次回の起動で前の文書が開き直される）。
    void this.deps.bridge.saveSession({ lastPath: path }).catch(() => {});
  }

  private watch(path: string | null): void {
    this.deps.bridge.watchDocument(path).then(
      () => {
        this.watchFailed = false;
      },
      (e) => {
        if (this.watchFailed) return;
        this.watchFailed = true;
        this.deps.notify({
          kind: 'info',
          message: `ファイルの変更を監視できませんでした（${describeError(e)}）。ウィンドウに戻ったときに確認します。`,
        });
      },
    );
  }

  /** 編集エンジンからの本文の変化。 */
  handleEdit = (text: string): void => {
    this.setState(withText(this.state, text));
  };

  // ---- 文書の切り替え ----

  newDocument = (): Promise<void> =>
    this.exclusive(async () => {
      if (!(await this.discardOrSave())) return;
      this.deps.io.setText('');
      this.setExternal(NO_EXTERNAL_CHANGE);
      this.setState(newDocumentState(this.newId()));
    });

  openDocument = (): Promise<void> =>
    this.exclusive(async () => {
      if (!(await this.discardOrSave())) return;
      const path = await this.deps.bridge.pickOpenPath();
      if (path === null) return;
      await this.loadFromPath(path);
    });

  /**
   * パスを指定して開く（エクスプローラーから）。ダイアログは出さず、未保存の変更の確認、草稿、外部変更の監視、
   * 前回の文書の記録は「開く」と同じ。開いた（すでに開いている）なら true。
   * いま開いている文書と同じパスなら、何もしない（未保存の編集を捨てない）。ほかの操作の実行中は何もせず false。
   */
  openPath = (path: string): Promise<boolean> =>
    this.exclusive(async () => {
      if (path === this.state.path) return true;
      if (!(await this.discardOrSave())) return false;
      return this.loadFromPath(path);
    }, false);

  private async loadFromPath(path: string, options: { quietNotFound?: boolean } = {}): Promise<boolean> {
    try {
      const opened = await this.deps.bridge.openDocument(path);
      this.deps.io.setText(opened.text);
      this.setExternal(NO_EXTERNAL_CHANGE);
      this.setState(openedDocumentState(opened, this.newId()));
      return true;
    } catch (e) {
      this.logFailure('open', e);
      if (!(options.quietNotFound && e instanceof BridgeError && e.kind === 'not-found')) {
        this.deps.notify({ kind: 'error', message: describeError(e) });
      }
      return false;
    }
  }

  // ---- エクスプローラーでの名前の変更 ----

  /**
   * エクスプローラーでの名前の変更（ファイルまたはフォルダ）。perform が実際に名前を変え、新しいパスを返す。
   * 開いている文書が、その項目そのもの、またはそれを含むフォルダなら、文書を新しいパスへ移す。
   * 名前を変える前に文書の監視を外し、変えた後に新しいパスで監視し直す（古いパスの「消えた」通知で、削除扱いにしないため）。
   * 本文、未保存の変更、undo 履歴、カーソル、外部変更の状態はそのまま。名前の変更が失敗したら、古いパスのまま監視を戻し、例外を投げる。
   * ほかの操作の実行中は、何もせず null（呼び出し側が、あとでやり直すよう伝える）。
   */
  renameEntry = (oldPath: string, perform: () => Promise<string>): Promise<string | null> =>
    this.exclusive<string | null>(async () => {
      const docPath = this.state.path;
      if (docPath === null || !isSameOrInside(docPath, oldPath)) return perform();
      await this.deps.bridge.watchDocument(null).catch(() => {});
      let newPath: string;
      try {
        newPath = await perform();
      } catch (e) {
        this.watch(docPath);
        throw e;
      }
      const moved = relocatePath(docPath, oldPath, newPath);
      if (moved === null) this.watch(docPath);
      else this.relocate(docPath, moved);
      return newPath;
    }, null);

  /**
   * 開いている文書を、新しいパスへ移す（名前の変更に追従する）。パス、監視、前回の文書の記録、草稿のパスが新しいパスになる。
   * 未保存の変更があれば、草稿をすぐ新しいパスで書き直す（古いパスのまま強制終了しても、正しい保存先で復旧できるように）。
   * 移した後、新しいパスのディスクの状態を一度確かめる。
   */
  relocate = (from: string, to: string): void => {
    if (this.state.path !== from || from === to) return;
    this.setState({ ...this.state, path: to });
    if (isDirty(this.state)) this.keeper.flush();
    this.recheck = true;
  };

  /** 開いている文書が、path そのもの、または path のフォルダの中にあるか。 */
  isDocumentInside = (path: string): boolean => {
    const doc = this.state.path;
    return doc !== null && isSameOrInside(doc, path);
  };

  // ---- 起動時の復旧 ----

  /**
   * 起動時に一度だけ呼ぶ。復旧できる草稿があれば確認を出し、なければ前回の文書を開き直す。
   * 起動の確認を待つ間に本文が編集された場合は、何もしない（編集中の本文を置き換えない）。
   */
  start = async (): Promise<void> => {
    if (this.started) return;
    this.started = true;
    const drafts = await this.deps.bridge.listDrafts().catch(() => []);
    const session = await this.deps.bridge.loadSession().catch(() => null);
    if (!this.isPristine()) return;

    const plan = planStartup(drafts, session);
    switch (plan.kind) {
      case 'nothing':
        return;
      case 'reopen':
        await this.exclusive(async () => {
          if (this.isPristine()) await this.loadFromPath(plan.path, { quietNotFound: true });
        });
        return;
      case 'ask-draft': {
        const choice = await this.deps.askRecovery(plan.draft, plan.others);
        if (choice === 'restore') {
          await this.exclusive(() => this.restoreDraft(plan.draft.draftId));
        } else if (choice === 'discard') {
          await this.deps.bridge.deleteDraft(plan.draft.draftId).catch((e) =>
            this.deps.notify({ kind: 'error', message: describeError(e) }),
          );
        }
      }
    }
  };

  private isPristine(): boolean {
    return this.state.path === null && !isDirty(this.state) && this.deps.io.getText() === '';
  }

  private async restoreDraft(draftId: string): Promise<void> {
    let draft: Draft | null;
    try {
      draft = await this.deps.bridge.readDraft(draftId);
    } catch (e) {
      this.deps.notify({ kind: 'error', message: describeError(e) });
      return;
    }
    if (!draft) {
      this.deps.notify({ kind: 'error', message: '草稿を読み込めませんでした。' });
      return;
    }

    let original: OriginalOnDisk | null = null;
    if (draft.path !== null) {
      try {
        const opened = await this.deps.bridge.openDocument(draft.path);
        original = { text: opened.text, format: opened.format, revision: opened.revision };
      } catch {
        original = null;
      }
    }
    const restored = restoreFromDraft(draft, original);
    this.keeper.adopt(draft.draftId);
    this.deps.io.setText(restored.state.text);
    this.setExternal(restored.external);
    this.setState(restored.state);

    if (draft.path !== null && original === null) {
      this.deps.notify({
        kind: 'info',
        message: '草稿を復元しました。元のファイルを読み込めないため、保存先のない文書として開いています。',
      });
    } else if (restored.external.kind === 'conflict') {
      this.deps.notify({
        kind: 'info',
        message: '草稿を復元しました。草稿の後で元のファイルが変更されています。競合バーで、どうするか選んでください。',
      });
    } else if (!restored.redundant) {
      this.deps.notify({ kind: 'info', message: '未保存の草稿を復元しました。' });
    }
  }

  // ---- 保存 ----

  save = (): Promise<SaveResult> => this.exclusive(() => this.saveInner(), 'noop');

  saveAs = (): Promise<SaveResult> => this.exclusive(() => this.saveAsInner(), 'noop');

  private async exclusive<T>(task: () => Promise<T>, whenBusy?: T): Promise<T> {
    if (this.busy) return whenBusy as T;
    this.busy = true;
    try {
      return await task();
    } finally {
      this.busy = false;
      if (this.closeRequested) {
        // 閉じる要求を先に処理する。外部変更の確認（recheck）は、その後の exclusive の終わりで行う。
        this.closeRequested = false;
        void this.requestClose();
      } else if (this.recheck) {
        this.recheck = false;
        void this.checkExternal();
      }
    }
  }

  /** 保存の直前に、編集エンジンの本文を取り込む。 */
  private syncText(): string {
    const text = this.deps.io.getText();
    this.setState(withText(this.state, text));
    return text;
  }

  /** 未保存の変更があれば確認する。続行してよければ true。 */
  private async discardOrSave(): Promise<boolean> {
    this.syncText();
    if (!needsDiscardConfirmation(this.state)) return true;
    const choice = await this.deps.confirmDiscard(documentTitle(this.state));
    if (choice === 'cancel') return false;
    if (choice === 'discard') return true;
    const result = await this.saveInner();
    return result === 'written' || result === 'unchanged';
  }

  private async saveInner(): Promise<SaveResult> {
    const text = this.syncText();
    const plan = planSave(this.state, savePolicy(this.external));
    switch (plan.kind) {
      case 'choose-path':
        return this.saveAsInner();
      case 'noop':
        return 'noop';
      case 'write':
        if (plan.recreate && !(await this.deps.confirmRecreate(documentTitle(this.state)))) return 'cancelled';
        return this.writeExisting(plan, text);
    }
  }

  private async saveAsInner(): Promise<SaveResult> {
    const text = this.syncText();
    let path: string | null;
    try {
      path = await this.deps.bridge.pickSavePath(suggestedFileName(this.state));
    } catch (e) {
      this.logFailure('save-as', e);
      this.deps.notify({ kind: 'error', message: describeError(e) });
      return 'failed';
    }
    if (path === null) return 'cancelled';
    const { format } = this.state;
    try {
      const result = await this.deps.bridge.saveDocumentAs(path, text, format);
      return await this.applySaveResult(result, { path, text, format });
    } catch (e) {
      this.logFailure('save-as', e);
      this.deps.notify({ kind: 'error', message: describeError(e) });
      return 'failed';
    }
  }

  private async writeExisting(plan: Extract<SavePlan, { kind: 'write' }>, text: string): Promise<SaveResult> {
    const { format } = this.state;
    try {
      const result = await this.deps.bridge.saveDocument(plan.path, text, format, {
        expectedRevision: plan.expectedRevision,
        overwrite: plan.overwrite,
      });
      return await this.applySaveResult(result, { path: plan.path, text, format });
    } catch (e) {
      this.logFailure('save', e);
      this.deps.notify({ kind: 'error', message: describeError(e) });
      return 'failed';
    }
  }

  private async applySaveResult(
    result: BridgeSaveResult,
    saved: { path: string; text: string; format: DocumentState['format'] },
  ): Promise<SaveResult> {
    if (result.kind === 'conflict') {
      // 書かなかった。ディスクの内容を読み、競合として見せる（無言で上書きしない）。
      await this.inspectAfterConflict(saved.path);
      this.deps.notify({
        kind: 'error',
        message: '保存の直前にファイルが変更されていたため、保存しませんでした。競合バーで、どうするか選んでください。',
      });
      return 'conflict';
    }
    this.setState(savedDocumentState(this.state, { ...saved, revision: result.revision }));
    this.setExternal(NO_EXTERNAL_CHANGE);
    if (result.backup !== null) {
      this.deps.notify({
        kind: 'info',
        message: `ディスク上の版をバックアップしてから、保存しました（バックアップ: ${result.backup}）。`,
      });
    } else if (result.outcome === 'written') {
      const notice = mixedEolNotice(saved.format);
      if (notice) this.deps.notify({ kind: 'info', message: notice });
    } else {
      this.deps.notify({ kind: 'info', message: '内容がファイルと同じため、書き込みませんでした。' });
    }
    return result.outcome;
  }

  // ---- 外部変更 ----

  /**
   * 開いている文書のディスクの状態を確かめ、外部変更なら状態を更新する。
   * 監視の通知とウィンドウのフォーカス復帰から呼ぶ。ほかの操作の実行中なら、終わってからやり直す。
   */
  checkExternal = async (): Promise<void> => {
    if (this.busy) {
      this.recheck = true;
      return;
    }
    await this.exclusive(async () => {
      const path = this.state.path;
      if (path === null) return;
      this.syncText();
      const obs = await this.readDisk(path);
      if (obs === null || this.state.path !== path) return;
      this.applyObservation(obs);
    });
  };

  private async inspectAfterConflict(path: string): Promise<void> {
    const obs = await this.readDisk(path);
    if (obs === null || this.state.path !== path) return;
    this.syncText();
    this.applyObservation(obs);
  }

  /** ディスクの現在の状態を観測する。確認自体に失敗したら null。 */
  private async readDisk(path: string): Promise<DiskObservation | null> {
    let revision: string;
    try {
      const disk = await this.deps.bridge.checkDocument(path);
      if (disk.kind === 'missing') return { kind: 'deleted' };
      revision = disk.revision;
    } catch {
      return null;
    }
    if (revision === this.state.diskRevision) return { kind: 'unchanged' };
    const known = this.knownDiskSide();
    if (known?.revision === revision) return known;

    try {
      const opened = await this.deps.bridge.openDocument(path);
      this.unreadableRevision = null;
      return { kind: 'changed', revision: opened.revision, text: opened.text, format: opened.format };
    } catch (e) {
      if (e instanceof BridgeError && e.kind === 'not-found') return { kind: 'deleted' };
      if (this.unreadableRevision !== revision) {
        this.unreadableRevision = revision;
        this.deps.notify({
          kind: 'error',
          message: `ファイルが外部で変更されましたが、読み込めませんでした。${describeError(e)}`,
        });
      }
      return null;
    }
  }

  private knownDiskSide(): ChangedOnDisk | null {
    const ext = this.external;
    if (ext.kind === 'changed') return ext.disk;
    if (ext.kind === 'conflict' && ext.disk.kind === 'changed') return ext.disk;
    return null;
  }

  private applyObservation(obs: DiskObservation): void {
    const { next, effect } = observeDisk(this.state, this.external, obs);
    this.setExternal(next);
    switch (effect) {
      case 'none':
        return;
      case 'reload':
        if (next.kind === 'changed') {
          this.reloadWith(next.disk);
          this.deps.notify({ kind: 'info', message: 'ファイルが外部で変更されたため、読み直しました。' });
        }
        return;
      case 'announce-conflict':
        this.deps.notify({ kind: 'info', message: CONFLICT_NOTICE });
        return;
      case 'announce-deleted':
        this.deps.notify({ kind: 'info', message: DELETED_NOTICE });
        return;
    }
  }

  /** 本文をディスクの内容に置き換える（履歴はリセットされる）。 */
  private reloadWith(disk: ChangedOnDisk): void {
    const path = this.state.path;
    if (path === null) return;
    this.deps.io.setText(disk.text);
    this.setExternal(NO_EXTERNAL_CHANGE);
    this.setState(reloadedDocumentState(this.state, { path, text: disk.text, format: disk.format, revision: disk.revision }));
  }

  /**
   * 競合バーの「ディスクから読み直す」。自分の本文は、新しい草稿として退避してから読み込む。
   * 退避できなければ、読み直さない。
   */
  reloadFromDisk = (): Promise<void> =>
    this.exclusive(async () => {
      const ext = this.external;
      if (ext.kind !== 'conflict' || ext.disk.kind !== 'changed') return;
      this.syncText();
      let stashedAt: string | null = null;
      if (isDirty(this.state)) {
        const stash: Draft = { ...buildDraft(this.state, Date.now()), draftId: this.newId() };
        try {
          stashedAt = await this.deps.bridge.writeDraft(stash);
        } catch (e) {
          this.deps.notify({
            kind: 'error',
            message: `自分の版を草稿に退避できなかったため、読み直しませんでした。${describeError(e)}`,
          });
          return;
        }
      }
      this.reloadWith(ext.disk);
      this.deps.notify({
        kind: 'info',
        message:
          stashedAt === null
            ? 'ディスクの内容を読み直しました。'
            : `ディスクの内容を読み直しました。自分の版は草稿に退避しました（${stashedAt}）。次回の起動時に、草稿として復元できます。`,
      });
    });

  /** 競合バーの「自分の版を残す」。次の保存で、ディスクの版をバックアップしてから置き換える。 */
  keepMine = (): void => {
    const next = keepMine(this.external);
    if (next === this.external) return;
    this.setExternal(next);
    this.deps.notify({
      kind: 'info',
      message: '自分の版を残します。次に保存すると、ディスク上の版はバックアップしてから置き換えます。',
    });
  };

  /** ファイルが削除された状態か。 */
  isDeletedOnDisk = (): boolean => isDeleted(this.external);

  // ---- 終了 ----

  /**
   * 窓を閉じる・終了する操作があったとき。未保存の変更がなければそのまま終了する。
   * あれば 保存 / 保存しない / キャンセル を確認する。保存しない場合は、その文書の草稿も消す。
   */
  requestClose = (): Promise<void> => {
    if (this.busy) {
      // 実行中の操作（フォーカス時の外部変更の確認など）が終わってから処理する。捨てない。
      if (!this.closing) this.closeRequested = true;
      return Promise.resolve();
    }
    return this.exclusive(async () => {
      this.closing = true;
      try {
        this.syncText();
        if (isDirty(this.state)) {
          const choice = await this.deps.confirmDiscard(documentTitle(this.state));
          if (choice === 'cancel') return;
          if (choice === 'save') {
            const result = await this.saveInner();
            if (result !== 'written' && result !== 'unchanged') return;
          } else {
            await this.keeper.discard(this.state.draftId);
          }
        }
        try {
          await this.deps.bridge.closeApp();
        } catch (e) {
          this.deps.notify({ kind: 'error', message: describeError(e) });
        }
      } finally {
        this.closing = false;
      }
    });
  };
}
