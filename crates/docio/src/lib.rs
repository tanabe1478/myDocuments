//! 文書の入出力（標準ライブラリのみ、Tauri 非依存）。
//!
//! 方針（docs/decision-001-base-project.md の Consequences）:
//! - 読み込み時に BOM と改行コードを記録し、本文は LF に正規化して編集する。
//! - 保存時に記録した BOM と改行コードを復元する。
//! - 混在改行は多数派に揃える（同数なら LF）。`mixed_eol` で呼び出し側に知らせる。
//! - 孤立した CR（CRLF の一部でない CR）は改行として扱わず、本文の文字として保つ。
//! - UTF-8 でないバイト列は開かない（文字化けさせない）。

mod format;
mod save;

pub use format::{decode, encode, DecodeError, Decoded, DocumentFormat, Eol};
pub use save::{save_atomic, SaveOutcome};
