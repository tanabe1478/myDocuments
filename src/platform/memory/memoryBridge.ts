// e2e 専用のメモリ実装。VITE_E2E=1 のビルドにだけ含まれる（src/platform/index.ts の __E2E__）。
import type { DocumentFormat } from '../../document/format';
import type { EditorAdapter } from '../../editor/EditorAdapter';
import {
  BridgeError,
  type DocumentBridge,
  type OpenedDocument,
  type SaveOutcome,
} from '../DocumentBridge';
import { decodeBytes, encodeText, sameBytes } from './bytes';

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
}

/** テストが window.__mdeE2E 経由で観測・操作するもの。 */
export interface E2EState {
  files: Map<string, Uint8Array>;
  /** bridge の save / saveAs が呼ばれた回数。 */
  calls: { save: number; saveAs: number; open: number };
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
    calls: { save: 0, saveAs: 0, open: 0 },
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
      return seed.preferences ?? null;
    },
    async savePreferences(prefs) {
      state.savedPreferences.push(prefs);
    },
    async notifyReady() {
      document.documentElement.dataset.ready = 'true';
    },
  };
}
