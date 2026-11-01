//! 草稿（クラッシュ復旧用）。アプリのデータ領域の drafts/ に、文書ごとの JSON を原子的に書く（FS-06）。
//! 元の文書には書かない。draftId はフロントエンドが文書ごとに作る UUID で、形式を検証してから
//! ファイル名に使う（パストラバーサルを許さない）。

use crate::documents::FormatDto;
use crate::error::{CommandError, ErrorKind};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// 1 件の草稿の本文の上限。これを超える文書は草稿に書かない。
const MAX_DRAFT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub draft_id: String,
    /// 元の文書のパス。保存先のない新規文書は None。
    pub path: Option<String>,
    /// 編集中の本文（LF 正規化済み）。
    pub text: String,
    pub format: FormatDto,
    /// 草稿の元になったディスクの revision（保存先のない文書は None）。
    pub base_revision: Option<String>,
    /// 最後に書いた時刻（UNIX ミリ秒）。
    pub updated_at: u64,
}

/// 復旧の確認に出すための要約（本文は含めない）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DraftSummary {
    pub draft_id: String,
    pub path: Option<String>,
    pub updated_at: u64,
}

/// UUID の形（8-4-4-4-12 の 16 進）だけを受け付ける。
pub fn validate_draft_id(id: &str) -> Result<(), CommandError> {
    let ok = id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        });
    if ok {
        Ok(())
    } else {
        Err(CommandError::new(
            ErrorKind::InvalidInput,
            "invalid draft id",
        ))
    }
}

fn draft_path(dir: &Path, id: &str) -> Result<PathBuf, CommandError> {
    validate_draft_id(id)?;
    // 大文字小文字の違いで同じ草稿が複数にならないよう、ファイル名は小文字にそろえる。
    Ok(dir.join(format!("{}.json", id.to_ascii_lowercase())))
}

