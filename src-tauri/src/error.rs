use serde::Serialize;
use std::io;

/// フロントエンドへ返すエラー。`kind` で分類し、`message` は診断用（パスは含めない）。
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CommandError {
    pub kind: ErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    NotFound,
    PermissionDenied,
    /// UTF-8 でないファイル。開かない。
    NotUtf8,
    /// このセッションで開いた・保存先に選んだことのないパスへの保存要求。
    NotAllowed,
    InvalidInput,
    Io,
}

impl CommandError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        CommandError {
            kind,
            message: message.into(),
        }
    }
}

impl From<io::Error> for CommandError {
    fn from(e: io::Error) -> Self {
        let kind = match e.kind() {
            io::ErrorKind::NotFound => ErrorKind::NotFound,
            io::ErrorKind::PermissionDenied => ErrorKind::PermissionDenied,
            io::ErrorKind::InvalidInput => ErrorKind::InvalidInput,
            _ => ErrorKind::Io,
        };
        CommandError::new(kind, e.to_string())
    }
}

impl From<docio::DecodeError> for CommandError {
    fn from(e: docio::DecodeError) -> Self {
        CommandError::new(ErrorKind::NotUtf8, e.to_string())
    }
}
