//! 文書の入出力（open / save）。Tauri に依存しない部分。docio の薄いラッパー。

use crate::error::{CommandError, ErrorKind};
use docio::{DocumentFormat, Eol, SaveOutcome};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EolDto {
    Lf,
    Crlf,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FormatDto {
    pub bom: bool,
    pub eol: EolDto,
    pub mixed_eol: bool,
}

impl From<DocumentFormat> for FormatDto {
    fn from(f: DocumentFormat) -> Self {
        FormatDto {
            bom: f.bom,
            eol: match f.eol {
                Eol::Lf => EolDto::Lf,
                Eol::Crlf => EolDto::Crlf,
            },
            mixed_eol: f.mixed_eol,
        }
    }
}

impl From<FormatDto> for DocumentFormat {
    fn from(f: FormatDto) -> Self {
        DocumentFormat {
            bom: f.bom,
            eol: match f.eol {
                EolDto::Lf => Eol::Lf,
                EolDto::Crlf => Eol::Crlf,
            },
            mixed_eol: f.mixed_eol,
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub path: String,
    /// 改行は LF に正規化済み。BOM は含まない。
    pub text: String,
    pub format: FormatDto,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SaveOutcomeDto {
    Written,
    Unchanged,
}

impl From<SaveOutcome> for SaveOutcomeDto {
    fn from(o: SaveOutcome) -> Self {
        match o {
            SaveOutcome::Written => SaveOutcomeDto::Written,
            SaveOutcome::Unchanged => SaveOutcomeDto::Unchanged,
        }
    }
}

/// このセッションで、開いた・保存先として選ばれたパス。
/// `save_document` は、ここに登録済みのパスにしか書かない。
/// 任意のパスへ書けるのは `save_document_as`（OS の保存ダイアログの結果を渡す経路）だけ。
#[derive(Default)]
pub struct KnownPaths(Mutex<HashSet<PathBuf>>);

impl KnownPaths {
    pub fn register(&self, path: &Path) {
        if let Ok(mut set) = self.0.lock() {
            set.insert(path.to_path_buf());
        }
    }

    pub fn contains(&self, path: &Path) -> bool {
        self.0.lock().map(|s| s.contains(path)).unwrap_or(false)
    }
}

/// 絶対パスだけを受け付ける。
pub fn validate_path(path: &str) -> Result<PathBuf, CommandError> {
    if path.is_empty() || path.contains('\0') {
        return Err(CommandError::new(ErrorKind::InvalidInput, "invalid path"));
    }
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(CommandError::new(
            ErrorKind::InvalidInput,
            "the path must be absolute",
        ));
    }
    Ok(p)
}

pub fn open(path: &str, known: &KnownPaths) -> Result<OpenedDocument, CommandError> {
    let p = validate_path(path)?;
    let bytes = std::fs::read(&p)?;
    let decoded = docio::decode(&bytes)?;
    known.register(&p);
    Ok(OpenedDocument {
        path: path.to_string(),
        text: decoded.text,
        format: decoded.format.into(),
    })
}

pub fn save(
    path: &str,
    text: &str,
    format: FormatDto,
    known: &KnownPaths,
) -> Result<SaveOutcomeDto, CommandError> {
    let p = validate_path(path)?;
    if !known.contains(&p) {
        return Err(CommandError::new(
            ErrorKind::NotAllowed,
            "the path was not opened or chosen in this session",
        ));
    }
    write(&p, text, format)
}

pub fn save_as(
    path: &str,
    text: &str,
    format: FormatDto,
    known: &KnownPaths,
) -> Result<SaveOutcomeDto, CommandError> {
    let p = validate_path(path)?;
    let outcome = write(&p, text, format)?;
    known.register(&p);
    Ok(outcome)
}

fn write(path: &Path, text: &str, format: FormatDto) -> Result<SaveOutcomeDto, CommandError> {
    let bytes = docio::encode(text, &format.into());
    Ok(docio::save_atomic(path, &bytes)?.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let d = std::env::temp_dir().join(format!(
                "ime-docs-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&d).unwrap();
            TempDir(d)
        }
        fn file(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const CRLF_BOM: &[u8] = b"\xEF\xBB\xBFa\r\nb\r\n";

    #[test]
    fn open_returns_lf_text_and_format() {
        let dir = TempDir::new();
        let path = dir.file("a.md");
        fs::write(&path, CRLF_BOM).unwrap();
        let known = KnownPaths::default();

        let doc = open(&path, &known).unwrap();

        assert_eq!(doc.text, "a\nb\n");
        assert_eq!(
            doc.format,
            FormatDto {
                bom: true,
                eol: EolDto::Crlf,
                mixed_eol: false
            }
        );
    }

    #[test]
    fn open_rejects_non_utf8() {
        let dir = TempDir::new();
        let path = dir.file("sjis.md");
        fs::write(&path, [0x82, 0xA0]).unwrap();
        let err = open(&path, &KnownPaths::default()).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotUtf8);
    }

    #[test]
    fn open_missing_file_is_not_found() {
        let dir = TempDir::new();
        let err = open(&dir.file("none.md"), &KnownPaths::default()).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);
    }

    #[test]
    fn relative_and_empty_paths_are_rejected() {
        let known = KnownPaths::default();
        assert_eq!(
            open("a.md", &known).unwrap_err().kind,
            ErrorKind::InvalidInput
        );
        assert_eq!(open("", &known).unwrap_err().kind, ErrorKind::InvalidInput);
    }

    #[test]
    fn save_requires_a_known_path() {
        let dir = TempDir::new();
        let path = dir.file("a.md");
        fs::write(&path, b"x").unwrap();
        let fmt = FormatDto {
            bom: false,
            eol: EolDto::Lf,
            mixed_eol: false,
        };
        let known = KnownPaths::default();

        let err = save(&path, "y", fmt, &known).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotAllowed);
        assert_eq!(fs::read(&path).unwrap(), b"x");

        open(&path, &known).unwrap();
        assert_eq!(
            save(&path, "y", fmt, &known).unwrap(),
            SaveOutcomeDto::Written
        );
        assert_eq!(fs::read(&path).unwrap(), b"y");
    }

    #[test]
    fn open_then_save_unmodified_keeps_bytes_and_modified_save_keeps_format() {
        let dir = TempDir::new();
        let path = dir.file("a.md");
        fs::write(&path, CRLF_BOM).unwrap();
        let known = KnownPaths::default();
        let doc = open(&path, &known).unwrap();

        let outcome = save(&path, &doc.text, doc.format, &known).unwrap();
        assert_eq!(outcome, SaveOutcomeDto::Unchanged);
        assert_eq!(fs::read(&path).unwrap(), CRLF_BOM);

        let outcome = save(&path, "a\nbX\n", doc.format, &known).unwrap();
        assert_eq!(outcome, SaveOutcomeDto::Written);
        assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBFa\r\nbX\r\n");
    }

    #[test]
    fn save_as_creates_a_file_and_registers_the_path() {
        let dir = TempDir::new();
        let path = dir.file("new.md");
        let known = KnownPaths::default();
        let fmt = FormatDto {
            bom: false,
            eol: EolDto::Crlf,
            mixed_eol: true,
        };

        assert_eq!(
            save_as(&path, "a\nb", fmt, &known).unwrap(),
            SaveOutcomeDto::Written
        );
        assert_eq!(fs::read(&path).unwrap(), b"a\r\nb");
        // 以降は通常の保存ができる。
        assert_eq!(
            save(&path, "a\nc", fmt, &known).unwrap(),
            SaveOutcomeDto::Written
        );
    }

    #[test]
    fn format_dto_json_shape() {
        let json = serde_json::to_value(FormatDto {
            bom: true,
            eol: EolDto::Crlf,
            mixed_eol: false,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "bom": true, "eol": "crlf", "mixedEol": false })
        );
        let back: FormatDto = serde_json::from_value(
            serde_json::json!({ "bom": false, "eol": "lf", "mixedEol": true }),
        )
        .unwrap();
        assert_eq!(back.eol, EolDto::Lf);
        assert!(back.mixed_eol);
    }
}
