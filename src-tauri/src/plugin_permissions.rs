//! 部品（隔離した操作の段）の権限の、利用者の決定の保存（ADR-005 の R6）。設定（preferences.json）とは別の
//! ファイル `plugin-permissions.json` に、アプリのデータ領域へ書く。
//!
//! 形: `{ "version": 1, "plugins": { "<部品の id>": { "<権限>": "granted" | "denied" } } }`。
//! Rust 側は、形と大きさを検査して、原子的に保存・読み込みするだけ（権限を使うかどうかの判断は本体の UI の側）。
//! 壊れている（JSON でない、形が違う、大きすぎる）ファイルは、空として読む（起動を止めない）。

use crate::error::{CommandError, ErrorKind};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

const FILE_NAME: &str = "plugin-permissions.json";
pub const VERSION: u32 = 1;
const MAX_BYTES: usize = 16 * 1024;
const MAX_PLUGINS: usize = 64;
const MAX_ID_LEN: usize = 64;
/// 決められる権限の種類（src/plugin-api/permissions.ts の PERMISSIONS と同じ）。
pub const KNOWN_PERMISSIONS: [&str; 2] = ["clipboard.write", "paths.read"];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Granted,
    Denied,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PluginPermissions {
    pub version: u32,
    pub plugins: BTreeMap<String, BTreeMap<String, Decision>>,
}

impl Default for PluginPermissions {
    fn default() -> Self {
        PluginPermissions {
            version: VERSION,
            plugins: BTreeMap::new(),
        }
    }
}

fn invalid(message: &str) -> CommandError {
    CommandError::new(ErrorKind::InvalidInput, message)
}

fn is_plugin_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    id.len() <= MAX_ID_LEN
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// 形の検査。版、部品の数、部品の id の形、権限の名前。
pub fn validate(permissions: &PluginPermissions) -> Result<(), CommandError> {
    if permissions.version != VERSION {
        return Err(invalid("the version is not supported"));
    }
    if permissions.plugins.len() > MAX_PLUGINS {
        return Err(invalid("too many plugins"));
    }
    for (id, decisions) in &permissions.plugins {
        if !is_plugin_id(id) {
            return Err(invalid("a plugin id is not valid"));
        }
        if decisions.keys().any(|k| !KNOWN_PERMISSIONS.contains(&k.as_str())) {
            return Err(invalid("an unknown permission"));
        }
    }
    Ok(())
}

/// 保存済みの決定。ファイルがない、大きすぎる、JSON として読めない、形が違う場合は、空。
pub fn load_from(dir: &Path) -> Result<PluginPermissions, CommandError> {
    let bytes = match std::fs::read(dir.join(FILE_NAME)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(PluginPermissions::default()),
        Err(e) => return Err(e.into()),
    };
    if bytes.len() > MAX_BYTES {
        return Ok(PluginPermissions::default());
    }
    match serde_json::from_slice::<PluginPermissions>(&bytes) {
        Ok(p) if validate(&p).is_ok() => Ok(p),
        _ => Ok(PluginPermissions::default()),
    }
}

/// 検査してから保存する。渡された値は `serde_json::Value`（形が違うときは InvalidInput にするため）。
pub fn save_to(dir: &Path, value: &serde_json::Value) -> Result<(), CommandError> {
    let permissions: PluginPermissions =
        serde_json::from_value(value.clone()).map_err(|_| invalid("the permissions have the wrong shape"))?;
    validate(&permissions)?;
    let mut bytes = serde_json::to_vec_pretty(&permissions)
        .map_err(|e| CommandError::new(ErrorKind::InvalidInput, e.to_string()))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_BYTES {
        return Err(invalid("the permissions are too large"));
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
                "ime-plugin-permissions-{}-{}",
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

    fn sample() -> serde_json::Value {
        json!({
            "version": 1,
            "plugins": { "copy-path": { "clipboard.write": "granted", "paths.read": "denied" } }
        })
    }

    #[test]
    fn missing_file_is_empty() {
        let dir = TempDir::new();
        assert_eq!(load_from(&dir.0).unwrap(), PluginPermissions::default());
    }

    #[test]
    fn save_then_load_roundtrip_creates_the_directory() {
        let dir = TempDir::new();
        save_to(&dir.0, &sample()).unwrap();
        let loaded = load_from(&dir.0).unwrap();
        assert_eq!(serde_json::to_value(&loaded).unwrap(), sample());
        // ファイル名は設定とは別。
        assert!(dir.0.join("plugin-permissions.json").exists());
        assert!(!dir.0.join("preferences.json").exists());
    }

    #[test]
    fn a_broken_file_is_read_as_empty() {
        let dir = TempDir::new();
        fs::create_dir_all(&dir.0).unwrap();
        for body in [
            &b"{ not json"[..],
            b"[1,2]",
            b"{\"version\":2,\"plugins\":{}}",
            b"{\"version\":1}",
            b"{\"version\":1,\"plugins\":{\"Bad Id\":{}}}",
            b"{\"version\":1,\"plugins\":{\"a\":{\"network\":\"granted\"}}}",
            b"{\"version\":1,\"plugins\":{\"a\":{\"paths.read\":\"maybe\"}}}",
            b"{\"version\":1,\"plugins\":{},\"extra\":1}",
        ] {
            fs::write(dir.0.join(FILE_NAME), body).unwrap();
            assert_eq!(load_from(&dir.0).unwrap(), PluginPermissions::default(), "{}", String::from_utf8_lossy(body));
        }
        // 大きすぎるファイル。
        let big = format!("{{\"version\":1,\"plugins\":{{}},\"pad\":\"{}\"}}", "x".repeat(MAX_BYTES));
        fs::write(dir.0.join(FILE_NAME), big).unwrap();
        assert_eq!(load_from(&dir.0).unwrap(), PluginPermissions::default());
    }

    #[test]
    fn rejects_a_wrong_shape_without_writing() {
        let dir = TempDir::new();
        let too_many: serde_json::Map<String, serde_json::Value> =
            (0..=MAX_PLUGINS).map(|i| (format!("p{i}"), json!({}))).collect();
        for value in [
            json!([1]),
            json!({ "version": 2, "plugins": {} }),
            json!({ "version": 1 }),
            json!({ "version": 1, "plugins": { "Bad": {} } }),
            json!({ "version": 1, "plugins": { "": {} } }),
            json!({ "version": 1, "plugins": { "a".repeat(MAX_ID_LEN + 1): {} } }),
            json!({ "version": 1, "plugins": { "a": { "shell": "granted" } } }),
            json!({ "version": 1, "plugins": { "a": { "paths.read": "yes" } } }),
            json!({ "version": 1, "plugins": { "a": { "paths.read": 1 } } }),
            json!({ "version": 1, "plugins": {}, "extra": true }),
            json!({ "version": 1, "plugins": too_many }),
        ] {
            assert_eq!(save_to(&dir.0, &value).unwrap_err().kind, ErrorKind::InvalidInput, "{value}");
        }
        assert!(!dir.0.exists());
    }

    #[test]
    fn accepts_the_largest_allowed_ids() {
        let dir = TempDir::new();
        let id = "a".repeat(MAX_ID_LEN);
        save_to(&dir.0, &json!({ "version": 1, "plugins": { id.clone(): { "paths.read": "granted" } } })).unwrap();
        assert!(load_from(&dir.0).unwrap().plugins.contains_key(&id));
    }

    #[test]
    fn known_permissions_match_the_frontend_names() {
        assert_eq!(KNOWN_PERMISSIONS, ["clipboard.write", "paths.read"]);
    }
}
