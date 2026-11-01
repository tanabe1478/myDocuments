//! 開いている文書の外部変更の監視。
//!
//! 文書そのものではなく親ディレクトリを監視する。ほかのエディタの多くは、一時ファイルを書いてから
//! rename で置き換えるため、ファイル自体を監視すると置き換えの後に追跡できなくなる。
//! 対象ファイルに関するイベントだけを選び、短い間に続いたものは 1 回にまとめて通知する。
//! 通知は「何かが変わったかもしれない」だけで、中身の判断（revision の比較）は呼び出し側がする。

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

/// 最後のイベントからこの時間、静かなら通知する。
const QUIET: Duration = Duration::from_millis(200);
/// 途切れなくイベントが続いても、最初のイベントからこの時間で通知する。
const MAX_WAIT: Duration = Duration::from_secs(1);

/// 現在の監視（高々 1 つ）。付け替えると、前の監視は止まる。
#[derive(Default)]
pub struct DocumentWatcher {
    active: Mutex<Option<RecommendedWatcher>>,
}

impl DocumentWatcher {
    /// `path` の監視に切り替える。None なら監視をやめる。
    /// 変更があれば `on_change(path)` を（別スレッドで）呼ぶ。
    pub fn watch(
        &self,
        path: Option<PathBuf>,
        on_change: impl Fn(PathBuf) + Send + 'static,
    ) -> notify::Result<()> {
        let mut slot = self.active.lock().unwrap_or_else(|e| e.into_inner());
        // 先に前の監視を止める（新しい監視が失敗しても、古い対象を見続けない）。
        *slot = None;
        let Some(path) = path else {
            return Ok(());
        };

        let targets = Targets::new(&path);
        let (tx, rx) = mpsc::channel::<()>();
        let filter = targets.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                if filter.is_relevant(&event) {
                    let _ = tx.send(());
                }
            }
        })?;
        for dir in &targets.dirs {
            watcher.watch(dir, RecursiveMode::NonRecursive)?;
        }

        // watcher を捨てると tx も捨てられ、recv が Err になってスレッドは終わる。
        thread::spawn(move || {
            while rx.recv().is_ok() {
                let first = Instant::now();
                loop {
                    let left = MAX_WAIT.saturating_sub(first.elapsed()).min(QUIET);
                    if left.is_zero() {
                        break;
                    }
                    match rx.recv_timeout(left) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                on_change(path.clone());
            }
        });

        *slot = Some(watcher);
        Ok(())
    }
}

/// 監視する対象。ファイル自体のほか、シンボリックリンクなら実体も（実体が別のディレクトリにあるため）。
#[derive(Clone)]
struct Targets {
    /// 監視するディレクトリ。
    dirs: Vec<PathBuf>,
    /// 対象ファイルの正規化したパス（親ディレクトリを正規化し、ファイル名を足したもの）。
    files: Vec<PathBuf>,
}

impl Targets {
    fn new(path: &Path) -> Targets {
        let mut files = vec![normalize(path)];
        if let Ok(real) = std::fs::canonicalize(path) {
            let real = normalize(&real);
            if !files.contains(&real) {
                files.push(real);
            }
        }
        let mut dirs: Vec<PathBuf> = Vec::new();
        for f in &files {
            if let Some(parent) = f.parent() {
                if !dirs.iter().any(|d| d == parent) {
                    dirs.push(parent.to_path_buf());
                }
            }
        }
        Targets { dirs, files }
    }

    fn is_relevant(&self, event: &Event) -> bool {
        // 読み取りだけのアクセスは変更ではない。
        if matches!(event.kind, EventKind::Access(_)) {
            return false;
        }
        event
            .paths
            .iter()
            .any(|p| self.files.contains(&normalize(p)))
    }
}

