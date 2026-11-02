import type { Notice } from '../document/controller';
import { describeError } from '../document/controller';
import { BridgeError, type DocumentBridge, type FolderListing } from '../platform';
import { createTargetDir, checkName, isSameOrInside, parentOf, relocatePath, renameSelection, withDefaultExtension } from './names';
import { buildTree, flattenRows, neighborAfterRemoval, sortEntries, type DirState, type TreeRow } from './tree';

/** ツリーの中の入力欄（作成する名前、または変える名前）。 */
export interface InlineEdit {
  readonly mode: 'create-file' | 'create-folder' | 'rename';
  /** 作成先のフォルダ。名前の変更では、対象の親フォルダ。 */
  readonly parentPath: string;
  /** 名前の変更の対象のパス。作成では null。 */
  readonly targetPath: string | null;
  /** 入力欄の最初の値と、その選択範囲。 */
  readonly initial: string;
  readonly selection: readonly [number, number];
  /** 拒否した理由（入力欄の近くに出す）。 */
  readonly error: string | null;
  /** ネイティブ側の操作を待っている間。二重の確定を防ぐ。 */
  readonly busy: boolean;
}

/** 起動時に復元できなかった前回のフォルダ。記録（session の lastFolder）は残してあり、再試行できる。 */
export interface RestoreFailure {
  readonly path: string;
  readonly message: string;
}

export interface ExplorerState {
  /** 開いているフォルダの絶対パス。未選択は null。 */
  readonly root: string | null;
  /** 読み込み済み（読み込み中、失敗を含む）のフォルダの中身。キーはパス。 */
  readonly dirs: ReadonlyMap<string, DirState>;
  /** 展開しているフォルダのパス（ルートを含まない）。保存しない。 */
  readonly expanded: ReadonlySet<string>;
  /** 選択（キーボードの位置）している項目のパス。なければ null。作成先の決定に使う。 */
  readonly selected: string | null;
  /** 表示中の入力欄。なければ null。 */
  readonly edit: InlineEdit | null;
  /** 前回のフォルダを開けなかったとき。 */
  readonly restoreFailure: RestoreFailure | null;
}

/** ゴミ箱への移動の確認に出す、対象の情報。 */
export interface TrashTarget {
  readonly name: string;
  readonly kind: 'file' | 'folder';
}

/** 開いている文書（DocumentController）との接点。ツリーの操作が文書に及ぶときに使う。 */
export interface ExplorerDocuments {
  /** 開いている文書が、path そのもの、または path のフォルダの中にあるか。 */
  isDocumentInside(path: string): boolean;
  /** 名前の変更。perform が実際に名前を変えて新しいパスを返す。文書に及ぶなら、文書を新しいパスへ移す。実行できなければ null。 */
  rename(oldPath: string, perform: () => Promise<string>): Promise<string | null>;
  /** 開いている文書のディスクの状態を確かめる（ゴミ箱へ移した直後に、外部で消えた扱いにするため）。 */
  checkExternal(): Promise<void>;
  /** 文書を開く（「開く」と同じ確認を通る）。 */
  open(path: string): Promise<boolean>;
}

export interface ExplorerDeps {
  bridge: Pick<
    DocumentBridge,
    | 'pickFolderPath'
    | 'openFolder'
    | 'listFolder'
    | 'loadSession'
    | 'saveSession'
    | 'createFile'
    | 'createFolder'
    | 'renameEntry'
    | 'trashEntry'
    | 'watchFolders'
    | 'onFolderChanged'
  >;
  notify(notice: Notice): void;
  /** ゴミ箱へ移す前の確認。true なら移す。未指定なら移さない。 */
  confirmTrash?(target: TrashTarget): Promise<boolean>;
  documents?: ExplorerDocuments;
}

const EMPTY: ExplorerState = {
  root: null,
  dirs: new Map(),
  expanded: new Set(),
  selected: null,
  edit: null,
  restoreFailure: null,
};

const BUSY_MESSAGE = '文書の操作の実行中です。少し待ってから、もう一度お試しください。';

