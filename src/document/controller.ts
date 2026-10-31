import { BridgeError, type DocumentBridge } from '../platform';
import {
  documentTitle,
  mixedEolNotice,
  needsDiscardConfirmation,
  newDocumentState,
  openedDocumentState,
  planSave,
  savedDocumentState,
  suggestedFileName,
  withText,
  type DocumentState,
} from './state';

/** 編集エンジンとの接点。EditorAdapter のうち、controller が使う部分だけ。 */
export interface DocumentIo {
  getText(): string;
  setText(text: string): void;
}

export type DiscardChoice = 'save' | 'discard' | 'cancel';

export interface Notice {
  readonly kind: 'info' | 'error';
  readonly message: string;
}

export interface ControllerDeps {
  bridge: DocumentBridge;
  io: DocumentIo;
  /** 未保存の変更があるまま新規・開くを実行するときの確認。 */
  confirmDiscard(documentName: string): Promise<DiscardChoice>;
  notify(notice: Notice): void;
}

export type SaveResult = 'written' | 'unchanged' | 'noop' | 'cancelled' | 'failed';

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
      case 'io':
        return `ファイルの読み書きに失敗しました（${e.message}）。`;
    }
  }
  return `予期しないエラーが発生しました（${e instanceof Error ? e.message : String(e)}）。`;
}

/**
 * 新規・開く・保存・別名保存の副作用層。判断（何をするか）は state.ts の純関数に任せ、
 * ここは bridge・編集エンジン・通知を順に呼ぶだけにする。
 * 操作の実行中は、ほかの操作（ショートカットの連打など）を受け付けない。
 */
export class DocumentController {
  private state: DocumentState = newDocumentState();
  private listeners = new Set<() => void>();
  private busy = false;

  constructor(private readonly deps: ControllerDeps) {}

  getState = (): DocumentState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(next: DocumentState): void {
    if (next === this.state) return;
    this.state = next;
    this.listeners.forEach((l) => l());
  }

  /** 編集エンジンからの本文の変化。 */
  handleEdit = (text: string): void => {
    this.setState(withText(this.state, text));
  };

  newDocument = (): Promise<void> =>
    this.exclusive(async () => {
      if (!(await this.discardOrSave())) return;
      this.deps.io.setText('');
      this.setState(newDocumentState());
    });

  openDocument = (): Promise<void> =>
    this.exclusive(async () => {
      if (!(await this.discardOrSave())) return;
      const path = await this.deps.bridge.pickOpenPath();
      if (path === null) return;
      try {
        const opened = await this.deps.bridge.openDocument(path);
        this.deps.io.setText(opened.text);
        this.setState(openedDocumentState(opened.path, opened.text, opened.format));
      } catch (e) {
        this.deps.notify({ kind: 'error', message: describeError(e) });
      }
    });

  save = (): Promise<SaveResult> => this.exclusive(() => this.saveInner(), 'noop');

  saveAs = (): Promise<SaveResult> => this.exclusive(() => this.saveAsInner(), 'noop');

  private async exclusive<T>(task: () => Promise<T>, whenBusy?: T): Promise<T> {
    if (this.busy) return whenBusy as T;
    this.busy = true;
    try {
      return await task();
    } finally {
      this.busy = false;
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
    const plan = planSave(this.state);
    switch (plan.kind) {
      case 'choose-path':
        return this.saveAsInner();
      case 'noop':
        return 'noop';
      case 'write':
        return this.write(plan.path, text, false);
    }
  }

  private async saveAsInner(): Promise<SaveResult> {
    const text = this.syncText();
    let path: string | null;
    try {
      path = await this.deps.bridge.pickSavePath(suggestedFileName(this.state));
    } catch (e) {
      this.deps.notify({ kind: 'error', message: describeError(e) });
      return 'failed';
    }
    if (path === null) return 'cancelled';
    return this.write(path, text, true);
  }

  private async write(path: string, text: string, asNew: boolean): Promise<SaveResult> {
    const { format } = this.state;
    try {
      const outcome = asNew
        ? await this.deps.bridge.saveDocumentAs(path, text, format)
        : await this.deps.bridge.saveDocument(path, text, format);
      this.setState(savedDocumentState(this.state, { path, text, format }));
      if (outcome === 'written') {
        const notice = mixedEolNotice(format);
        if (notice) this.deps.notify({ kind: 'info', message: notice });
      } else {
        this.deps.notify({ kind: 'info', message: '内容がファイルと同じため、書き込みませんでした。' });
      }
      return outcome;
    } catch (e) {
      this.deps.notify({ kind: 'error', message: describeError(e) });
      return 'failed';
    }
  }
}
