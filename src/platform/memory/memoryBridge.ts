// e2e 専用のメモリ実装。VITE_E2E=1 のビルドにだけ含まれる（src/platform/index.ts の __E2E__）。
import type { DocumentFormat } from '../../document/format';
import type { EditorAdapter } from '../../editor/EditorAdapter';
import {
  BridgeError,
  type BackgroundImageData,
  type DocumentBridge,
  type OpenedDocument,
  type SaveOutcome,
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
}

/** テストが window.__mdeE2E 経由で観測・操作するもの。 */
export interface E2EState {
  files: Map<string, Uint8Array>;
  /** bridge の save / saveAs が呼ばれた回数。 */
  calls: { save: number; saveAs: number; open: number; fullscreen: number; imageImport: number };
  /** 全画面かどうか（toggleFullscreen が切り替える）。 */
  fullscreen: boolean;
  /** 取り込み済みの背景画像（imageId → 画像）。 */
  images: Map<string, BackgroundImageData>;
  imagePath: string | null;
  /** 実際にバイト列を書き換えた回数（outcome が written のもの）。 */
  physicalWrites: number;
  /** save / saveAs の呼び出しごとの記録。 */
  log: Array<{ kind: 'save' | 'saveAs'; path: string; outcome: SaveOutcome }>;
  savedPreferences: unknown[];
  openPath: string | null;
  savePath: string | null;
  readFile(path: string): number[] | null;
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
  const state: E2EState = {
    files: new Map(Object.entries(seed.files ?? {}).map(([p, b]) => [p, Uint8Array.from(b)])),
    calls: { save: 0, saveAs: 0, open: 0, fullscreen: 0, imageImport: 0 },
    fullscreen: false,
    images: new Map(),
    imagePath: seed.imagePath ?? null,
    physicalWrites: 0,
    log: [],
    savedPreferences: [],
    openPath: seed.openPath ?? null,
    savePath: seed.savePath ?? null,
    readFile: (path) => {
      const f = state.files.get(path);
      return f ? Array.from(f) : null;
    },
    editor: null,
  };
  window.__mdeE2E = state;

  function write(kind: 'save' | 'saveAs', path: string, text: string, format: DocumentFormat): SaveOutcome {
    const bytes = encodeText(text, format);
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
      return { path, text, format };
    },
    async saveDocument(path, text, format) {
      state.calls.save++;
      if (!known.has(path)) throw new BridgeError('not-allowed', 'not opened in this session');
      return write('save', path, text, format);
    },
    async saveDocumentAs(path, text, format) {
      state.calls.saveAs++;
      const outcome = write('saveAs', path, text, format);
      known.add(path);
      return outcome;
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
