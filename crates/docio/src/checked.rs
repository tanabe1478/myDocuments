use crate::backup::{backup_bytes, BackupLimits};
use crate::revision::{disk_state, revision_of, DiskState};
use crate::save::{save_atomic, SaveOutcome};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// `save_checked` の結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckedSave {
    Saved {
        outcome: SaveOutcome,
        /// 保存後のディスク内容の revision。
        revision: String,
        /// 上書き前の内容を退避した先（`overwrite` で、内容が変わるときだけ）。
        backup: Option<PathBuf>,
    },
    /// 書かなかった。ディスクの内容が、呼び出し側の前提（`expected`）と違う。
    Conflict { disk: DiskState },
}

/// 保存の直前にディスクの内容のハッシュを取り、呼び出し側が最後に見た revision（`expected`）と
/// 違えば書かずに `Conflict` を返す（FS-04）。
///
/// - `expected = Some(r)`: ディスクが `r` のときだけ書く。ファイルが消えていれば Conflict（Missing）。
/// - `expected = None`: ディスクにファイルがない前提。ファイルがあれば Conflict。
/// - ディスクの内容が書き込む内容と同一なら、前提と違っても衝突ではない（何も失われない）。`Unchanged`。
/// - `overwrite = true`: 衝突していても書く。現在のディスク内容は先に `backup_dir` へ退避する（FS-07）。
///   退避に失敗したら書かない。
///
/// 比較から rename までの間に別のプロセスが書く競合窓は残る（原子的な比較・置換は
/// ファイルシステムにない）。窓は、ハッシュ計算と一時ファイルの書き込みの時間だけ。
pub fn save_checked(
    path: &Path,
    bytes: &[u8],
    expected: Option<&str>,
    overwrite: bool,
    backup_dir: &Path,
    limits: BackupLimits,
) -> io::Result<CheckedSave> {
    let current = fs::read(path);
    let (current_state, current_bytes) = match current {
        Ok(b) => (
            DiskState::Present {
                revision: revision_of(&b),
            },
            Some(b),
        ),
        Err(e) if e.kind() == io::ErrorKind::NotFound => (DiskState::Missing, None),
        Err(e) => return Err(e),
    };

    let new_revision = revision_of(bytes);
    let matches_expectation = match (&current_state, expected) {
        (DiskState::Present { revision }, Some(e)) => revision == e,
        (DiskState::Missing, None) => true,
        _ => false,
    };
    let same_content = matches!(&current_state, DiskState::Present { revision } if *revision == new_revision);

    if !matches_expectation && !same_content && !overwrite {
        return Ok(CheckedSave::Conflict {
            disk: current_state,
        });
    }

    let mut backup = None;
    if !matches_expectation && !same_content {
        if let (DiskState::Present { revision }, Some(old)) = (&current_state, &current_bytes) {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            backup = Some(backup_bytes(backup_dir, &name, revision, old, limits)?);
        }
    }

    let outcome = save_atomic(path, bytes)?;
    Ok(CheckedSave::Saved {
        outcome,
        revision: new_revision,
        backup,
    })
}

