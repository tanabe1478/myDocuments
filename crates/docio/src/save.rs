use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SaveOutcome {
    /// 新しい内容を書き込んだ。
    Written,
    /// 既存ファイルのバイト列が同一だったため、書き込まなかった（ED-05）。
    Unchanged,
}

/// `bytes` を `path` へ原子的に保存する（FS-03）。
///
/// - 既存ファイルが同一のバイト列なら何もしない（`Unchanged`。mtime も変わらない）。
/// - それ以外は、同じディレクトリの一時ファイルへ書き込み → `sync_all` → `rename` で置換する。
/// - 既存ファイルのパーミッションを引き継ぐ。読み取り専用のファイルには書かない。
/// - `path` がシンボリックリンクなら、リンク先を置換する（リンク自体は残る）。
/// - 失敗時は一時ファイルを消し、元のファイルには触れない。
///
/// 所有者（chown）は引き継がない。ハードリンクは切れる（別 inode になる）。
pub fn save_atomic(path: &Path, bytes: &[u8]) -> io::Result<SaveOutcome> {
    save_atomic_with(path, bytes, |_| Ok(()))
}

/// `before_rename` は、一時ファイルの書き込みと fsync が済み、rename の直前に呼ばれる。
/// テストで失敗を注入するための入口。
pub(crate) fn save_atomic_with(
    path: &Path,
    bytes: &[u8],
    before_rename: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<SaveOutcome> {
    let (target, existing) = resolve_target(path)?;

    if let Some(meta) = &existing {
        if meta.len() == bytes.len() as u64 && fs::read(&target)? == bytes {
            return Ok(SaveOutcome::Unchanged);
        }
        if meta.permissions().readonly() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "the file is read-only",
            ));
        }
    }

    let (tmp_path, mut tmp) = create_temp(&target)?;
    let result = (|| {
        tmp.write_all(bytes)?;
        if let Some(meta) = &existing {
            fs::set_permissions(&tmp_path, meta.permissions())?;
        }
        tmp.sync_all()?;
        drop(tmp);
        before_rename(&tmp_path)?;
        fs::rename(&tmp_path, &target)
    })();

    match result {
        Ok(()) => {
            sync_parent_dir(&target);
            Ok(SaveOutcome::Written)
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp_path);
            Err(e)
        }
    }
}

