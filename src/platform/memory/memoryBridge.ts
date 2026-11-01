// e2e 専用のメモリ実装。VITE_E2E=1 のビルドにだけ含まれる（src/platform/index.ts の __E2E__）。
import type { EditorAdapter } from '../../editor/EditorAdapter';
import { basename } from '../../document/state';
import {
  BridgeError,
  FOLDER_LISTING_LIMIT,
  type BackgroundImageData,
  type DiskState,
  type DocumentBridge,
  type Draft,
  type FolderEntry,
  type FolderEntryKind,
  type FolderListing,
  type OpenedDocument,
  type SaveOptions,
  type SaveOutcome,
  type SaveResult,
  type SessionInfo,
} from '../DocumentBridge';
import { decodeBytes, encodeText, sameBytes, sha256Hex, sniffImageMime } from './bytes';

/** 取り込める画像の上限（Rust 側と同じ）。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 設定を再読み込みをまたいで保つ sessionStorage のキー（実アプリの preferences.json の代わり）。 */
const PREFS_KEY = '__mdeE2E_preferences';
/** 開いているフォルダ（session.lastFolder）を再読み込みをまたいで保つ sessionStorage のキー（実アプリの session.json の代わり）。 */
const FOLDER_KEY = '__mdeE2E_lastFolder';

/** テストが addInitScript で window.__E2E_SEED__ に置く初期状態。 */
export interface E2ESeed {
  /** パス → バイト列。 */
  files?: Record<string, number[]>;
  /** 次に「開く」ダイアログが返すパス（null はキャンセル）。 */
  openPath?: string | null;
  /** 次に「保存」ダイアログが返すパス（null はキャンセル）。 */
  savePath?: string | null;
  /** loadPreferences が返す値。 */
  preferences?: unknown;
  /** 次に「画像を選ぶ」ダイアログが返すパス（null はキャンセル）。画像のバイト列は files に置く。 */
  imagePath?: string | null;
  /** アプリのデータ領域にある草稿（前回の強制終了の後の状態を模す）。 */
  drafts?: Draft[];
  /** 前回の執筆環境（lastPath、lastFolder）。 */
  session?: SessionInfo;
  /**
   * 次に「フォルダを開く」ダイアログが返すパス（null はキャンセル）。
   * フォルダの構造は、files のパスから導く（/work/a/b.md があれば /work と /work/a がフォルダ）。
   */
  folderPath?: string | null;
  /** 中身のない（files のパスからは導けない）フォルダ。 */
  emptyFolders?: string[];
  /** フォルダへのシンボリックリンクとして見せるパス（展開しない印の確認用。中身はない）。 */
  symlinkFolders?: string[];
  /** 項目が大量にあるフォルダ。path の直下に、item-00001.md から count 件の（中身のない）ファイルがあるように見せる。 */
  bulkFolders?: Array<{ path: string; count: number }>;
  /** 読もうとすると権限エラー（permission-denied）になるフォルダ。 */
  unreadableFolders?: string[];
}

/** テストが window.__mdeE2E 経由で観測・操作するもの。 */
export interface E2EState {
  files: Map<string, Uint8Array>;
  /** bridge の save / saveAs などが呼ばれた回数（imageRead は readBackgroundImage）。 */
  calls: {
    save: number;
    saveAs: number;
    open: number;
    check: number;
    fullscreen: number;
    imageImport: number;
    imageRead: number;
    draftWrite: number;
    draftDelete: number;
    close: number;
    folderOpen: number;
    folderList: number;
  };
  /** 保存の直前の検査で、書かずに衝突を返した回数。 */
  conflicts: number;
  /** アプリのデータ領域の草稿（draftId → 草稿）。 */
  drafts: Map<string, Draft>;
  /** アプリのデータ領域のバックアップ（上書き前のディスクの内容）。 */
  backups: Array<{ path: string; bytes: Uint8Array }>;
  session: SessionInfo;
  /** openFolder で許可されたフォルダ（最後に開いたもの）。 */
  openedFolder: string | null;
  /** listFolder に渡されたパスの記録（遅延読み込みの確認用）。 */
  listed: string[];
  /** 監視している文書のパス（watchDocument の最後の引数）。 */
  watched: string | null;
  /** closeApp が呼ばれたか（アプリが終了したことの代わり）。 */
  closed: boolean;
  /** 全画面かどうか（toggleFullscreen が切り替える）。 */
  fullscreen: boolean;
  /** 取り込み済みの背景画像（imageId → 画像）。 */
  images: Map<string, BackgroundImageData>;
  imagePath: string | null;
  /** checkDocument の応答を遅らせる時間（ms）。操作の実行中に別の要求が届く状況を作るためのテスト用。 */
  checkDelayMs: number;
  /** 実際にバイト列を書き換えた回数（outcome が written のもの）。 */
  physicalWrites: number;
  /** save / saveAs の呼び出しごとの記録。 */
  log: Array<{ kind: 'save' | 'saveAs'; path: string; outcome: SaveOutcome }>;
  savedPreferences: unknown[];
  openPath: string | null;
  savePath: string | null;
  /** 次に「フォルダを開く」ダイアログが返すパス（null はキャンセル）。 */
  folderPath: string | null;
  readFile(path: string): number[] | null;
  /** 外部のプロセスによる書き換え。bytes が null ならファイルの削除。notify が true なら、監視の通知も届く。 */
  externalWrite(path: string, bytes: number[] | null, options?: { notify?: boolean }): void;
  /** 監視の通知だけを送る（ファイルは変えない）。 */
  emitDocumentChanged(path: string): void;
  /** 窓を閉じる操作（閉じるボタン、Cmd+Q）を模す。 */
  requestClose(): void;
  readDrafts(): Draft[];
  readBackups(): Array<{ path: string; bytes: number[] }>;
  /** Editor を直接操作するための入口（IME 中の setText 抑止の検証用）。 */
  editor: EditorAdapter | null;
}