/// 現在のディスク状態（`check_document` 用）。
pub fn check(path: &Path) -> io::Result<DiskState> {
    disk_state(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static N: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let d = std::env::temp_dir().join(format!(
                "docio-checked-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&d).unwrap();
            TempDir(d)
        }
        fn doc(&self, name: &str) -> PathBuf {
            self.0.join("docs").join(name)
        }
        fn backups(&self) -> PathBuf {
            self.0.join("backups")
        }
        fn backup_files(&self) -> Vec<PathBuf> {
            match fs::read_dir(self.backups()) {
                Ok(rd) => rd.map(|e| e.unwrap().path()).collect(),
                Err(_) => vec![],
            }
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const LIMITS: BackupLimits = crate::backup::DEFAULT_BACKUP_LIMITS;

    fn setup(content: &[u8]) -> (TempDir, PathBuf, String) {
        let dir = TempDir::new();
        let p = dir.doc("a.md");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, content).unwrap();
        (dir, p, revision_of(content))
    }

    #[test]
    fn writes_when_the_disk_matches_the_expected_revision() {
        let (dir, p, rev) = setup(b"v1");
        let r = save_checked(&p, b"v2", Some(&rev), false, &dir.backups(), LIMITS).unwrap();
        assert_eq!(
            r,
            CheckedSave::Saved {
                outcome: SaveOutcome::Written,
                revision: revision_of(b"v2"),
                backup: None
            }
        );
        assert_eq!(fs::read(&p).unwrap(), b"v2");
        assert!(dir.backup_files().is_empty());
    }

    #[test]
    fn does_not_write_when_the_disk_changed_after_the_expected_revision() {
        let (dir, p, rev) = setup(b"v1");
        // 別のプロセスが書き換えた。
        fs::write(&p, b"external").unwrap();

        let r = save_checked(&p, b"mine", Some(&rev), false, &dir.backups(), LIMITS).unwrap();

        assert_eq!(
            r,
            CheckedSave::Conflict {
                disk: DiskState::Present {
                    revision: revision_of(b"external")
                }
            }
        );
        assert_eq!(fs::read(&p).unwrap(), b"external");
        assert!(dir.backup_files().is_empty());
    }

    #[test]
    fn a_missing_file_is_a_conflict_unless_nothing_was_expected() {
        let dir = TempDir::new();
        let p = dir.doc("gone.md");
        fs::create_dir_all(p.parent().unwrap()).unwrap();

        let r = save_checked(&p, b"x", Some("abc"), false, &dir.backups(), LIMITS).unwrap();
        assert_eq!(
            r,
            CheckedSave::Conflict {
                disk: DiskState::Missing
            }
        );
        assert!(!p.exists());

        let r = save_checked(&p, b"x", None, false, &dir.backups(), LIMITS).unwrap();
        assert!(matches!(r, CheckedSave::Saved { .. }));
        assert_eq!(fs::read(&p).unwrap(), b"x");
    }

    #[test]
    fn a_file_that_appeared_where_none_was_expected_is_a_conflict() {
        let (dir, p, _) = setup(b"someone created me");
        let r = save_checked(&p, b"mine", None, false, &dir.backups(), LIMITS).unwrap();
        assert!(matches!(r, CheckedSave::Conflict { .. }));
        assert_eq!(fs::read(&p).unwrap(), b"someone created me");
    }

    #[test]
    fn overwrite_backs_up_the_current_disk_content_before_writing() {
        let (dir, p, rev) = setup(b"v1");
        fs::write(&p, b"external").unwrap();

        let r = save_checked(&p, b"mine", Some(&rev), true, &dir.backups(), LIMITS).unwrap();

        let CheckedSave::Saved {
            outcome,
            revision,
            backup,
        } = r
        else {
            panic!("expected Saved");
        };
        assert_eq!(outcome, SaveOutcome::Written);
        assert_eq!(revision, revision_of(b"mine"));
        let backup = backup.expect("a backup must be made");
        assert_eq!(fs::read(&backup).unwrap(), b"external");
        assert_eq!(fs::read(&p).unwrap(), b"mine");
        assert_eq!(dir.backup_files(), vec![backup.clone()]);
        let name = backup.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("a.md."), "{name}");
        assert!(
            name.ends_with(&format!(".{}.bak", &revision_of(b"external")[..8])),
            "{name}"
        );
    }

    #[test]
    fn overwrite_does_not_write_if_the_backup_cannot_be_made() {
        let (dir, p, rev) = setup(b"v1");
        fs::write(&p, b"external").unwrap();
        // backups が通常ファイルなので、ディレクトリを作れない。
        fs::write(dir.backups(), b"not a directory").unwrap();

        let r = save_checked(&p, b"mine", Some(&rev), true, &dir.backups(), LIMITS);

        assert!(r.is_err());
        assert_eq!(fs::read(&p).unwrap(), b"external");
    }

    #[test]
    fn overwrite_of_a_missing_file_needs_no_backup() {
        let dir = TempDir::new();
        let p = dir.doc("gone.md");
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        let r = save_checked(&p, b"mine", Some("abc"), true, &dir.backups(), LIMITS).unwrap();
        assert!(matches!(
            r,
            CheckedSave::Saved {
                backup: None,
                outcome: SaveOutcome::Written,
                ..
            }
        ));
        assert!(dir.backup_files().is_empty());
    }

    #[test]
    fn identical_content_is_not_a_conflict_and_is_not_written() {
        let (dir, p, rev) = setup(b"v1");
        // 外部が、こちらが書こうとしているのと同じ内容に書き換えた。
        fs::write(&p, b"same").unwrap();
        let r = save_checked(&p, b"same", Some(&rev), false, &dir.backups(), LIMITS).unwrap();
        assert_eq!(
            r,
            CheckedSave::Saved {
                outcome: SaveOutcome::Unchanged,
                revision: revision_of(b"same"),
                backup: None
            }
        );
        assert!(dir.backup_files().is_empty());
    }

    #[test]
    fn check_reports_the_revision_or_missing() {
        let (dir, p, rev) = setup(b"v1");
        assert_eq!(check(&p).unwrap(), DiskState::Present { revision: rev });
        assert_eq!(check(&dir.doc("none.md")).unwrap(), DiskState::Missing);
    }

    #[cfg(unix)]
    #[test]
    fn saving_through_a_symlink_keeps_the_link_and_updates_the_target() {
        let dir = TempDir::new();
        let real = dir.0.join("real").join("note.md");
        let link = dir.0.join("link.md");
        fs::create_dir_all(real.parent().unwrap()).unwrap();
        fs::write(&real, b"v1").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        // リンク経由の check は、実体の内容を見る。
        let rev = revision_of(b"v1");
        assert_eq!(
            check(&link).unwrap(),
            DiskState::Present {
                revision: rev.clone()
            }
        );

        let r = save_checked(&link, b"v2", Some(&rev), false, &dir.backups(), LIMITS).unwrap();
        assert!(matches!(r, CheckedSave::Saved { .. }));
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&real).unwrap(), b"v2");

        // 実体が外部で変わっていれば、リンク経由でも衝突になる。
        fs::write(&real, b"external").unwrap();
        let r = save_checked(&link, b"v3", Some(&revision_of(b"v2")), false, &dir.backups(), LIMITS)
            .unwrap();
        assert!(matches!(r, CheckedSave::Conflict { .. }));
        assert_eq!(fs::read(&real).unwrap(), b"external");
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_is_reported_as_missing() {
        let dir = TempDir::new();
        let link = dir.0.join("dangling.md");
        std::os::unix::fs::symlink(dir.0.join("nowhere.md"), &link).unwrap();
        assert_eq!(check(&link).unwrap(), DiskState::Missing);
    }
}
