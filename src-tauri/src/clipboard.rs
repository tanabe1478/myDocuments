//! クリップボードへの書き込み（ADR-005 の R6）。書き込みだけで、読む口は持たない。
//!
//! 部品（隔離した操作の段）は、ここを直接は呼べない。本体が、部品の権限（`clipboard.write`）を確かめてから、
//! 自前のコマンド `write_clipboard_text` を呼ぶ。tauri-plugin-clipboard-manager は Rust の API（`ClipboardExt`）だけを使い、
//! JavaScript 向けのコマンドは capabilities に入れない（`opener` と同じ作り）。
//!
//! 検査（`validate`）と書き込み（`write_with`）を分けてあり、単体テストは、検査と、差し替えた書き込み関数だけを呼ぶ
//! （本物のクリップボードには書かない）。隔離の検証用のビルド（feature `isolation-probe`）は、書き込みを記録に差し替える。

use crate::error::{CommandError, ErrorKind};

/// 1 回に書ける文字数の上限（Unicode のスカラー値の数）。フロントエンド（src/plugin-host/protocol.ts の clipboardTextLength）と同じ値。
pub const MAX_CHARS: usize = 100_000;

/// 書いてよい文字列か検査する。空と、長すぎるものは InvalidInput。メッセージに文字列そのものは含めない。
pub fn validate(text: &str) -> Result<(), CommandError> {
    if text.is_empty() {
        return Err(CommandError::new(ErrorKind::InvalidInput, "the text is empty"));
    }
    if text.chars().count() > MAX_CHARS {
        return Err(CommandError::new(ErrorKind::InvalidInput, "the text is too long"));
    }
    Ok(())
}

/// 検査を通った文字列だけを、渡された書き込み関数に渡す。
pub fn write_with<F>(text: &str, writer: F) -> Result<(), CommandError>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    validate(text)?;
    writer(text).map_err(|e| CommandError::new(ErrorKind::Io, e))
}

/// OS のクリップボードに書く。
#[cfg(not(feature = "isolation-probe"))]
pub fn write(app: &tauri::AppHandle, text: &str) -> Result<(), CommandError> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    write_with(text, |t| app.clipboard().write_text(t.to_owned()).map_err(|e| e.to_string()))
}

/// 隔離の検証用のビルドでは、OS のクリップボードには書かず、記録（probe.rs）に書く（利用者のクリップボードを上書きしない）。
#[cfg(feature = "isolation-probe")]
pub fn write(_app: &tauri::AppHandle, text: &str) -> Result<(), CommandError> {
    write_with(text, |t| {
        crate::probe::record_clipboard(t);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn rejects_an_empty_string_and_never_calls_the_writer() {
        let called = RefCell::new(false);
        let err = write_with("", |_| {
            *called.borrow_mut() = true;
            Ok(())
        })
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidInput);
        assert!(!*called.borrow());
    }

    #[test]
    fn the_limit_counts_characters_not_bytes() {
        // 3 バイトの文字を上限ちょうど並べても通る（バイト数では 300,000）。
        let at_limit = "あ".repeat(MAX_CHARS);
        assert!(validate(&at_limit).is_ok());
        let over = "あ".repeat(MAX_CHARS + 1);
        assert_eq!(validate(&over).unwrap_err().kind, ErrorKind::InvalidInput);
        // 1 文字目と最後の 1 文字の境界。
        assert!(validate("a").is_ok());
        assert!(validate(&"a".repeat(MAX_CHARS)).is_ok());
        assert!(validate(&"a".repeat(MAX_CHARS + 1)).is_err());
    }

    #[test]
    fn the_error_message_does_not_contain_the_text() {
        let secret = "secret-".repeat(MAX_CHARS);
        let err = validate(&secret).unwrap_err();
        assert!(!err.message.contains("secret"));
    }

    #[test]
    fn passes_a_valid_text_to_the_writer_unchanged() {
        let written = RefCell::new(String::new());
        write_with("/Users/a/メモ.md", |t| {
            written.borrow_mut().push_str(t);
            Ok(())
        })
        .unwrap();
        assert_eq!(written.into_inner(), "/Users/a/メモ.md");
    }

    #[test]
    fn a_failing_writer_becomes_an_io_error() {
        let err = write_with("x", |_| Err("clipboard unavailable".to_string())).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Io);
    }
}
