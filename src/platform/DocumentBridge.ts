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

/** 取り込み済みの背景画像。 */
export interface BackgroundImageData {
  /** image/png・image/jpeg・image/webp のいずれか。 */
  readonly mime: string;
  readonly bytes: Uint8Array;
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
  /** 背景画像を選ぶダイアログ（png / jpeg / webp）。キャンセルは null。 */
  pickImagePath(): Promise<string | null>;
  /**
   * 選んだ画像をアプリのデータ領域へコピーし、imageId（内容のハッシュ）を返す。元ファイルは参照しない。
   * 形式（先頭バイトで判定）・大きさ（20 MiB）に合わなければ BridgeError('invalid-input')。
   */
  importBackgroundImage(path: string): Promise<string>;
  /** 取り込み済みの画像を読む。なければ BridgeError('not-found')。 */
  readBackgroundImage(imageId: string): Promise<BackgroundImageData>;
  /** 全画面を切り替え、切替後の状態（true なら全画面）を返す。 */
  toggleFullscreen(): Promise<boolean>;
  /** 最初の描画が済んだことをネイティブ側へ知らせる（窓の表示）。 */
  notifyReady(): Promise<void>;
}