/// 書き込み先（シンボリックリンクは解決）と、既存ファイルの metadata。
fn resolve_target(path: &Path) -> io::Result<(PathBuf, Option<fs::Metadata>)> {
    match fs::symlink_metadata(path) {
        Ok(link_meta) => {
            let target = if link_meta.file_type().is_symlink() {
                fs::canonicalize(path)?
            } else {
                path.to_path_buf()
            };
            let meta = fs::metadata(&target)?;
            if !meta.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "the path is not a regular file",
                ));
            }
            Ok((target, Some(meta)))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok((path.to_path_buf(), None)),
        Err(e) => Err(e),
    }
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn create_temp(target: &Path) -> io::Result<(PathBuf, File)> {
    let dir = match target.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let name = target
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "the path has no file name"))?;

    let mut last_err = None;
    for _ in 0..8 {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let mut tmp_name = OsString::from(".");
        tmp_name.push(name);
        tmp_name.push(format!(
            ".{}-{}-{}.tmp",
            process::id(),
            nanos,
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let tmp_path = dir.join(tmp_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
        {
            Ok(f) => return Ok((tmp_path, f)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => last_err = Some(e),
            Err(e) => return Err(e),
        }
    }
    Err(last_err.unwrap_or_else(|| io::Error::other("could not create a temporary file")))
}

/// rename を永続化するため、親ディレクトリを fsync する（Unix のみ。失敗は無視）。
fn sync_parent_dir(target: &Path) {
    #[cfg(unix)]
    if let Some(parent) = target.parent() {
        let dir = if parent.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent
        };
        if let Ok(f) = File::open(dir) {
            let _ = f.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = target;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> TempDir {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("docio-{label}-{}-{n}", process::id()));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn entries(&self) -> Vec<String> {
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
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
            }
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn creates_a_new_file() {
        let dir = TempDir::new("new");
        let p = dir.path().join("a.md");
        assert_eq!(save_atomic(&p, b"hello").unwrap(), SaveOutcome::Written);
        assert_eq!(fs::read(&p).unwrap(), b"hello");
        assert_eq!(dir.entries(), ["a.md"]);
    }

    #[test]
    fn identical_bytes_are_not_written_and_mtime_is_kept() {
        let dir = TempDir::new("same");
        let p = dir.path().join("a.md");
        fs::write(&p, b"same").unwrap();
        // mtime を十分過去にして、書き込まれれば必ず変わるようにする。
        let past = SystemTime::now() - Duration::from_secs(86_400);
        let f = OpenOptions::new().write(true).open(&p).unwrap();
        f.set_modified(past).unwrap();
        drop(f);
        let before = fs::metadata(&p).unwrap().modified().unwrap();

        assert_eq!(save_atomic(&p, b"same").unwrap(), SaveOutcome::Unchanged);

        let after = fs::metadata(&p).unwrap().modified().unwrap();
        assert_eq!(before, after);
        assert_eq!(dir.entries(), ["a.md"]);
    }

    #[test]
    fn different_bytes_replace_the_file_without_leaving_temp_files() {
        let dir = TempDir::new("replace");
        let p = dir.path().join("a.md");
        fs::write(&p, b"old").unwrap();
        assert_eq!(
            save_atomic(&p, b"new content").unwrap(),
            SaveOutcome::Written
        );
        assert_eq!(fs::read(&p).unwrap(), b"new content");
        assert_eq!(dir.entries(), ["a.md"]);
    }

    #[test]
    fn same_length_different_bytes_are_written() {
        let dir = TempDir::new("samelen");
        let p = dir.path().join("a.md");
        fs::write(&p, b"abc").unwrap();
        assert_eq!(save_atomic(&p, b"abd").unwrap(), SaveOutcome::Written);
        assert_eq!(fs::read(&p).unwrap(), b"abd");
    }

    #[cfg(unix)]
    #[test]
    fn permissions_of_the_existing_file_are_kept() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("perm");
        let p = dir.path().join("a.md");
        fs::write(&p, b"old").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o640)).unwrap();
        save_atomic(&p, b"new").unwrap();
        let mode = fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
    }

    #[cfg(unix)]
    #[test]
    fn read_only_file_is_refused_and_kept() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("ro-file");
        let p = dir.path().join("a.md");
        fs::write(&p, b"keep me").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o444)).unwrap();
        let err = save_atomic(&p, b"new").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&p).unwrap(), b"keep me");
        assert_eq!(dir.entries(), ["a.md"]);
        // 同一内容なら、読み取り専用でも書く必要がないので Unchanged。
        assert_eq!(save_atomic(&p, b"keep me").unwrap(), SaveOutcome::Unchanged);
    }

    #[cfg(unix)]
    #[test]
    fn read_only_directory_fails_and_keeps_the_original() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("ro-dir");
        let p = dir.path().join("a.md");
        fs::write(&p, b"original").unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();

        // root など、ディレクトリの権限を無視できる実行主体ではこの検証は成立しない。
        if File::create(dir.path().join(".probe")).is_ok() {
            eprintln!("skipped: directory permissions are not enforced for this user");
            return;
        }

        let err = save_atomic(&p, b"replacement").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&p).unwrap(), b"original");
        assert_eq!(dir.entries(), ["a.md"]);
    }

    #[test]
    fn failure_before_rename_removes_the_temp_file_and_keeps_the_original() {
        let dir = TempDir::new("inject");
        let p = dir.path().join("a.md");
        fs::write(&p, b"original").unwrap();

        let mut seen_tmp = None;
        let err = save_atomic_with(&p, b"replacement", |tmp| {
            assert!(tmp.exists(), "the temp file must exist at this point");
            assert_eq!(fs::read(tmp).unwrap(), b"replacement");
            seen_tmp = Some(tmp.to_path_buf());
            Err(io::Error::other("injected failure"))
        })
        .unwrap_err();

        assert_eq!(err.to_string(), "injected failure");
        assert_eq!(fs::read(&p).unwrap(), b"original");
        assert_eq!(dir.entries(), ["a.md"]);
        assert!(!seen_tmp.unwrap().exists());
    }

    #[test]
    fn failure_for_a_new_file_leaves_nothing_behind() {
        let dir = TempDir::new("inject-new");
        let p = dir.path().join("new.md");
        save_atomic_with(&p, b"x", |_| Err(io::Error::other("boom"))).unwrap_err();
        assert!(dir.entries().is_empty());
    }

    #[test]
    fn missing_parent_directory_is_an_error() {
        let dir = TempDir::new("noparent");
        let p = dir.path().join("missing").join("a.md");
        assert!(save_atomic(&p, b"x").is_err());
    }

    #[test]
    fn a_directory_path_is_rejected() {
        let dir = TempDir::new("isdir");
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        let err = save_atomic(&sub, b"x").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_is_followed_and_kept() {
        let dir = TempDir::new("symlink");
        let real = dir.path().join("real.md");
        let link = dir.path().join("link.md");
        fs::write(&real, b"old").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        assert_eq!(save_atomic(&link, b"new").unwrap(), SaveOutcome::Written);

        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&real).unwrap(), b"new");
        assert_eq!(dir.entries(), ["link.md", "real.md"]);
    }
}