/** 作成・名前の変更・ゴミ箱への移動の失敗を、利用者向けの短い文にする。 */
export function describeEntryError(e: unknown): string {
  if (e instanceof BridgeError) {
    switch (e.kind) {
      case 'already-exists':
        return '同じ名前の項目がすでにあります。';
      case 'not-allowed':
        return 'この場所では操作できません。';
      case 'permission-denied':
        return '権限がないため、操作できませんでした。';
      case 'not-found':
        return '項目が見つかりません。外部で変更された可能性があります。';
      case 'invalid-input':
        return '使えない名前です。';
      case 'io':
        return `操作に失敗しました（${e.message}）。`;
    }
  }
  return describeError(e);
}

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
      case 'already-exists':
        return '同じ名前の項目がすでにあります。';
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
  /** フォルダごとの、読み直しの最新の番号。古い読み直しの結果で、新しい結果を上書きしない。 */
  private readonly reloadTickets = new Map<string, number>();
  private ticketCounter = 0;
  /** ネイティブ側へ最後に渡した、監視するフォルダの一覧（JSON）。同じ一覧なら渡し直さない。 */
  private watchKey = '[]';
  private watchRunning = false;
  private watchDirty = false;
  private watchFailed = false;

  constructor(private readonly deps: ExplorerDeps) {}

  getState = (): ExplorerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setState(next: ExplorerState): void {
    const previous = this.state;
    this.state = next;
    this.listeners.forEach((l) => l());
    if (previous.root !== next.root || previous.expanded !== next.expanded) this.syncWatch();
  }

  /** 見せているフォルダ（ルートと展開中のフォルダ）が変わったら、ネイティブ側の監視を付け替える。呼び出しは順番に 1 つずつ。 */
  private syncWatch(): void {
    this.watchDirty = true;
    if (this.watchRunning) return;
    void this.runWatch();
  }

  private async runWatch(): Promise<void> {
    this.watchRunning = true;
    try {
      while (this.watchDirty) {
        this.watchDirty = false;
        const { root, expanded } = this.state;
        const paths = root === null ? [] : [root, ...expanded];
        const key = JSON.stringify(paths);
        if (key === this.watchKey) continue;
        this.watchKey = key;
        try {
          await this.deps.bridge.watchFolders(paths);
          this.watchFailed = false;
        } catch (e) {
          this.watchKey = '';
          if (!this.watchFailed) {
            this.watchFailed = true;
            this.deps.notify({
              kind: 'info',
              message: `フォルダの変更を監視できませんでした（${describeEntryError(e)}）。再読み込みボタンで読み直せます。`,
            });
          }
        }
      }
    } finally {
      this.watchRunning = false;
    }
  }

  /** ネイティブ側からの「フォルダの項目が増減した」通知を受け取る。解除関数を返す。 */
  attach = async (): Promise<() => void> => {
    try {
      return await this.deps.bridge.onFolderChanged((path) => this.handleFolderChanged(path));
    } catch {
      return () => {};
    }
  };

  /** 監視中のフォルダの変更。見せているフォルダ（ルートか展開中）だけを読み直す。展開状態と選択は保つ。 */
  handleFolderChanged = (path: string): void => {
    const { root, expanded } = this.state;
    if (root === null || (path !== root && !expanded.has(path))) return;
    void this.reloadDirs([path], true);
  };

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
      this.setState({
        root: path,
        dirs: new Map([[path, loadedState(listing)]]),
        expanded: new Set(),
        selected: null,
        edit: null,
        restoreFailure: null,
      });
      // 別のフォルダを開けたときは、その記録で上書きする（前回のフォルダの記録は、開けなかったときも消さない）。
      void this.deps.bridge.saveSession({ lastFolder: path }).catch(() => {});
    } catch (e) {
      if (ticket !== this.openTicket) return;
      const reason = describeFolderError(e);
      if (restoring) {
        // 外付けドライブが外れているだけのこともあるので、記録は消さず、再試行できるようにする。
        this.deps.notify({ kind: 'error', message: `前回のフォルダを開けませんでした。${reason}` });
        this.setState({ ...this.state, restoreFailure: { path, message: reason } });
      } else {
        this.deps.notify({ kind: 'error', message: `フォルダを開けませんでした。${reason}` });
      }
    }
  }

  /** 起動時に開けなかった前回のフォルダを、もう一度開く。 */
  retryRestore = async (): Promise<void> => {
    const failure = this.state.restoreFailure;
    if (failure) await this.openRoot(failure.path, true);
  };

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
    this.setState({ ...this.state, root, dirs, expanded });
    if (firstError !== null) this.deps.notify({ kind: 'error', message: `再読み込みできませんでした。${firstError}` });
  };

  // ---- 選択 ----

  /** 選択（キーボードの位置）を変える。作成先の決定に使う。 */
  select = (id: string | null): void => {
    if (this.state.selected === id) return;
    this.setState({ ...this.state, selected: id });
  };

  /** いま見えている行。 */
  private rows(): TreeRow[] {
    const { root, dirs, expanded } = this.state;
    return root === null ? [] : flattenRows(buildTree(root, dirs, expanded));
  }

  private rowFor(path: string): TreeRow | undefined {
    return this.rows().find((r) => r.id === path && r.entry !== undefined);
  }

  /** 読み込み済みのフォルダの項目の名前（同名の検査用）。まだ読んでいなければ空。 */
  private namesIn(dir: string): string[] {
    const state = this.state.dirs.get(dir);
    return state?.status === 'loaded' ? state.entries.map((e) => e.name) : [];
  }

  // ---- 入力欄（作成・名前の変更） ----

  private setEdit(edit: InlineEdit | null): void {
    this.setState({ ...this.state, edit });
  }

  /**
   * 作成の入力欄を出す。作成先は、parent があればそれ、なければ選択中のフォルダ、ファイルが選択中ならその親、
   * 何も選んでいなければルート。作成先が閉じていれば展開する。
   */
  beginCreate = (kind: 'file' | 'folder', parent?: string): void => {
    const { root, edit } = this.state;
    if (root === null || edit?.busy) return;
    const target = parent ?? createTargetDir(root, this.rows(), this.state.selected);
    if (target !== root) this.expand(target);
    this.setEdit({
      mode: kind === 'file' ? 'create-file' : 'create-folder',
      parentPath: target,
      targetPath: null,
      initial: '',
      selection: [0, 0],
      error: null,
      busy: false,
    });
  };

  /** 名前の変更の入力欄を出す（既定の選択範囲は拡張子の前まで）。 */
  beginRename = (path?: string): void => {
    const { root, edit } = this.state;
    if (root === null || edit?.busy) return;
    const row = this.rowFor(path ?? this.state.selected ?? '');
    if (!row?.entry) return;
    const isFolder = row.kind === 'dir' || row.kind === 'symlinkDir';
    this.setState({
      ...this.state,
      selected: row.id,
      edit: {
        mode: 'rename',
        parentPath: row.parentId ?? root,
        targetPath: row.id,
        initial: row.label,
        selection: renameSelection(row.label, isFolder),
        error: null,
        busy: false,
      },
    });
  };

  cancelEdit = (): void => {
    if (this.state.edit && !this.state.edit.busy) this.setEdit(null);
  };

  /** 入力が変わったら、前の拒否の理由は消す。 */
  clearEditError = (): void => {
    const edit = this.state.edit;
    if (edit?.error) this.setEdit({ ...edit, error: null });
  };

  /**
   * 入力欄の確定（Enter）。検査して、作成または名前の変更をする。拒否したら、入力欄を残して理由を出す。
   * 作ったファイルは開き、作ったフォルダは展開して選択する。
   */
  commitEdit = async (raw: string): Promise<void> => {
    const edit = this.state.edit;
    if (!edit || edit.busy) return;
    const oldName = edit.targetPath === null ? null : (this.rowFor(edit.targetPath)?.label ?? null);
    if (edit.mode === 'rename' && raw === oldName) {
      this.setEdit(null);
      return;
    }
    // 入力した名前そのものを先に検査する（拡張子を足すと、末尾のドットなどの問題が隠れるため）。
    const typed = checkName(raw, []);
    const name = typed.ok && edit.mode === 'create-file' ? withDefaultExtension(raw) : raw;
    const siblings = this.namesIn(edit.parentPath).filter((n) => n !== oldName);
    const check = typed.ok ? checkName(name, siblings) : typed;
    if (!check.ok) {
      this.setEdit({ ...edit, error: check.message });
      return;
    }

    this.setEdit({ ...edit, error: null, busy: true });
    const generation = this.generation;
    const fail = (e: unknown) => {
      const current = this.state.edit;
      if (generation === this.generation && current) this.setEdit({ ...current, busy: false, error: describeEntryError(e) });
    };

    if (edit.mode === 'rename') {
      await this.finishRename(edit, check.name, generation, fail);
      return;
    }
    let created: string;
    try {
      created =
        edit.mode === 'create-file'
          ? await this.deps.bridge.createFile(edit.parentPath, check.name)
          : await this.deps.bridge.createFolder(edit.parentPath, check.name);
    } catch (e) {
      fail(e);
      return;
    }
    if (generation !== this.generation) return;
    this.setState({ ...this.state, edit: null, selected: created });
    await this.reloadDirs([edit.parentPath]);
    if (edit.mode === 'create-folder') {
      this.expand(created);
    } else {
      await this.deps.documents?.open(created);
    }
  };

  private async finishRename(
    edit: InlineEdit,
    newName: string,
    generation: number,
    fail: (e: unknown) => void,
  ): Promise<void> {
    const oldPath = edit.targetPath;
    if (oldPath === null) return;
    const perform = () => this.deps.bridge.renameEntry(oldPath, newName);
    let newPath: string | null;
    try {
      newPath = this.deps.documents ? await this.deps.documents.rename(oldPath, perform) : await perform();
    } catch (e) {
      fail(e);
      return;
    }
    if (newPath === null) {
      fail(new Error(BUSY_MESSAGE));
      return;
    }
    if (generation !== this.generation) return;

    // 展開状態と選択を、新しいパスへ引き継ぐ。名前を変えたフォルダの中の読み込み済みの中身は、パスが古いので捨てて読み直す。
    const moved = (path: string) => relocatePath(path, oldPath, newPath) ?? path;
    const dirs = new Map<string, DirState>();
    for (const [path, dir] of this.state.dirs) if (!isSameOrInside(path, oldPath)) dirs.set(path, dir);
    const expanded = new Set([...this.state.expanded].map(moved));
    const reload = [edit.parentPath, ...[...expanded].filter((p) => isSameOrInside(p, newPath))];
    this.setState({
      ...this.state,
      dirs,
      expanded,
      selected: this.state.selected === null ? newPath : moved(this.state.selected),
      edit: null,
    });
    await this.reloadDirs(reload);
  }

  // ---- ゴミ箱 ----

  /**
   * ゴミ箱へ移す。毎回、確認を出す。開いている文書（またはそれを含むフォルダ）を移したら、直後に文書のディスクの状態を確かめ、
   * 既存の「外部で消えた」の扱いに乗せる（監視の通知は待たない。親フォルダごと移すと、通知が来ないことがあるため）。
   * 移した後、選択は隣の項目へ移す。
   */
  requestTrash = async (path?: string): Promise<void> => {
    const { root, selected } = this.state;
    if (root === null) return;
    const row = this.rowFor(path ?? selected ?? '');
    if (!row?.entry) return;
    const target = row.id;
    this.cancelEdit();
    const confirmed = await this.deps.confirmTrash?.({ name: row.label, kind: row.kind === 'dir' ? 'folder' : 'file' });
    if (!confirmed) return;

    const generation = this.generation;
    const next = neighborAfterRemoval(this.rows(), target);
    const parent = row.parentId ?? root;
    const affectsDocument = this.deps.documents?.isDocumentInside(target) ?? false;
    try {
      await this.deps.bridge.trashEntry(target);
    } catch (e) {
      this.deps.notify({ kind: 'error', message: `ゴミ箱に移せませんでした。${describeEntryError(e)}` });
      return;
    }
    if (affectsDocument) await this.deps.documents?.checkExternal();
    if (generation !== this.generation) return;

    const dirs = new Map<string, DirState>();
    for (const [p, dir] of this.state.dirs) if (!isSameOrInside(p, target)) dirs.set(p, dir);
    const expanded = new Set([...this.state.expanded].filter((p) => !isSameOrInside(p, target)));
    this.setState({ ...this.state, dirs, expanded, selected: next });
    await this.reloadDirs([parent]);
  };

  // ---- 読み直し ----

  /**
   * 指定したフォルダだけを読み直す（再読み込みボタンと違い、ほかのフォルダの中身は捨てない）。展開状態と選択は保つ。
   * 消えたフォルダは、展開をやめる。なくなった子のフォルダの展開も、やめる。quiet なら、失敗を通知しない（監視からの読み直し用）。
   */
  private async reloadDirs(paths: readonly string[], quiet = false): Promise<void> {
    const root = this.state.root;
    if (root === null) return;
    const generation = this.generation;
    const tickets = new Map(paths.map((p) => [p, ++this.ticketCounter] as const));
    for (const [p, t] of tickets) this.reloadTickets.set(p, t);
    const results = await Promise.all(
      paths.map((path) =>
        this.deps.bridge.listFolder(path).then(
          (listing) => ({ path, listing }),
          (error: unknown) => ({ path, error }),
        ),
      ),
    );
    if (generation !== this.generation || this.state.root !== root) return;

    const dirs = new Map(this.state.dirs);
    let expanded = new Set(this.state.expanded);
    const collapse = (gone: string) => {
      expanded = new Set([...expanded].filter((p) => !isSameOrInside(p, gone)));
      for (const key of [...dirs.keys()]) if (key !== root && isSameOrInside(key, gone)) dirs.delete(key);
    };
    let firstError: string | null = null;
    for (const result of results) {
      if (this.reloadTickets.get(result.path) !== tickets.get(result.path)) continue;
      if ('listing' in result) {
        dirs.set(result.path, loadedState(result.listing));
        const present = new Set(result.listing.entries.filter((e) => e.kind === 'dir').map((e) => e.path));
        for (const p of [...expanded]) if (parentOf(p) === result.path && !present.has(p)) collapse(p);
        continue;
      }
      const message = describeFolderError(result.error);
      firstError ??= message;
      if (result.path === root) continue;
      if (result.error instanceof BridgeError && result.error.kind === 'not-found') collapse(result.path);
      else dirs.set(result.path, { status: 'error', message });
    }
    this.setState({ ...this.state, dirs, expanded });
    if (!quiet && firstError !== null) {
      this.deps.notify({ kind: 'error', message: `フォルダを読み直せませんでした。${firstError}` });
    }
  }
}
