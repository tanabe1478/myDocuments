//! 文書の入出力（Tauri 非依存。依存は revision の SHA-256 だけ）。
//!
//! 方針（docs/decision-001-base-project.md の Consequences）:
//! - 読み込み時に BOM と改行コードを記録し、本文は LF に正規化して編集する。
//! - 保存時に記録した BOM と改行コードを復元する。
//! - 混在改行は多数派に揃える（同数なら LF）。`mixed_eol` で呼び出し側に知らせる。
//! - 孤立した CR（CRLF の一部でない CR）は改行として扱わず、本文の文字として保つ。
//! - UTF-8 でないバイト列は開かない（文字化けさせない）。
//! - revision（ディスク上のバイト列の SHA-256）で外部変更を検出し、競合時は書かない（FS-04）。
//!   上書きを選んだときは、現在の内容を退避してから書く（FS-07）。

mod backup;
mod checked;
mod format;
mod revision;
mod save;

pub use backup::{backup_bytes, prune, BackupLimits, DEFAULT_BACKUP_LIMITS};
pub use checked::{check, save_checked, CheckedSave};
pub use format::{decode, encode, DecodeError, Decoded, DocumentFormat, Eol};
pub use revision::{disk_state, revision_of, DiskState};
pub use save::{save_atomic, SaveOutcome};