/// macOS の /var → /private/var のようなリンクの違いを吸収するため、
/// 親ディレクトリだけを正規化する（ファイル自体は消えていることがある）。
fn normalize(path: &Path) -> PathBuf {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => std::fs::canonicalize(parent)
            .unwrap_or_else(|_| parent.to_path_buf())
            .join(name),
        _ => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    static N: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let d = std::env::temp_dir().join(format!(
                "ime-watch-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&d).unwrap();
            TempDir(d)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn counter() -> (Arc<AtomicU32>, impl Fn(PathBuf) + Send + 'static) {
        let n = Arc::new(AtomicU32::new(0));
        let n2 = n.clone();
        (n, move |_| {
            n2.fetch_add(1, Ordering::SeqCst);
        })
    }

    fn wait_for(n: &AtomicU32, at_least: u32) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(8) {
            if n.load(Ordering::SeqCst) >= at_least {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    /// 作ったばかりのファイルの作成イベントが、監視の開始後に届くのを避ける。
    fn settle() {
        thread::sleep(Duration::from_millis(600));
    }

    #[test]
    fn an_in_place_write_is_reported() {
        let dir = TempDir::new();
        let doc = dir.0.join("a.md");
        fs::write(&doc, b"v1").unwrap();
        settle();
        let (n, cb) = counter();
        let w = DocumentWatcher::default();
        w.watch(Some(doc.clone()), cb).unwrap();

        fs::write(&doc, b"v2").unwrap();

        assert!(wait_for(&n, 1), "no change was reported");
    }

    #[test]
    fn a_replace_by_rename_is_reported() {
        // ほかのエディタの「一時ファイルに書いて rename」。
        let dir = TempDir::new();
        let doc = dir.0.join("a.md");
        fs::write(&doc, b"v1").unwrap();
        settle();
        let (n, cb) = counter();
        let w = DocumentWatcher::default();
        w.watch(Some(doc.clone()), cb).unwrap();

        let tmp = dir.0.join(".a.md.swp-tmp");
        fs::write(&tmp, b"v2").unwrap();
        fs::rename(&tmp, &doc).unwrap();

        assert!(wait_for(&n, 1), "the replacement was not reported");
    }

    #[test]
    fn a_delete_is_reported() {
        let dir = TempDir::new();
        let doc = dir.0.join("a.md");
        fs::write(&doc, b"v1").unwrap();
        settle();
        let (n, cb) = counter();
        let w = DocumentWatcher::default();
        w.watch(Some(doc.clone()), cb).unwrap();

        fs::remove_file(&doc).unwrap();

        assert!(wait_for(&n, 1), "the deletion was not reported");
    }

    #[test]
    fn other_files_in_the_same_directory_are_ignored() {
        let dir = TempDir::new();
        let doc = dir.0.join("a.md");
        fs::write(&doc, b"v1").unwrap();
        settle();
        let (n, cb) = counter();
        let w = DocumentWatcher::default();
        w.watch(Some(doc), cb).unwrap();

        fs::write(dir.0.join("other.md"), b"x").unwrap();
        fs::write(dir.0.join("other.md"), b"y").unwrap();
        thread::sleep(Duration::from_millis(1200));

        assert_eq!(n.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_burst_of_writes_is_coalesced() {
        let dir = TempDir::new();
        let doc = dir.0.join("a.md");
        fs::write(&doc, b"v0").unwrap();
        settle();
        let (n, cb) = counter();
        let w = DocumentWatcher::default();
        w.watch(Some(doc.clone()), cb).unwrap();

        for i in 0..10 {
            fs::write(&doc, format!("v{i}")).unwrap();
            thread::sleep(Duration::from_millis(10));
        }
        assert!(wait_for(&n, 1));
        thread::sleep(Duration::from_millis(800));

        let got = n.load(Ordering::SeqCst);
        assert!(got <= 2, "10 writes within ~100ms were reported {got} times");
    }

    #[test]
    fn switching_the_target_stops_the_previous_watch() {
        let dir = TempDir::new();
        let a = dir.0.join("a.md");
        let b = dir.0.join("b.md");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        settle();
        let (na, cba) = counter();
        let (nb, cbb) = counter();
        let w = DocumentWatcher::default();
        w.watch(Some(a.clone()), cba).unwrap();
        w.watch(Some(b.clone()), cbb).unwrap();

        fs::write(&a, b"a2").unwrap();
        thread::sleep(Duration::from_millis(1000));
        assert_eq!(na.load(Ordering::SeqCst), 0, "the old target must not be watched");

        fs::write(&b, b"b2").unwrap();
        assert!(wait_for(&nb, 1));

        // None で止まる。
        w.watch(None, |_| {}).unwrap();
        let before = nb.load(Ordering::SeqCst);
        fs::write(&b, b"b3").unwrap();
        thread::sleep(Duration::from_millis(1000));
        assert_eq!(nb.load(Ordering::SeqCst), before);
    }

    #[test]
    fn watching_a_file_in_a_missing_directory_is_an_error() {
        let dir = TempDir::new();
        let w = DocumentWatcher::default();
        assert!(w
            .watch(Some(dir.0.join("nope").join("a.md")), |_| {})
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_document_is_watched_through_its_real_location() {
        let dir = TempDir::new();
        let real_dir = dir.0.join("real");
        let link_dir = dir.0.join("links");
        fs::create_dir_all(&real_dir).unwrap();
        fs::create_dir_all(&link_dir).unwrap();
        let real = real_dir.join("note.md");
        let link = link_dir.join("note.md");
        fs::write(&real, b"v1").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        settle();
        let (n, cb) = counter();
        let w = DocumentWatcher::default();
        w.watch(Some(link), cb).unwrap();

        fs::write(&real, b"v2").unwrap();

        assert!(wait_for(&n, 1), "a change to the link target was not reported");
    }
}
