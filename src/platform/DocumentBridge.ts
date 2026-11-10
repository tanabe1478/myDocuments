import type { DocumentFormat } from '../document/format';
import type { LogEntry } from '../logging/types';
import type { PluginPermissionsFile } from '../plugin-api';
import type { Preferences } from '../preferences/preferences';

export interface OpenedDocument {
  readonly path: string;
  /** 改行は LF に正規化済み。BOM は含まない。 */
  readonly text: string;
  readonly format: DocumentFormat;
  /** 読み込んだバイト列の SHA-256（16 進）。保存時の外部変更の検出に使う。 */
  readonly revision: string;
}

/** written: 書き込んだ。unchanged: 既存ファイルと同一のバイト列だったので書かなかった。 */
export type SaveOutcome = 'written' | 'unchanged';

/** ディスク上のファイルの現在の状態。 */
export type DiskState = { readonly kind: 'present'; readonly revision: string } | { readonly kind: 'missing' };

/**
 * 保存の結果。衝突（ディスクの内容が最後に見たものと違う）は、書かなかった正常な結果として返す。
 * saved.backup は、上書き前のディスクの内容を退避した先（退避しなかったときは null）。
 */
export type SaveResult =
  | { readonly kind: 'saved'; readonly outcome: SaveOutcome; readonly revision: string; readonly backup: string | null }
  | { readonly kind: 'conflict'; readonly disk: DiskState };

export interface SaveOptions {
  /** この文書が最後に見たディスクの revision。ファイルがない前提なら null。 */
  readonly expectedRevision: string | null;
  /** true なら、衝突していても上書きする（現在のディスクの内容を先にバックアップする）。 */
  readonly overwrite: boolean;
}

/** クラッシュ復旧用の草稿。文書ごとに 1 つ。 */
export interface Draft {
  /** 文書ごとの UUID。 */
  readonly draftId: string;
  /** 元の文書のパス。保存先のない新規文書は null。 */
  readonly path: string | null;
  /** 編集中の本文（LF 正規化済み）。 */
  readonly text: string;
  readonly format: DocumentFormat;
  /** 草稿の元になったディスクの revision。保存先のない文書は null。 */
  readonly baseRevision: string | null;
  /** 最後に書いた時刻（UNIX ミリ秒）。 */
  readonly updatedAt: number;
}

/** 復旧の確認に出すための草稿の要約（本文は含まない）。 */
export interface DraftSummary {
  readonly draftId: string;
  readonly path: string | null;
  readonly updatedAt: number;
}

/** 前回の執筆環境。 */
export interface SessionInfo {
  /** 前回開いていた文書の絶対パス。 */
  readonly lastPath: string | null;
  /** 前回エクスプローラーに開いていたフォルダの絶対パス。古い session.json には無い（ネイティブ側は null として返す）。 */
  readonly lastFolder?: string | null;
}

/**
 * フォルダの項目の種類。file: ファイル（ファイルへのシンボリックリンクを含む）。dir: フォルダ。
 * symlinkDir: フォルダへのシンボリックリンク（ループを避けるため、展開しない）。other: それ以外（壊れたリンクなど）。
 */
export type FolderEntryKind = 'file' | 'dir' | 'symlinkDir' | 'other';

export interface FolderEntry {
  readonly name: string;
  /** 絶対パス（listFolder に渡したパスに name を足したもの）。 */
  readonly path: string;
  readonly kind: FolderEntryKind;
}

/** フォルダの中身。隠し項目（名前がドットで始まるもの）は含まない。 */
export interface FolderListing {
  /** 並べ替えた後の先頭から、最大 FOLDER_LISTING_LIMIT 件。フォルダが先、その中は名前の自然順。 */
  readonly entries: readonly FolderEntry[];
  /** 隠し項目を除いた全件数。entries より多ければ、末尾が切り捨てられている。 */
  readonly total: number;
}

/** 1 つのフォルダについて返す項目の上限（ネイティブ側もこの値）。 */
export const FOLDER_LISTING_LIMIT = 5000;

