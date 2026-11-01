// e2e 専用のメモリ実装。VITE_E2E=1 のビルドにだけ含まれる（src/platform/index.ts の __E2E__）。
import type { EditorAdapter } from '../../editor/EditorAdapter';
import { basename } from '../../document/state';
import {
  BridgeError,
  type BackgroundImageData,
  type DiskState,
  type DocumentBridge,
  type Draft,
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
  /** 前回の執筆環境。 */
  session?: SessionInfo;
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
  };
  /** 保存の直前の検査で、書かずに衝突を返した回数。 */
  conflicts: number;
  /** アプリのデータ領域の草稿（draftId → 草稿）。 */
  drafts: Map<string, Draft>;
  /** アプリのデータ領域のバックアップ（上書き前のディスクの内容）。 */
  backups: Array<{ path: string; bytes: Uint8Array }>;
  session: SessionInfo;
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
    },
    conflicts: 0,
    drafts: new Map((seed.drafts ?? []).map((d) => [d.draftId, structuredClone(d)])),
    backups: [],
    session: { lastPath: seed.session?.lastPath ?? null },
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
    async saveSession(session) {
      state.session = { ...session };
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
