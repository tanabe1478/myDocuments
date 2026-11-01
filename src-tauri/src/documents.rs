//! 文書の入出力（open / save）。Tauri に依存しない部分。docio の薄いラッパー。

use crate::error::{CommandError, ErrorKind};
use docio::{CheckedSave, DiskState, DocumentFormat, Eol, SaveOutcome, DEFAULT_BACKUP_LIMITS};
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
    /// 読み込んだバイト列の SHA-256（16 進）。保存時に「最後に見たディスクの状態」として返す。
    pub revision: String,
}

/// ディスク上のファイルの状態。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DiskStateDto {
    Present { revision: String },
    Missing,
}

impl From<DiskState> for DiskStateDto {
    fn from(s: DiskState) -> Self {
        match s {
            DiskState::Present { revision } => DiskStateDto::Present { revision },
            DiskState::Missing => DiskStateDto::Missing,
        }
    }
}

/// 保存の結果。衝突は失敗（エラー）ではなく、書かなかったという正常な結果として返す。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SaveResultDto {
    #[serde(rename_all = "camelCase")]
    Saved {
        outcome: SaveOutcomeDto,
        /// 保存後のディスク内容の revision。
        revision: String,
        /// 上書き前の内容を退避した先。退避しなかったときは null。
        backup: Option<String>,
    },
    Conflict {
        disk: DiskStateDto,
    },
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
        revision: docio::revision_of(&bytes),
    })
}

/// 開いた・保存先に選んだパスの、現在のディスクの状態（外部変更の確認用）。
pub fn check(path: &str, known: &KnownPaths) -> Result<DiskStateDto, CommandError> {
    let p = validate_known(path, known)?;
    Ok(docio::check(&p)?.into())
}

/// このセッションで開いた・保存先に選んだパスだけを受け付ける（監視・確認・保存の共通の入口）。
pub fn validate_known(path: &str, known: &KnownPaths) -> Result<PathBuf, CommandError> {
    let p = validate_path(path)?;
    if !known.contains(&p) {
        return Err(CommandError::new(
            ErrorKind::NotAllowed,
            "the path was not opened or chosen in this session",
        ));
    }
    Ok(p)
}

/// 保存直前にディスクの内容を確かめて書く（FS-04）。
/// `expected_revision` は、この文書が最後に見たディスクの revision（ファイルがない前提なら None）。
/// 違えば書かずに `Conflict` を返す。`overwrite` は、衝突を承知で上書きする（先に現在の内容を退避する）。
pub fn save(
    path: &str,
    text: &str,
    format: FormatDto,
    expected_revision: Option<&str>,
    overwrite: bool,
    backups_dir: &Path,
    known: &KnownPaths,
) -> Result<SaveResultDto, CommandError> {
    let p = validate_known(path, known)?;
    let bytes = docio::encode(text, &format.into());
    let result = docio::save_checked(
        &p,
        &bytes,
        expected_revision,
        overwrite,
        backups_dir,
        DEFAULT_BACKUP_LIMITS,
    )?;
    Ok(match result {
        CheckedSave::Saved {
            outcome,
            revision,
            backup,
        } => SaveResultDto::Saved {
            outcome: outcome.into(),
            revision,
            backup: backup.map(|b| b.to_string_lossy().into_owned()),
        },
        CheckedSave::Conflict { disk } => SaveResultDto::Conflict { disk: disk.into() },
    })
}