declare global {
  interface Window {
    __E2E_SEED__?: E2ESeed;
    __mdeE2E?: E2EState;
  }
}


// ---- フォルダ（エクスプローラー）。crates の外の src-tauri/src/folders.rs と同じ規則（正本は Rust 側）。 ----

const folderCollator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

/** 末尾の区切りを除き、`.` と `..` を解決した絶対パス（仮想パスは常に / 区切り）。 */
function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

const isUnder = (path: string, root: string) => root === '/' || path === root || path.startsWith(`${root}/`);

function bulkName(index: number): string {
  return `item-${String(index + 1).padStart(5, '0')}.md`;
}

/** 前回の執筆環境。lastFolder は、同じタブでの再読み込みなら保存済みのもの、なければ seed。値があるときだけ項目を持つ。 */
function initialSession(seed: E2ESeed): SessionInfo {
  const saved = sessionStorage.getItem(FOLDER_KEY);
  const lastFolder = saved !== null ? (JSON.parse(saved) as string | null) : (seed.session?.lastFolder ?? null);
  return { lastPath: seed.session?.lastPath ?? null, ...(lastFolder !== null ? { lastFolder } : {}) };
}

export function createMemoryBridge(): DocumentBridge {
  const seed = window.__E2E_SEED__ ?? {};
  const known = new Set<string>();
  const changeListeners = new Set<(path: string) => void>();
  const closeListeners = new Set<() => void>();
  const state: E2EState = {
    files: new Map(Object.entries(seed.files ?? {}).map(([p, b]) => [p, Uint8Array.from(b)])),
    calls: {
      save: 0,
      saveAs: 0,
      open: 0,
      check: 0,
      fullscreen: 0,
      imageImport: 0,
      imageRead: 0,
      draftWrite: 0,
      draftDelete: 0,
      close: 0,
      folderOpen: 0,
      folderList: 0,
    },
    conflicts: 0,
    drafts: new Map((seed.drafts ?? []).map((d) => [d.draftId, structuredClone(d)])),
    backups: [],
    session: initialSession(seed),
    openedFolder: null,
    listed: [],
    watched: null,
    closed: false,
    fullscreen: false,
    images: new Map(),
    imagePath: seed.imagePath ?? null,
    checkDelayMs: 0,
    physicalWrites: 0,
    log: [],
    savedPreferences: [],
    openPath: seed.openPath ?? null,
    savePath: seed.savePath ?? null,
    folderPath: seed.folderPath ?? null,
    readFile: (path) => {
      const f = state.files.get(path);
      return f ? Array.from(f) : null;
    },
    externalWrite: (path, bytes, options) => {
      if (bytes === null) state.files.delete(path);
      else state.files.set(path, Uint8Array.from(bytes));
      if (options?.notify ?? true) state.emitDocumentChanged(path);
    },
    emitDocumentChanged: (path) => {
      if (state.watched === path) changeListeners.forEach((l) => l(path));
    },
    requestClose: () => closeListeners.forEach((l) => l()),
    readDrafts: () => Array.from(state.drafts.values(), (d) => structuredClone(d)),
    readBackups: () => state.backups.map((b) => ({ path: b.path, bytes: Array.from(b.bytes) })),
    editor: null,
  };
  window.__mdeE2E = state;

  const emptyFolders = (seed.emptyFolders ?? []).map(normalizePath);
  const symlinkFolders = (seed.symlinkFolders ?? []).map(normalizePath);
  const bulkFolders = (seed.bulkFolders ?? []).map((b) => ({ path: normalizePath(b.path), count: b.count }));
  const unreadableFolders = (seed.unreadableFolders ?? []).map(normalizePath);

  /** フォルダとして存在するか（files のパスの祖先、または seed で挙げたフォルダ）。 */
  function isFolder(path: string): boolean {
    if (path === '/') return true;
    const declared = [...emptyFolders, ...unreadableFolders, ...bulkFolders.map((b) => b.path)];
    if (declared.some((d) => isUnder(d, path))) return true;
    return Array.from(state.files.keys()).some((f) => f.startsWith(`${path}/`));
  }

  /** dir の直下の項目（隠しの除外と並べ替え、件数の上限の前）。 */
  function childrenOf(dir: string): FolderEntry[] {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const found = new Map<string, FolderEntryKind>();
    const add = (path: string, leaf: boolean) => {
      if (!path.startsWith(prefix)) return;
      const rest = path.slice(prefix.length);
      if (rest === '') return;
      const [name = ''] = rest.split('/');
      const isLeaf = leaf && !rest.includes('/');
      const full = `${prefix}${name}`;
      const kind: FolderEntryKind = symlinkFolders.includes(full) ? 'symlinkDir' : isLeaf ? 'file' : 'dir';
      if (!found.has(name) || kind === 'dir') found.set(name, kind);
    };
    for (const f of state.files.keys()) add(f, true);
    for (const d of [...emptyFolders, ...unreadableFolders, ...bulkFolders.map((b) => b.path)]) add(d, false);
    for (const l of symlinkFolders) add(l, false);
    for (const b of bulkFolders) {
      if (b.path !== dir) continue;
      for (let i = 0; i < b.count; i++) found.set(bulkName(i), 'file');
    }
    return Array.from(found, ([name, kind]) => ({ name, path: `${prefix}${name}`, kind }));
  }

  /** 実際にバイト列を書き換える。内容が同一なら書かない（unchanged）。 */
  function commit(kind: 'save' | 'saveAs', path: string, bytes: Uint8Array): SaveOutcome {
    const existing = state.files.get(path);
    let outcome: SaveOutcome = 'written';
    if (existing && sameBytes(existing, bytes)) {
      outcome = 'unchanged';
    } else {
      state.files.set(path, bytes);
      state.physicalWrites++;
    }
    state.log.push({ kind, path, outcome });
    return outcome;
  }

  async function diskStateOf(path: string): Promise<DiskState> {
    const bytes = state.files.get(path);
    return bytes ? { kind: 'present', revision: await sha256Hex(bytes) } : { kind: 'missing' };
  }

  return {
    async pickOpenPath() {
      return state.openPath;
    },
    async pickSavePath() {
      return state.savePath;
    },
    async openDocument(path: string): Promise<OpenedDocument> {
      state.calls.open++;
      const bytes = state.files.get(path);
      if (!bytes) throw new BridgeError('not-found', 'no such file');
      const { text, format } = decodeBytes(bytes);
      known.add(path);
      return { path, text, format, revision: await sha256Hex(bytes) };
    },
    // crates/docio の save_checked と同じ規則（正本は Rust 側）。
    async saveDocument(path, text, format, options: SaveOptions): Promise<SaveResult> {
      state.calls.save++;
      if (!known.has(path)) throw new BridgeError('not-allowed', 'not opened in this session');
      const bytes = encodeText(text, format);
      const existing = state.files.get(path);
      const current = await diskStateOf(path);
      const newRevision = await sha256Hex(bytes);
      const matches =
        current.kind === 'present' ? current.revision === options.expectedRevision : options.expectedRevision === null;
      const same = current.kind === 'present' && current.revision === newRevision;

      if (!matches && !same && !options.overwrite) {
        state.conflicts++;
        return { kind: 'conflict', disk: current };
      }
      let backup: string | null = null;
      if (!matches && !same && existing) {
        backup = `/app-data/backups/${basename(path)}.${state.backups.length + 1}.bak`;
        state.backups.push({ path: backup, bytes: existing.slice() });
      }
      const outcome = commit('save', path, bytes);
      return { kind: 'saved', outcome, revision: newRevision, backup };
    },
    async saveDocumentAs(path, text, format): Promise<SaveResult> {
      state.calls.saveAs++;
      const bytes = encodeText(text, format);
      const outcome = commit('saveAs', path, bytes);
      known.add(path);
      return { kind: 'saved', outcome, revision: await sha256Hex(bytes), backup: null };
    },
    async checkDocument(path) {
      state.calls.check++;
      if (state.checkDelayMs > 0) await new Promise((r) => setTimeout(r, state.checkDelayMs));
      if (!known.has(path)) throw new BridgeError('not-allowed', 'not opened in this session');
      return diskStateOf(path);
    },
    async watchDocument(path) {
      if (path !== null && !known.has(path)) throw new BridgeError('not-allowed', 'not opened in this session');
      state.watched = path;
    },
    async onDocumentChanged(cb) {
      changeListeners.add(cb);
      return () => changeListeners.delete(cb);
    },
    async writeDraft(draft) {
      state.calls.draftWrite++;
      state.drafts.set(draft.draftId, structuredClone(draft));
      return `memory://drafts/${draft.draftId}.json`;
    },
    async listDrafts() {
      return Array.from(state.drafts.values())
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ draftId, path, updatedAt }) => ({ draftId, path, updatedAt }));
    },
    async readDraft(draftId) {
      const d = state.drafts.get(draftId);
      return d ? structuredClone(d) : null;
    },
    async deleteDraft(draftId) {
      state.calls.draftDelete++;
      state.drafts.delete(draftId);
    },
    async loadSession() {
      return { ...state.session };
    },
    async saveSession(patch) {
      state.session = { ...state.session, ...patch };
      if ('lastFolder' in patch) sessionStorage.setItem(FOLDER_KEY, JSON.stringify(patch.lastFolder ?? null));
    },
    async pickFolderPath() {
      return state.folderPath;
    },
    async openFolder(path) {
      state.calls.folderOpen++;
      if (!path.startsWith('/')) throw new BridgeError('invalid-input', 'the path must be absolute');
      const folder = normalizePath(path);
      if (state.files.has(folder)) throw new BridgeError('invalid-input', 'the path is not a folder');
      if (!isFolder(folder)) throw new BridgeError('not-found', 'no such folder');
      if (unreadableFolders.includes(folder)) throw new BridgeError('permission-denied', 'permission denied');
      state.openedFolder = folder;
    },
    async listFolder(path): Promise<FolderListing> {
      state.calls.folderList++;
      state.listed.push(path);
      if (!path.startsWith('/')) throw new BridgeError('invalid-input', 'the path must be absolute');
      const folder = normalizePath(path);
      if (state.openedFolder === null || !isUnder(folder, state.openedFolder)) {
        throw new BridgeError('not-allowed', 'the folder was not opened in this session');
      }
      if (state.files.has(folder)) throw new BridgeError('invalid-input', 'the path is not a folder');
      if (symlinkFolders.includes(folder)) throw new BridgeError('not-allowed', 'a symbolic link to a folder is not followed');
      if (!isFolder(folder)) throw new BridgeError('not-found', 'no such folder');
      if (unreadableFolders.includes(folder)) throw new BridgeError('permission-denied', 'permission denied');
      const visible = childrenOf(folder)
        .filter((e) => !e.name.startsWith('.'))
        .sort((a, b) => {
          const dirs = Number(b.kind === 'dir' || b.kind === 'symlinkDir') - Number(a.kind === 'dir' || a.kind === 'symlinkDir');
          return dirs || folderCollator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1);
        });
      return { entries: visible.slice(0, FOLDER_LISTING_LIMIT), total: visible.length };
    },
    async onCloseRequested(cb) {
      closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    },
    async closeApp() {
      state.calls.close++;
      state.closed = true;
    },
    async loadPreferences() {
      // 保存済み（同じタブでの再読み込み）があればそれ、なければ seed。
      const saved = sessionStorage.getItem(PREFS_KEY);
      return saved !== null ? JSON.parse(saved) : (seed.preferences ?? null);
    },
    async savePreferences(prefs) {
      state.savedPreferences.push(prefs);
      sessionStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    },
    async pickImagePath() {
      return state.imagePath;
    },
    async importBackgroundImage(path) {
      state.calls.imageImport++;
      const bytes = state.files.get(path);
      if (!bytes) throw new BridgeError('not-found', 'no such file');
      if (bytes.length > MAX_IMAGE_BYTES) throw new BridgeError('invalid-input', 'the image is too large');
      const mime = sniffImageMime(bytes);
      if (!mime) throw new BridgeError('invalid-input', 'unsupported image format');
      const id = await sha256Hex(bytes);
      state.images.set(id, { mime, bytes: bytes.slice() });
      return id;
    },
    async readBackgroundImage(imageId) {
      state.calls.imageRead++;
      const image = state.images.get(imageId);
      if (!image) throw new BridgeError('not-found', 'no such image');
      return image;
    },
    async toggleFullscreen() {
      state.calls.fullscreen++;
      state.fullscreen = !state.fullscreen;
      return state.fullscreen;
    },
    async notifyReady() {
      document.documentElement.dataset.ready = 'true';
    },
  };
}
