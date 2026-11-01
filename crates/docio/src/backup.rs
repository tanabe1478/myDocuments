use crate::save::save_atomic;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// バックアップの保持上限。超えたら古いものから消す。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackupLimits {
    pub max_files: usize,
    pub max_bytes: u64,
}

/// 全体で最大 50 ファイル・100 MiB。
pub const DEFAULT_BACKUP_LIMITS: BackupLimits = BackupLimits {
    max_files: 50,
    max_bytes: 100 * 1024 * 1024,
};

const MAX_NAME_CHARS: usize = 80;

/// `bytes`（上書きされる直前のディスク内容）を `dir` へ保存し、保存先を返す。
/// ファイル名は「元のファイル名 + 時刻（UTC）+ revision の先頭 8 桁 + .bak」。
/// 保存後に上限を超えていれば、古い順に消す（今作ったものは消さない）。
pub fn backup_bytes(
    dir: &Path,
    original_name: &str,
    revision: &str,
    bytes: &[u8],
    limits: BackupLimits,
) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = format!(
        "{}.{}.{}.bak",
        sanitize_name(original_name),
        format_utc(now),
        revision.chars().take(8).collect::<String>()
    );
    let path = dir.join(name);
    save_atomic(&path, bytes)?;
    prune(dir, limits, &path)?;
    Ok(path)
}

/// 元のファイル名からパス区切りと制御文字を除き、長さを制限する。
fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .take(MAX_NAME_CHARS)
        .collect();
    let trimmed = cleaned.trim_matches('.');
    if trimmed.is_empty() {
        "document".to_string()
    } else {
        trimmed.to_string()
    }
}

/// UNIX 秒を `YYYYMMDDTHHMMSSZ`（UTC）にする。
pub(crate) fn format_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // 1970-01-01 からの日数 → 西暦の年月日（Howard Hinnant の civil_from_days）。
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

/// `keep`（直前に作ったバックアップ）以外を古い順に消して、上限に収める。
/// 古さは更新時刻、同時刻ならファイル名の順。`.bak` 以外のファイルには触れない。
pub fn prune(dir: &Path, limits: BackupLimits, keep: &Path) -> io::Result<()> {
    let mut entries: Vec<(SystemTime, PathBuf, u64)> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("bak") {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) if m.is_file() => m,
            _ => continue,
        };
        let modified = meta.modified().unwrap_or(UNIX_EPOCH);
        entries.push((modified, path, meta.len()));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

    let mut count = entries.len();
    let mut total: u64 = entries.iter().map(|e| e.2).sum();
    for (_, path, len) in &entries {
        if count <= limits.max_files && total <= limits.max_bytes {
            break;
        }
        if path == keep {
            continue;
        }
        if fs::remove_file(path).is_ok() {
            count -= 1;
            total -= len;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    static N: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let d = std::env::temp_dir().join(format!(
                "docio-backup-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&d).unwrap();
            TempDir(d)
        }
        fn names(&self) -> Vec<String> {
            let mut v: Vec<String> = fs::read_dir(&self.0)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            v.sort();
            v
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn set_age(path: &Path, secs_ago: u64) {
        let f = OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(secs_ago))
            .unwrap();
    }

    const ROOMY: BackupLimits = BackupLimits {
        max_files: 1000,
        max_bytes: u64::MAX,
    };

    #[test]
    fn utc_timestamp_format() {
        assert_eq!(format_utc(0), "19700101T000000Z");
        assert_eq!(format_utc(951_782_400 + 3_661), "20000229T010101Z");
        assert_eq!(format_utc(1_793_536_496), "20261101T123456Z");
    }

    #[test]
    fn backup_is_named_after_the_file_time_and_revision_prefix() {
        let dir = TempDir::new();
        let rev = "0123456789abcdef".repeat(4);
        let path = backup_bytes(&dir.0, "memo.md", &rev, b"old body", ROOMY).unwrap();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("memo.md."), "{name}");
        assert!(name.ends_with(".01234567.bak"), "{name}");
        assert_eq!(fs::read(&path).unwrap(), b"old body");
        assert_eq!(dir.names().len(), 1);
    }

    #[test]
    fn hostile_names_cannot_escape_the_directory() {
        let dir = TempDir::new();
        let path = backup_bytes(&dir.0, "../../etc/passwd", "ab", b"x", ROOMY).unwrap();
        assert_eq!(path.parent().unwrap(), dir.0);
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(!name.contains('/') && !name.contains('\\'), "{name}");
        let path = backup_bytes(&dir.0, "..", "ab", b"x", ROOMY).unwrap();
        assert_eq!(path.parent().unwrap(), dir.0);
    }

    #[test]
    fn oldest_files_are_removed_when_the_count_limit_is_exceeded() {
        let dir = TempDir::new();
        let limits = BackupLimits {
            max_files: 3,
            max_bytes: u64::MAX,
        };
        for i in 0..3 {
            let p = dir.0.join(format!("f{i}.md.20260101T000000Z.aaaaaaaa.bak"));
            fs::write(&p, b"x").unwrap();
            // f0 が最も古い。
            set_age(&p, 1000 - i * 100);
        }
        let newest = backup_bytes(&dir.0, "new.md", "bbbbbbbb", b"x", limits).unwrap();
        let names = dir.names();
        assert_eq!(names.len(), 3, "{names:?}");
        assert!(!names.iter().any(|n| n.starts_with("f0.")), "{names:?}");
        assert!(newest.exists());
    }

    #[test]
    fn oldest_files_are_removed_when_the_size_limit_is_exceeded() {
        let dir = TempDir::new();
        let limits = BackupLimits {
            max_files: 100,
            max_bytes: 25,
        };
        for i in 0..3 {
            let p = dir.0.join(format!("f{i}.md.20260101T000000Z.aaaaaaaa.bak"));
            fs::write(&p, [b'x'; 10]).unwrap();
            set_age(&p, 1000 - i * 100);
        }
        // 10 + 10 + 10 + 10 = 40 バイト。25 以下になるまで古い順に消す（f0, f1 → 20 バイト）。
        let newest = backup_bytes(&dir.0, "new.md", "bbbbbbbb", &[b'y'; 10], limits).unwrap();
        let names = dir.names();
        assert_eq!(names.len(), 2, "{names:?}");
        assert!(names.iter().any(|n| n.starts_with("f2.")), "{names:?}");
        assert!(newest.exists());
    }

    #[test]
    fn the_newest_backup_survives_even_if_it_alone_exceeds_the_size_limit() {
        let dir = TempDir::new();
        let limits = BackupLimits {
            max_files: 10,
            max_bytes: 5,
        };
        let newest = backup_bytes(&dir.0, "big.md", "cccccccc", &[b'z'; 100], limits).unwrap();
        assert_eq!(fs::read(&newest).unwrap().len(), 100);
    }

    #[test]
    fn files_that_are_not_backups_are_left_alone() {
        let dir = TempDir::new();
        let limits = BackupLimits {
            max_files: 1,
            max_bytes: u64::MAX,
        };
        fs::write(dir.0.join("keep.txt"), b"x").unwrap();
        backup_bytes(&dir.0, "a.md", "aaaaaaaa", b"1", limits).unwrap();
        backup_bytes(&dir.0, "b.md", "bbbbbbbb", b"2", limits).unwrap();
        let names = dir.names();
        assert!(names.contains(&"keep.txt".to_string()), "{names:?}");
        assert_eq!(names.iter().filter(|n| n.ends_with(".bak")).count(), 1);
    }
}
