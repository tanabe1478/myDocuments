//! 開いている文書の外部変更の監視（DocumentWatcher）と、エクスプローラーのフォルダの監視（FolderWatcher）。
//!
//! 以下は DocumentWatcher の説明。
//! 文書そのものではなく親ディレクトリを監視する。ほかのエディタの多くは、一時ファイルを書いてから
//! rename で置き換えるため、ファイル自体を監視すると置き換えの後に追跡できなくなる。
//! 対象ファイルに関するイベントだけを選び、短い間に続いたものは 1 回にまとめて通知する。
//! 通知は「何かが変わったかもしれない」だけで、中身の判断（revision の比較）は呼び出し側がする。

use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::BTreeSet;
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

/// エクスプローラーが見せているフォルダ（ルートと展開中のフォルダ）の、項目の増減・名前の変更の監視。
/// 渡されたフォルダを 1 つずつ NonRecursive で監視する（見えていない深いところは監視しない）。
/// 文書の監視（DocumentWatcher）とは別に持つ。付け替えると、前の監視は止まる。
#[derive(Default)]
pub struct FolderWatcher {
    active: Mutex<Option<RecommendedWatcher>>,
}

impl FolderWatcher {
    /// `dirs` の監視に切り替える（空なら監視をやめる）。
    /// 項目の増減・名前の変更があったフォルダを、短い間に続いた分は 1 回にまとめて、
    /// フォルダごとに `on_change(dir)`（`dirs` で渡された形のパス）を別スレッドで呼ぶ。
    /// 既存の項目の中身の書き換えは、一覧が変わらないので通常は知らせない。ただし macOS の FSEvents は、
    /// 作られて数秒以内のファイルへの書き込みにも「作られた」の印を持ち越し、notify が Create として渡すため、
    /// その場合は知らせることがある（読み直しが 1 回増えるだけで害はない。抑え込むフィルタは足さない）。
    pub fn watch(
        &self,
        dirs: Vec<PathBuf>,
        on_change: impl Fn(PathBuf) + Send + 'static,
    ) -> notify::Result<()> {
        let mut slot = self.active.lock().unwrap_or_else(|e| e.into_inner());
        *slot = None;
        if dirs.is_empty() {
            return Ok(());
        }

        // (正規化したパス, 渡された形のパス)。イベントは正規化したパスで届く（macOS の /var → /private/var など）。
        let targets: Vec<(PathBuf, PathBuf)> = dirs
            .into_iter()
            .map(|given| (std::fs::canonicalize(&given).unwrap_or_else(|_| given.clone()), given))
            .collect();
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let filter = targets.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                for given in changed_folders(&filter, &event) {
                    let _ = tx.send(given);
                }
            }
        })?;
        let mut first_error = None;
        let mut watched = 0;
        for (canonical, _) in &targets {
            // 監視を始める前になくなったフォルダなど、1 つ失敗しても残りは監視する。
            match watcher.watch(canonical, RecursiveMode::NonRecursive) {
                Ok(()) => watched += 1,
                Err(e) => first_error = first_error.or(Some(e)),
            }
        }
        if watched == 0 {
            if let Some(e) = first_error {
                return Err(e);
            }
        }

        thread::spawn(move || {
            while let Ok(first_dir) = rx.recv() {
                let mut changed = BTreeSet::new();
                changed.insert(first_dir);
                let first = Instant::now();
                loop {
                    let left = MAX_WAIT.saturating_sub(first.elapsed()).min(QUIET);
                    if left.is_zero() {
                        break;
                    }
                    match rx.recv_timeout(left) {
                        Ok(dir) => {
                            changed.insert(dir);
                        }
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                for dir in changed {
                    on_change(dir);
                }
            }
        });

        *slot = Some(watcher);
        Ok(())
    }
}

/// 項目の増減・名前の変更か（一覧が変わるもの）。読み取りと、中身・属性の変更は含めない。
/// （macOS は作られて間もないファイルの書き込みを Create として渡すことがあり、それは通る。上の `watch` を参照。）
fn is_listing_change(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
    )
}

