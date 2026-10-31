import type { DocumentFormat } from '../document/format';
import type { Preferences } from '../preferences/preferences';

export interface OpenedDocument {
  readonly path: string;
  /** 改行は LF に正規化済み。BOM は含まない。 */
  readonly text: string;
  readonly format: DocumentFormat;
}

/** written: 書き込んだ。unchanged: 既存ファイルと同一のバイト列だったので書かなかった。 */
export type SaveOutcome = 'written' | 'unchanged';

export type BridgeErrorKind =
  | 'not-found'
  | 'permission-denied'
  | 'not-utf8'
  | 'not-allowed'
  | 'invalid-input'
  | 'io';

export class BridgeError extends Error {
  constructor(
    readonly kind: BridgeErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/**
 * Web UI からネイティブ側（ファイル、ダイアログ、設定）への唯一の入口。
 * Tauri への依存はこの interface の実装（tauriBridge.ts）に閉じ込める。
 */
export interface DocumentBridge {
  /** ファイルを開くダイアログ。キャンセルは null。 */
  pickOpenPath(): Promise<string | null>;
  /** 名前を付けて保存するダイアログ。キャンセルは null。 */
  pickSavePath(suggestedName: string): Promise<string | null>;
  openDocument(path: string): Promise<OpenedDocument>;
  /** 既に開いた（または保存先に選んだ）パスへの保存。 */
  saveDocument(path: string, text: string, format: DocumentFormat): Promise<SaveOutcome>;
  /** ダイアログで選んだパスへの保存。 */
  saveDocumentAs(path: string, text: string, format: DocumentFormat): Promise<SaveOutcome>;
  /** 保存済みの Preferences（未検証の JSON）。なければ null。 */
  loadPreferences(): Promise<unknown>;
  savePreferences(prefs: Preferences): Promise<void>;
  /** 最初の描画が済んだことをネイティブ側へ知らせる（窓の表示）。 */
  notifyReady(): Promise<void>;
}
