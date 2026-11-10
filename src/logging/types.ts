/** ログの重さ。Rust 側（src-tauri/src/logging.rs）が受け取る 3 つ。 */
export type LogLevel = 'info' | 'warn' | 'error';

/** data の値。数値、真偽値、null、文字列だけ（Rust 側も同じ。ほかは捨てられる）。undefined の項目は書かない。 */
export type LogValue = string | number | boolean | null;
export type LogData = { readonly [key: string]: LogValue | undefined };

/**
 * ブリッジ（appendLog）へ渡す 1 件。時刻は Rust が付ける。
 * source と event と data のキーは [a-z0-9._-] の 1〜64 文字（合わないものは、ロガーが捨てる）。
 */
export interface LogEntry {
  readonly level: LogLevel;
  readonly source: string;
  readonly event: string;
  readonly data: Readonly<Record<string, LogValue>>;
}

/** 記録の口。部品（同梱の段 3）にも、この形で貸す（src/plugin-api/ の PluginLog は、source を固定した同じ形）。 */
export type LogFn = (level: LogLevel, source: string, event: string, data?: LogData) => void;