/// イベントのパスが、監視しているフォルダの直下の項目（またはフォルダ自身）なら、そのフォルダ（渡された形）。
fn changed_folders(targets: &[(PathBuf, PathBuf)], event: &Event) -> Vec<PathBuf> {
    if !is_listing_change(&event.kind) {
        return Vec::new();
    }
    let mut found = Vec::new();
    for path in &event.paths {
        let path = normalize(path);
        for (canonical, given) in targets {
            if (path.parent() == Some(canonical.as_path()) || &path == canonical) && !found.contains(given) {
                found.push(given.clone());
            }
        }
    }
    found
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

    // ---- FolderWatcher ----

    use std::sync::Mutex as StdMutex;

    fn collector() -> (Arc<StdMutex<Vec<PathBuf>>>, impl Fn(PathBuf) + Send + 'static) {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let seen2 = seen.clone();
        (seen, move |p| seen2.lock().unwrap().push(p))
    }

    fn wait_until(seen: &Arc<StdMutex<Vec<PathBuf>>>, pred: impl Fn(&[PathBuf]) -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(8) {
            if pred(&seen.lock().unwrap()) {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn a_new_item_a_removal_and_a_rename_are_reported_for_the_folder() {
        let dir = TempDir::new();
        fs::write(dir.0.join("old.md"), b"x").unwrap();
        fs::write(dir.0.join("gone.md"), b"x").unwrap();
        settle();
        let (seen, cb) = collector();
        let w = FolderWatcher::default();
        w.watch(vec![dir.0.clone()], cb).unwrap();

        fs::write(dir.0.join("new.md"), b"x").unwrap();
        assert!(wait_until(&seen, |s| s.contains(&dir.0)), "a new file was not reported");

        let before = seen.lock().unwrap().len();
        fs::remove_file(dir.0.join("gone.md")).unwrap();
        assert!(wait_until(&seen, |s| s.len() > before), "a removal was not reported");

        let before = seen.lock().unwrap().len();
        fs::rename(dir.0.join("old.md"), dir.0.join("renamed.md")).unwrap();
        assert!(wait_until(&seen, |s| s.len() > before), "a rename was not reported");

        let before = seen.lock().unwrap().len();
        fs::create_dir(dir.0.join("sub")).unwrap();
        assert!(wait_until(&seen, |s| s.len() > before), "a new folder was not reported");
        assert!(seen.lock().unwrap().iter().all(|p| p == &dir.0));
    }

    #[test]
    fn only_the_given_folders_are_watched_not_their_subfolders() {
        let dir = TempDir::new();
        let watched_sub = dir.0.join("watched");
        let other_sub = dir.0.join("other");
        fs::create_dir_all(&watched_sub).unwrap();
        fs::create_dir_all(&other_sub).unwrap();
        settle();
        let (seen, cb) = collector();
        let w = FolderWatcher::default();
        w.watch(vec![dir.0.clone(), watched_sub.clone()], cb).unwrap();

        // 監視していない深いフォルダの変更は知らせない。
        fs::write(other_sub.join("x.md"), b"x").unwrap();
        thread::sleep(Duration::from_millis(1200));
        assert!(seen.lock().unwrap().is_empty(), "{:?}", seen.lock().unwrap());

        // 監視しているサブフォルダの変更は、そのフォルダとして知らせる。
        fs::write(watched_sub.join("y.md"), b"y").unwrap();
        assert!(wait_until(&seen, |s| s.contains(&watched_sub)));
        assert!(!seen.lock().unwrap().contains(&other_sub));
    }

    /// 一覧が変わるイベントだけを通す（OS に依存しない、フィルタそのものの確認）。
    #[test]
    fn only_events_that_change_the_listing_pass_the_filter() {
        use notify::event::{AccessKind, CreateKind, DataChange, MetadataKind, RemoveKind, RenameMode};
        assert!(is_listing_change(&EventKind::Create(CreateKind::File)));
        assert!(is_listing_change(&EventKind::Create(CreateKind::Folder)));
        assert!(is_listing_change(&EventKind::Remove(RemoveKind::File)));
        assert!(is_listing_change(&EventKind::Modify(ModifyKind::Name(RenameMode::Any))));
        assert!(!is_listing_change(&EventKind::Modify(ModifyKind::Data(DataChange::Content))));
        assert!(!is_listing_change(&EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any))));
        assert!(!is_listing_change(&EventKind::Access(AccessKind::Any)));
    }

    /// 既存のファイルの中身の書き換えは、通常は知らせない。ただし macOS では、作られて数秒以内のファイルは
    /// Create として届くことがある（読み直しが増えるだけ）。OS に依存しない形で、知らせたとしても
    /// 監視しているフォルダ自身についてで、まとめて少ない回数であることだけを確かめる。
    #[test]
    fn rewriting_the_content_of_an_existing_file_reports_at_most_the_folder_itself() {
        let dir = TempDir::new();
        fs::write(dir.0.join("a.md"), b"v1").unwrap();
        settle();
        let (seen, cb) = collector();
        let w = FolderWatcher::default();
        w.watch(vec![dir.0.clone()], cb).unwrap();

        fs::write(dir.0.join("a.md"), b"v2").unwrap();
        thread::sleep(Duration::from_millis(1200));
        let got = seen.lock().unwrap();
        assert!(got.iter().all(|p| p == &dir.0), "{got:?}");
        assert!(got.len() <= 2, "a single rewrite was reported {} times", got.len());
    }

    #[test]
    fn a_burst_of_new_files_is_coalesced_per_folder() {
        let dir = TempDir::new();
        settle();
        let (seen, cb) = collector();
        let w = FolderWatcher::default();
        w.watch(vec![dir.0.clone()], cb).unwrap();

        for i in 0..10 {
            fs::write(dir.0.join(format!("f{i}.md")), b"x").unwrap();
            thread::sleep(Duration::from_millis(10));
        }
        assert!(wait_until(&seen, |s| !s.is_empty()));
        thread::sleep(Duration::from_millis(800));
        let got = seen.lock().unwrap().len();
        assert!(got <= 2, "10 new files within ~100ms were reported {got} times");
    }

    #[test]
    fn switching_the_folders_stops_the_previous_watch_and_an_empty_list_stops_all() {
        let dir = TempDir::new();
        let a = dir.0.join("a");
        let b = dir.0.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        settle();
        let (seen_a, cb_a) = collector();
        let (seen_b, cb_b) = collector();
        let w = FolderWatcher::default();
        w.watch(vec![a.clone()], cb_a).unwrap();
        w.watch(vec![b.clone()], cb_b).unwrap();

        fs::write(a.join("x.md"), b"x").unwrap();
        thread::sleep(Duration::from_millis(1000));
        assert!(seen_a.lock().unwrap().is_empty(), "the old folder must not be watched");

        fs::write(b.join("y.md"), b"y").unwrap();
        assert!(wait_until(&seen_b, |s| s.contains(&b)));

        w.watch(Vec::new(), |_| {}).unwrap();
        let before = seen_b.lock().unwrap().len();
        fs::write(b.join("z.md"), b"z").unwrap();
        thread::sleep(Duration::from_millis(1000));
        assert_eq!(seen_b.lock().unwrap().len(), before);
    }

    #[test]
    fn watching_only_a_missing_folder_is_an_error() {
        let dir = TempDir::new();
        let w = FolderWatcher::default();
        assert!(w.watch(vec![dir.0.join("nope")], |_| {}).is_err());
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
