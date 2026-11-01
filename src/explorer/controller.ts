import type { Notice } from '../document/controller';
import { describeError } from '../document/controller';
import { BridgeError, type DocumentBridge, type FolderListing } from '../platform';
import { sortEntries, type DirState } from './tree';

export interface ExplorerState {
  /** 開いているフォルダの絶対パス。未選択は null。 */
  readonly root: string | null;
  /** 読み込み済み（読み込み中、失敗を含む）のフォルダの中身。キーはパス。 */
  readonly dirs: ReadonlyMap<string, DirState>;
  /** 展開しているフォルダのパス（ルートを含まない）。保存しない。 */
  readonly expanded: ReadonlySet<string>;
}

export interface ExplorerDeps {
  bridge: Pick<DocumentBridge, 'pickFolderPath' | 'openFolder' | 'listFolder' | 'loadSession' | 'saveSession'>;
  notify(notice: Notice): void;
}

const EMPTY: ExplorerState = { root: null, dirs: new Map(), expanded: new Set() };

/** フォルダの操作の失敗を、利用者向けの短い文にする。 */
export function describeFolderError(e: unknown): string {
  if (e instanceof BridgeError) {
    switch (e.kind) {
      case 'not-found':
        return 'フォルダが見つかりません。';
      case 'permission-denied':
        return 'フォルダを読む権限がありません。';
      case 'not-allowed':
        return 'このフォルダは開けません。';
      case 'invalid-input':
        return 'フォルダとして開けません。';
      case 'io':
        return `フォルダを読めませんでした（${e.message}）。`;
    }
  }
  return describeError(e);
}

function loadedState(listing: FolderListing): DirState {
  return {
    status: 'loaded',
    entries: sortEntries(listing.entries),
    more: Math.max(0, listing.total - listing.entries.length),
  };
}

/**
 * エクスプローラーのフォルダの状態。フォルダを選ぶ、前回のフォルダを復元する、展開したときに中身を読む（遅延読み込み）、
 * 再読み込み（展開状態を保つ）を担う。表示のロジックは tree.ts、副作用（bridge、通知）はここ。
 * フォルダを切り替えた後に届いた、前のフォルダの読み込み結果は捨てる。
 */
export class ExplorerController {
  private state: ExplorerState = EMPTY;
  private readonly listeners = new Set<() => void>();
  /** フォルダを切り替えるたびに進める。読み込みの結果が、いまのフォルダのものかを確かめる。 */
  private generation = 0;
  /** フォルダを開く操作（選択、復元）の最新の番号。古い操作の結果は捨てる。 */
  private openTicket = 0;
  private restored = false;

  constructor(private readonly deps: ExplorerDeps) {}

  getState = (): ExplorerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(next: ExplorerState): void {
    this.state = next;
    this.listeners.forEach((l) => l());
  }

  private setDir(path: string, dir: DirState, expanded: ReadonlySet<string> = this.state.expanded): void {
    this.setState({ ...this.state, dirs: new Map(this.state.dirs).set(path, dir), expanded });
  }

  /** 起動時に一度だけ。前回のフォルダがあれば開く。開けなければ未選択のまま、エラーを短く知らせる。 */
  restore = async (): Promise<void> => {
    if (this.restored) return;
    this.restored = true;
    const session = await this.deps.bridge.loadSession().catch(() => null);
    const folder = session?.lastFolder;
    if (folder) await this.openRoot(folder, true);
  };

  /** フォルダ選択ダイアログ。キャンセルは何もしない。 */
  chooseFolder = async (): Promise<void> => {
    let path: string | null;
    try {
      path = await this.deps.bridge.pickFolderPath();
    } catch (e) {
      this.deps.notify({ kind: 'error', message: describeFolderError(e) });
      return;
    }
    if (path !== null) await this.openRoot(path, false);
  };

  /** フォルダを開き、直下の中身を読んでから、ツリーに出す（開けなければ、いまの表示を変えない）。 */
  private async openRoot(path: string, restoring: boolean): Promise<void> {
    const ticket = ++this.openTicket;
    try {
      await this.deps.bridge.openFolder(path);
      const listing = await this.deps.bridge.listFolder(path);
      if (ticket !== this.openTicket) return;
      this.generation++;
      this.setState({ root: path, dirs: new Map([[path, loadedState(listing)]]), expanded: new Set() });
      void this.deps.bridge.saveSession({ lastFolder: path }).catch(() => {});
    } catch (e) {
      if (ticket !== this.openTicket) return;
      const reason = describeFolderError(e);
      if (restoring) {
        this.deps.notify({ kind: 'error', message: `前回のフォルダを開けませんでした。${reason}` });
        void this.deps.bridge.saveSession({ lastFolder: null }).catch(() => {});
      } else {
        this.deps.notify({ kind: 'error', message: `フォルダを開けませんでした。${reason}` });
      }
    }
  }

  toggle = (path: string): void => {
    if (this.state.expanded.has(path)) this.collapse(path);
    else this.expand(path);
  };

  collapse = (path: string): void => {
    if (!this.state.expanded.has(path)) return;
    const expanded = new Set(this.state.expanded);
    expanded.delete(path);
    this.setState({ ...this.state, expanded });
  };

  /** 展開する。まだ読んでいない（または前回失敗した）フォルダは、このとき中身を読む。 */
  expand = (path: string): void => {
    if (this.state.root === null || this.state.expanded.has(path)) return;
    const expanded = new Set(this.state.expanded).add(path);
    const current = this.state.dirs.get(path);
    if (current && current.status !== 'error') {
      this.setState({ ...this.state, expanded });
      return;
    }
    this.setDir(path, { status: 'loading' }, expanded);
    void this.load(path, this.generation);
  };

  private async load(path: string, generation: number): Promise<void> {
    try {
      const listing = await this.deps.bridge.listFolder(path);
      if (generation === this.generation) this.setDir(path, loadedState(listing));
    } catch (e) {
      if (generation !== this.generation) return;
      const message = describeFolderError(e);
      this.setDir(path, { status: 'error', message });
      this.deps.notify({ kind: 'error', message });
    }
  }

  /**
   * 開いているフォルダと、展開しているフォルダを読み直す。展開状態は保つ。
   * 展開していないフォルダの読み込み済みの中身は捨てる（次に展開したとき、新しく読む）。
   * 展開していたフォルダが消えていたら、展開をやめる。ルートが読めなければ、いまの表示を残して知らせる。
   */
  refresh = async (): Promise<void> => {
    const { root } = this.state;
    if (root === null) return;
    const generation = this.generation;
    const paths = [root, ...this.state.expanded];
    const results = await Promise.all(
      paths.map((path) =>
        this.deps.bridge.listFolder(path).then(
          (listing) => ({ path, listing }),
          (error: unknown) => ({ path, error }),
        ),
      ),
    );
    if (generation !== this.generation) return;

    const dirs = new Map<string, DirState>();
    const expanded = new Set(this.state.expanded);
    let firstError: string | null = null;
    for (const result of results) {
      if ('listing' in result) {
        dirs.set(result.path, loadedState(result.listing));
        continue;
      }
      const message = describeFolderError(result.error);
      firstError ??= message;
      if (result.path === root) {
        const previous = this.state.dirs.get(root);
        if (previous) dirs.set(root, previous);
      } else if (result.error instanceof BridgeError && result.error.kind === 'not-found') {
        expanded.delete(result.path);
      } else {
        dirs.set(result.path, { status: 'error', message });
      }
    }
    this.setState({ root, dirs, expanded });
    if (firstError !== null) this.deps.notify({ kind: 'error', message: `再読み込みできませんでした。${firstError}` });
  };
}
