//! Preferences の永続化。中身の型・範囲の検証はフロントエンド（src/preferences）が唯一の定義。
//! Rust 側は「JSON オブジェクトを、サイズを制限して、原子的に保存・読み込みする」だけを担う。

use crate::error::{CommandError, ErrorKind};
use serde_json::Value;
use std::path::Path;

const FILE_NAME: &str = "preferences.json";
const MAX_BYTES: usize = 64 * 1024;

/// 保存済みの Preferences。ファイルがない、または JSON として読めなければ `None`。
pub fn load_from(dir: &Path) -> Result<Option<Value>, CommandError> {
    let bytes = match std::fs::read(dir.join(FILE_NAME)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(v) if v.is_object() => Ok(Some(v)),
        _ => Ok(None),
    }
}

pub fn save_to(dir: &Path, prefs: &Value) -> Result<(), CommandError> {
    if !prefs.is_object() {
        return Err(CommandError::new(
            ErrorKind::InvalidInput,
            "preferences must be a JSON object",
        ));
    }
    let mut bytes = serde_json::to_vec_pretty(prefs)
        .map_err(|e| CommandError::new(ErrorKind::InvalidInput, e.to_string()))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_BYTES {
        return Err(CommandError::new(
            ErrorKind::InvalidInput,
            "preferences are too large",
        ));
    }
    std::fs::create_dir_all(dir)?;
    docio::save_atomic(&dir.join(FILE_NAME), &bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            // 存在しないサブディレクトリを返す（save_to が作ることを確認するため）。
            TempDir(std::env::temp_dir().join(format!(
                "ime-prefs-{}-{}",
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
    fn missing_file_is_none() {
        let dir = TempDir::new();
        assert_eq!(load_from(&dir.0).unwrap(), None);
    }

    #[test]
    fn save_then_load_roundtrip_creates_the_directory() {
        let dir = TempDir::new();
        let prefs = json!({ "maxWidthPx": 720, "theme": "dark" });
        save_to(&dir.0, &prefs).unwrap();
        assert_eq!(load_from(&dir.0).unwrap(), Some(prefs));
    }

    #[test]
    fn corrupt_file_is_treated_as_missing() {
        let dir = TempDir::new();
        fs::create_dir_all(&dir.0).unwrap();
        fs::write(dir.0.join(FILE_NAME), b"{ not json").unwrap();
        assert_eq!(load_from(&dir.0).unwrap(), None);
        fs::write(dir.0.join(FILE_NAME), b"[1,2]").unwrap();
        assert_eq!(load_from(&dir.0).unwrap(), None);
    }

    #[test]
    fn non_object_and_oversized_values_are_rejected() {
        let dir = TempDir::new();
        assert_eq!(
            save_to(&dir.0, &json!([1])).unwrap_err().kind,
            ErrorKind::InvalidInput
        );
        let big = json!({ "fontFamily": "x".repeat(MAX_BYTES) });
        assert_eq!(
            save_to(&dir.0, &big).unwrap_err().kind,
            ErrorKind::InvalidInput
        );
        assert!(!dir.0.join(FILE_NAME).exists());
    }
}
