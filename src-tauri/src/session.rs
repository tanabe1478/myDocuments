//! セッション情報（前回開いていた文書とフォルダのパス）。Preferences とは別に、アプリのデータ領域へ保存する。

use crate::error::{CommandError, ErrorKind};
use serde::{Deserialize, Serialize};
use std::path::Path;

const FILE_NAME: &str = "session.json";
const MAX_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// 前回開いていた（または保存先に選んだ）文書の絶対パス。
    pub last_path: Option<String>,
    /// 前回エクスプローラーに開いていたフォルダの絶対パス。古い session.json にはないので、読むときは None。
    #[serde(default)]
    pub last_folder: Option<String>,
}

/// ファイルがない・壊れている場合は、空のセッション。
pub fn load_from(dir: &Path) -> Result<Session, CommandError> {
    let bytes = match std::fs::read(dir.join(FILE_NAME)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Session::default()),
        Err(e) => return Err(e.into()),
    };
    Ok(serde_json::from_slice(&bytes).unwrap_or_default())
}

pub fn save_to(dir: &Path, session: &Session) -> Result<(), CommandError> {
    if let Some(p) = &session.last_path {
        crate::documents::validate_path(p)?;
    }
    if let Some(p) = &session.last_folder {
        crate::documents::validate_path(p)?;
    }
    let mut bytes = serde_json::to_vec_pretty(session)
        .map_err(|e| CommandError::new(ErrorKind::InvalidInput, e.to_string()))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_BYTES {
        return Err(CommandError::new(
            ErrorKind::InvalidInput,
            "the session is too large",
        ));
    }
    std::fs::create_dir_all(dir)?;
    docio::save_atomic(&dir.join(FILE_NAME), &bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            TempDir(std::env::temp_dir().join(format!(
                "ime-session-{}-{}",
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

    #[test]
    fn missing_or_corrupt_is_an_empty_session() {
        let dir = TempDir::new();
        assert_eq!(load_from(&dir.0).unwrap(), Session::default());
        fs::create_dir_all(&dir.0).unwrap();
        fs::write(dir.0.join(FILE_NAME), b"{ not json").unwrap();
        assert_eq!(load_from(&dir.0).unwrap(), Session::default());
    }

    #[test]
    fn save_then_load_roundtrip() {
        let dir = TempDir::new();
        let s = Session {
            last_path: Some(if cfg!(windows) { "C:\\notes\\a.md" } else { "/notes/a.md" }.to_string()),
            last_folder: Some(if cfg!(windows) { "C:\\notes" } else { "/notes" }.to_string()),
        };
        save_to(&dir.0, &s).unwrap();
        assert_eq!(load_from(&dir.0).unwrap(), s);
        let raw: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.0.join(FILE_NAME)).unwrap()).unwrap();
        assert!(raw.get("lastPath").is_some());
        assert!(raw.get("lastFolder").is_some());
    }

    #[test]
    fn a_session_file_from_before_last_folder_still_loads() {
        let dir = TempDir::new();
        fs::create_dir_all(&dir.0).unwrap();
        fs::write(dir.0.join(FILE_NAME), br#"{ "lastPath": "/notes/a.md" }"#).unwrap();
        let s = load_from(&dir.0).unwrap();
        assert_eq!(s.last_path.as_deref(), Some("/notes/a.md"));
        assert_eq!(s.last_folder, None);
        // 読んだものを書き戻しても、lastFolder は null のまま。
        save_to(&dir.0, &s).unwrap();
        assert_eq!(load_from(&dir.0).unwrap(), s);
    }

    #[test]
    fn a_relative_last_folder_is_rejected_and_nothing_is_written() {
        let dir = TempDir::new();
        let err = save_to(
            &dir.0,
            &Session {
                last_path: None,
                last_folder: Some("notes".to_string()),
            },
        )
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidInput);
        assert!(!dir.0.exists());
    }

    #[test]
    fn relative_paths_are_rejected_and_nothing_is_written() {
        let dir = TempDir::new();
        let err = save_to(
            &dir.0,
            &Session {
                last_path: Some("a.md".to_string()),
                last_folder: None,
            },
        )
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidInput);
        assert!(!dir.0.exists());
    }

    #[test]
    fn clearing_the_last_path_is_allowed() {
        let dir = TempDir::new();
        save_to(&dir.0, &Session::default()).unwrap();
        assert_eq!(load_from(&dir.0).unwrap().last_path, None);
    }
}