/// 草稿を書く。戻り値は書いたファイルのパス（ユーザーに退避先として伝える用）。
pub fn write(dir: &Path, draft: &Draft) -> Result<String, CommandError> {
    let path = draft_path(dir, &draft.draft_id)?;
    if draft.text.len() > MAX_DRAFT_BYTES {
        return Err(CommandError::new(
            ErrorKind::InvalidInput,
            "the draft is too large",
        ));
    }
    let bytes = serde_json::to_vec(draft)
        .map_err(|e| CommandError::new(ErrorKind::InvalidInput, e.to_string()))?;
    fs::create_dir_all(dir)?;
    docio::save_atomic(&path, &bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

fn read_file(path: &Path) -> Option<Draft> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<Draft>(&bytes).ok()
}

/// 草稿を読む。なければ None。壊れていれば None（復旧の邪魔をしない）。
pub fn read(dir: &Path, id: &str) -> Result<Option<Draft>, CommandError> {
    let path = draft_path(dir, id)?;
    Ok(read_file(&path))
}

/// 草稿を消す。なくてもエラーにしない。
pub fn delete(dir: &Path, id: &str) -> Result<(), CommandError> {
    let path = draft_path(dir, id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// 草稿の一覧（新しい順）。読めない・壊れたファイル、ファイル名と draftId が合わないものは除く。
pub fn list(dir: &Path) -> Result<Vec<DraftSummary>, CommandError> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(draft) = read_file(&path) else {
            continue;
        };
        if draft_path(dir, &draft.draft_id).ok().as_deref() != Some(path.as_path()) {
            continue;
        }
        out.push(DraftSummary {
            draft_id: draft.draft_id,
            path: draft.path,
            updated_at: draft.updated_at,
        });
    }
    out.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.draft_id.cmp(&b.draft_id))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::documents::EolDto;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            // 存在しないディレクトリ（write が作ることを確認するため）。
            TempDir(std::env::temp_dir().join(format!(
                "ime-drafts-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const ID_A: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const ID_B: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

    fn draft(id: &str, text: &str, updated_at: u64) -> Draft {
        Draft {
            draft_id: id.to_string(),
            path: Some("/notes/a.md".to_string()),
            text: text.to_string(),
            format: FormatDto {
                bom: true,
                eol: EolDto::Crlf,
                mixed_eol: false,
            },
            base_revision: Some("abc".to_string()),
            updated_at,
        }
    }

    #[test]
    fn write_then_read_roundtrip_creates_the_directory() {
        let dir = TempDir::new();
        let d = draft(ID_A, "本文\n", 10);
        let location = write(&dir.0, &d).unwrap();
        assert!(Path::new(&location).starts_with(&dir.0));
        assert_eq!(read(&dir.0, ID_A).unwrap(), Some(d));
    }

    #[test]
    fn json_shape_uses_camel_case() {
        let json = serde_json::to_value(draft(ID_A, "x", 7)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "draftId": ID_A,
                "path": "/notes/a.md",
                "text": "x",
                "format": { "bom": true, "eol": "crlf", "mixedEol": false },
                "baseRevision": "abc",
                "updatedAt": 7
            })
        );
    }

    #[test]
    fn untitled_drafts_have_no_path_or_base_revision() {
        let dir = TempDir::new();
        let mut d = draft(ID_A, "x", 1);
        d.path = None;
        d.base_revision = None;
        write(&dir.0, &d).unwrap();
        assert_eq!(read(&dir.0, ID_A).unwrap(), Some(d));
    }

    #[test]
    fn rewriting_replaces_the_previous_content() {
        let dir = TempDir::new();
        write(&dir.0, &draft(ID_A, "one", 1)).unwrap();
        write(&dir.0, &draft(ID_A, "two", 2)).unwrap();
        assert_eq!(read(&dir.0, ID_A).unwrap().unwrap().text, "two");
        assert_eq!(list(&dir.0).unwrap().len(), 1);
    }

    #[test]
    fn invalid_ids_are_rejected_everywhere() {
        let dir = TempDir::new();
        for bad in [
            "",
            "../../etc/passwd",
            "..",
            "a/b",
            "a\\b",
            "0f8fad5b-d9cb-469f-a165-70867728950",
            "0f8fad5b-d9cb-469f-a165-70867728950e0",
            "0f8fad5bxd9cb-469f-a165-70867728950e",
            "0f8fad5b-d9cb-469f-a165-70867728950g",
            "0f8fad5b-d9cb-469f-a165-70867728950\0",
        ] {
            let mut d = draft(ID_A, "x", 1);
            d.draft_id = bad.to_string();
            assert_eq!(write(&dir.0, &d).unwrap_err().kind, ErrorKind::InvalidInput, "{bad:?}");
            assert_eq!(read(&dir.0, bad).unwrap_err().kind, ErrorKind::InvalidInput, "{bad:?}");
            assert_eq!(delete(&dir.0, bad).unwrap_err().kind, ErrorKind::InvalidInput, "{bad:?}");
        }
        assert!(!dir.0.exists(), "nothing may be created for invalid ids");
    }

    #[test]
    fn delete_removes_the_draft_and_is_idempotent() {
        let dir = TempDir::new();
        write(&dir.0, &draft(ID_A, "x", 1)).unwrap();
        delete(&dir.0, ID_A).unwrap();
        assert_eq!(read(&dir.0, ID_A).unwrap(), None);
        delete(&dir.0, ID_A).unwrap();
        delete(&TempDir::new().0, ID_B).unwrap();
    }

    #[test]
    fn list_is_newest_first_and_skips_broken_or_foreign_files() {
        let dir = TempDir::new();
        assert!(list(&dir.0).unwrap().is_empty());
        write(&dir.0, &draft(ID_A, "old", 100)).unwrap();
        write(&dir.0, &draft(ID_B, "new", 200)).unwrap();
        fs::write(dir.0.join("broken.json"), b"{ not json").unwrap();
        fs::write(dir.0.join("note.txt"), b"x").unwrap();
        // ファイル名と draftId が合わない JSON は、一覧に出さない。
        fs::write(
            dir.0.join("11111111-1111-1111-1111-111111111111.json"),
            serde_json::to_vec(&draft(ID_A, "x", 300)).unwrap(),
        )
        .unwrap();

        let ids: Vec<String> = list(&dir.0).unwrap().into_iter().map(|d| d.draft_id).collect();
        assert_eq!(ids, [ID_B, ID_A]);
    }

    #[test]
    fn a_broken_draft_reads_as_none() {
        let dir = TempDir::new();
        fs::create_dir_all(&dir.0).unwrap();
        fs::write(dir.0.join(format!("{ID_A}.json")), b"{ not json").unwrap();
        assert_eq!(read(&dir.0, ID_A).unwrap(), None);
    }
}