/// OS の保存ダイアログで選んだパスへの保存。上書きの確認は OS のダイアログが済ませているので、
/// 競合検査はしない。
pub fn save_as(
    path: &str,
    text: &str,
    format: FormatDto,
    known: &KnownPaths,
) -> Result<SaveResultDto, CommandError> {
    let p = validate_path(path)?;
    let bytes = docio::encode(text, &format.into());
    let outcome = docio::save_atomic(&p, &bytes)?;
    known.register(&p);
    Ok(SaveResultDto::Saved {
        outcome: outcome.into(),
        revision: docio::revision_of(&bytes),
        backup: None,
    })
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

    fn backups(dir: &TempDir) -> PathBuf {
        dir.0.join("backups")
    }

    fn saved(r: SaveResultDto) -> (SaveOutcomeDto, String, Option<String>) {
        match r {
            SaveResultDto::Saved {
                outcome,
                revision,
                backup,
            } => (outcome, revision, backup),
            other => panic!("expected Saved, got {other:?}"),
        }
    }

    const LF_FMT: FormatDto = FormatDto {
        bom: false,
        eol: EolDto::Lf,
        mixed_eol: false,
    };

    #[test]
    fn open_returns_the_revision_of_the_disk_bytes() {
        let dir = TempDir::new();
        let path = dir.file("a.md");
        fs::write(&path, CRLF_BOM).unwrap();
        let doc = open(&path, &KnownPaths::default()).unwrap();
        assert_eq!(doc.revision, docio::revision_of(CRLF_BOM));
    }

    #[test]
    fn save_requires_a_known_path() {
        let dir = TempDir::new();
        let path = dir.file("a.md");
        fs::write(&path, b"x").unwrap();
        let known = KnownPaths::default();
        let rev = docio::revision_of(b"x");

        let err = save(&path, "y", LF_FMT, Some(&rev), false, &backups(&dir), &known).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotAllowed);
        assert_eq!(fs::read(&path).unwrap(), b"x");
        assert_eq!(check(&path, &known).unwrap_err().kind, ErrorKind::NotAllowed);

        open(&path, &known).unwrap();
        let (outcome, revision, backup) =
            saved(save(&path, "y", LF_FMT, Some(&rev), false, &backups(&dir), &known).unwrap());
        assert_eq!(outcome, SaveOutcomeDto::Written);
        assert_eq!(revision, docio::revision_of(b"y"));
        assert_eq!(backup, None);
        assert_eq!(fs::read(&path).unwrap(), b"y");
    }

    #[test]
    fn open_then_save_unmodified_keeps_bytes_and_modified_save_keeps_format() {
        let dir = TempDir::new();
        let path = dir.file("a.md");
        fs::write(&path, CRLF_BOM).unwrap();
        let known = KnownPaths::default();
        let doc = open(&path, &known).unwrap();

        let r = save(&path, &doc.text, doc.format, Some(&doc.revision), false, &backups(&dir), &known).unwrap();
        let (outcome, revision, _) = saved(r);
        assert_eq!(outcome, SaveOutcomeDto::Unchanged);
        assert_eq!(revision, doc.revision);
        assert_eq!(fs::read(&path).unwrap(), CRLF_BOM);

        let r = save(&path, "a\nbX\n", doc.format, Some(&doc.revision), false, &backups(&dir), &known).unwrap();
        assert_eq!(saved(r).0, SaveOutcomeDto::Written);
        assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBFa\r\nbX\r\n");
    }

    #[test]
    fn save_does_not_write_when_the_file_changed_after_open() {
        let dir = TempDir::new();
        let path = dir.file("a.md");
        fs::write(&path, b"original").unwrap();
        let known = KnownPaths::default();
        let doc = open(&path, &known).unwrap();

        // 開いた後に、別のエディタが書き換えた。
        fs::write(&path, b"edited elsewhere").unwrap();

        let r = save(&path, "mine", doc.format.clone(), Some(&doc.revision), false, &backups(&dir), &known).unwrap();
        assert_eq!(
            r,
            SaveResultDto::Conflict {
                disk: DiskStateDto::Present {
                    revision: docio::revision_of(b"edited elsewhere")
                }
            }
        );
        assert_eq!(fs::read(&path).unwrap(), b"edited elsewhere");
        assert!(!backups(&dir).exists());
    }

    #[test]
    fn overwrite_backs_up_the_disk_content_then_writes() {
        let dir = TempDir::new();
        let path = dir.file("a.md");
        fs::write(&path, b"original").unwrap();
        let known = KnownPaths::default();
        let doc = open(&path, &known).unwrap();
        fs::write(&path, b"edited elsewhere").unwrap();

        let r = save(&path, "mine", doc.format, Some(&doc.revision), true, &backups(&dir), &known).unwrap();

        let (outcome, _, backup) = saved(r);
        assert_eq!(outcome, SaveOutcomeDto::Written);
        let backup = backup.expect("backup path");
        assert_eq!(fs::read(&backup).unwrap(), b"edited elsewhere");
        assert!(Path::new(&backup).starts_with(backups(&dir)));
        assert_eq!(fs::read(&path).unwrap(), b"mine");
    }

    #[test]
    fn check_reports_present_changed_and_missing() {
        let dir = TempDir::new();
        let path = dir.file("a.md");
        fs::write(&path, b"v1").unwrap();
        let known = KnownPaths::default();
        let doc = open(&path, &known).unwrap();

        assert_eq!(
            check(&path, &known).unwrap(),
            DiskStateDto::Present {
                revision: doc.revision.clone()
            }
        );
        fs::write(&path, b"v2").unwrap();
        assert_eq!(
            check(&path, &known).unwrap(),
            DiskStateDto::Present {
                revision: docio::revision_of(b"v2")
            }
        );
        fs::remove_file(&path).unwrap();
        assert_eq!(check(&path, &known).unwrap(), DiskStateDto::Missing);
    }

    #[test]
    fn saving_a_deleted_file_conflicts_and_recreating_needs_no_expected_revision() {
        let dir = TempDir::new();
        let path = dir.file("a.md");
        fs::write(&path, b"v1").unwrap();
        let known = KnownPaths::default();
        let doc = open(&path, &known).unwrap();
        fs::remove_file(&path).unwrap();

        let r = save(&path, "mine", doc.format, Some(&doc.revision), false, &backups(&dir), &known).unwrap();
        assert_eq!(r, SaveResultDto::Conflict { disk: DiskStateDto::Missing });
        assert!(!Path::new(&path).exists());

        // 作り直す: ファイルがない前提（expected なし）で保存する。
        let r = save(&path, "mine", doc.format, None, false, &backups(&dir), &known).unwrap();
        assert_eq!(saved(r).0, SaveOutcomeDto::Written);
        assert_eq!(fs::read(&path).unwrap(), b"mine");
    }

    #[test]
    fn save_as_creates_a_file_registers_the_path_and_returns_the_revision() {
        let dir = TempDir::new();
        let path = dir.file("new.md");
        let known = KnownPaths::default();
        let fmt = FormatDto {
            bom: false,
            eol: EolDto::Crlf,
            mixed_eol: true,
        };

        let (outcome, revision, backup) = saved(save_as(&path, "a\nb", fmt, &known).unwrap());
        assert_eq!(outcome, SaveOutcomeDto::Written);
        assert_eq!(revision, docio::revision_of(b"a\r\nb"));
        assert_eq!(backup, None);
        assert_eq!(fs::read(&path).unwrap(), b"a\r\nb");
        // 以降は通常の保存ができる。
        let r = save(&path, "a\nc", fmt, Some(&revision), false, &backups(&dir), &known).unwrap();
        assert_eq!(saved(r).0, SaveOutcomeDto::Written);
    }

    #[cfg(unix)]
    #[test]
    fn saving_through_a_symlink_keeps_the_link() {
        let dir = TempDir::new();
        let real = dir.file("real.md");
        let link = dir.file("link.md");
        fs::write(&real, b"v1").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let known = KnownPaths::default();
        let doc = open(&link, &known).unwrap();

        let r = save(&link, "v2", doc.format, Some(&doc.revision), false, &backups(&dir), &known).unwrap();

        assert_eq!(saved(r).0, SaveOutcomeDto::Written);
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&real).unwrap(), b"v2");
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