export type BridgeErrorKind =
  | 'not-found'
  | 'permission-denied'
  | 'not-utf8'
  | 'not-allowed'
  | 'invalid-input'
  /** 作成・名前の変更の先に、すでに同じ名前の項目がある（上書きしない）。 */
  | 'already-exists'
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
  /**
   * 既に開いた（または保存先に選んだ）パスへの保存。
   * 書く直前にディスクの内容を確かめ、expectedRevision と違えば書かずに conflict を返す。
   */
  saveDocument(path: string, text: string, format: DocumentFormat, options: SaveOptions): Promise<SaveResult>;
  /** ダイアログで選んだパスへの保存（上書きの確認は OS のダイアログが済ませている）。 */
  saveDocumentAs(path: string, text: string, format: DocumentFormat): Promise<SaveResult>;
  /** 開いた（または保存先に選んだ）パスの、いまのディスクの状態。 */
  checkDocument(path: string): Promise<DiskState>;
  /** 外部変更の監視の対象を切り替える。null なら監視をやめる。 */
  watchDocument(path: string | null): Promise<void>;
  /** 監視中の文書に外部変更があったかもしれない、という通知を購読する。解除関数を返す。 */
  onDocumentChanged(cb: (path: string) => void): Promise<() => void>;
  /** 草稿を書く。戻り値は保存先（ユーザーに退避先として伝える用）。 */
  writeDraft(draft: Draft): Promise<string>;
  /** 草稿の一覧（新しい順）。 */
  listDrafts(): Promise<DraftSummary[]>;
  /** 草稿を読む。なければ null。 */
  readDraft(draftId: string): Promise<Draft | null>;
  /** 草稿を消す。なくてもエラーにしない。 */
  deleteDraft(draftId: string): Promise<void>;
  loadSession(): Promise<SessionInfo>;
  /** 渡した項目だけを更新し、渡さなかった項目は保つ（文書とフォルダが、互いの記録を消さないように）。 */
  saveSession(patch: Partial<SessionInfo>): Promise<void>;
  /** フォルダを選ぶダイアログ。キャンセルは null。 */
  pickFolderPath(): Promise<string | null>;
  /**
   * フォルダを開く（エクスプローラーのルートにする）。存在するフォルダでなければ BridgeError
   * （not-found、invalid-input、permission-denied）。成功すると、そのフォルダとその配下を listFolder で読めるようになる。
   */
  openFolder(path: string): Promise<void>;
  /** 開いたフォルダ（またはその配下）の中身。それ以外のパスは BridgeError('not-allowed')。 */
  listFolder(path: string): Promise<FolderListing>;
  /**
   * 開いたフォルダの配下に、空のファイルを作る。戻り値は新しいパス。名前は 1 つのパス成分だけ。
   * すでに同じ名前の項目があれば BridgeError('already-exists')（上書きしない）。登録外のフォルダは 'not-allowed'、不正な名前は 'invalid-input'。
   */
  createFile(parent: string, name: string): Promise<string>;
  /** createFile のフォルダ版。 */
  createFolder(parent: string, name: string): Promise<string>;
  /**
   * 項目（ファイル・フォルダ。リンクはリンク自体）の名前を、同じフォルダの中で変える。戻り値は新しいパス。
   * 既存の別の項目は上書きしない（'already-exists'）。大文字小文字だけの変更は通る。開いたフォルダ自身は 'not-allowed'。
   * 名前を変えた項目が開いた文書（またはそれを含むフォルダ）なら、新しいパスも保存・監視できるようになる。
   */
  renameEntry(path: string, newName: string): Promise<string>;
  /** 項目（リンクはリンク自体）をゴミ箱へ移す。開いたフォルダ自身は 'not-allowed'。 */
  trashEntry(path: string): Promise<void>;
  /**
   * 見せているフォルダ（ルートと展開中のフォルダ。開いたフォルダの配下）の監視を、渡したものに切り替える（空なら止める）。
   * それぞれの直下の項目の増減・名前の変更を、onFolderChanged で知らせる（深いフォルダは、渡したときだけ）。
   */
  watchFolders(paths: readonly string[]): Promise<void>;
  /** 監視中のフォルダの項目が増減・名前の変更をされた、という通知を購読する。解除関数を返す。 */
  onFolderChanged(cb: (path: string) => void): Promise<() => void>;
  /** 窓を閉じる・アプリを終了する操作があったことの通知を購読する。解除関数を返す。 */
  onCloseRequested(cb: () => void): Promise<() => void>;
  /** 終了の確認が済んだ後に、アプリを終了する。 */
  closeApp(): Promise<void>;
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
  /**
   * リンクを既定のブラウザで開く。http / https でホストのある URL だけ。それ以外は BridgeError('invalid-input')。
   * ネイティブ側でも必ず検査する（呼び出し側の検査に頼らない）。
   */
  openExternalUrl(url: string): Promise<void>;
  /**
   * クリップボードに文字列を書く（書くだけ。読む口はない）。部品の権限（clipboard.write）は、呼ぶ前に本体が確かめる。
   * 空と、100,000 文字を超える文字列は、ネイティブ側でも BridgeError('invalid-input')（呼び出し側の検査に頼らない）。
   */
  writeClipboardText(text: string): Promise<void>;
  /** 部品の権限の、利用者の決定（設定とは別のファイル）。ないとき、壊れているときは、決定のない空の値。 */
  loadPluginPermissions(): Promise<PluginPermissionsFile>;
  /** 部品の権限の決定を保存する（ネイティブ側が、形と大きさを検査する）。 */
  savePluginPermissions(permissions: PluginPermissionsFile): Promise<void>;
  /**
   * アプリのログを記録するかを、ネイティブ側へ伝える（設定「ログを記録する」。既定はオフ）。無効から有効に変わったとき、ネイティブ側が起動の情報を 1 行書く。
   * ログの本体は src/logging/。ここは入口だけ。
   */
  setLogging(enabled: boolean): Promise<void>;
  /**
   * ログの行を、ネイティブ側の app.log へ追記する（有効の間だけ。無効の間、ネイティブ側は何も書かずに成功を返す）。時刻はネイティブ側が付ける。
   * 1 回に 100 件まで。形の合わない項目は、ネイティブ側が捨てる。書けなくても、失敗にしない。
   */
  appendLog(entries: readonly LogEntry[]): Promise<void>;
  /** 全画面を切り替え、切替後の状態（true なら全画面）を返す。 */
  toggleFullscreen(): Promise<boolean>;
  /** 最初の描画が済んだことをネイティブ側へ知らせる（窓の表示）。 */
  notifyReady(): Promise<void>;
}
