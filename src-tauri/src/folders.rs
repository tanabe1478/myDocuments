//! エクスプローラーのフォルダ（開く・中身の一覧）。Tauri に依存しない部分。
//!
//! `open` が登録したフォルダと、その配下だけを `list` で読める。パスは canonicalize（`..` とシンボリックリンクを
//! 解決）してから、登録済みのフォルダの配下かを調べる。登録外のパス、`..` やシンボリックリンクで外へ出るパスは NotAllowed。

use crate::documents::validate_path;
use crate::error::{CommandError, ErrorKind};
use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 1 つのフォルダについて返す項目の上限（src/platform/DocumentBridge.ts の FOLDER_LISTING_LIMIT と同じ）。
pub const LIST_LIMIT: usize = 5000;

/// `open_folder` が許可したフォルダ（canonicalize 済み）。複数登録されてもよいが、ツリーが使うのは最後のもの。
#[derive(Default)]
pub struct OpenFolders(Mutex<Vec<PathBuf>>);

impl OpenFolders {
    /// 登録する。すでにあれば最後へ移す。
    pub fn register(&self, canonical: PathBuf) {
        if let Ok(mut list) = self.0.lock() {
            list.retain(|p| p != &canonical);
            list.push(canonical);
        }
    }

    /// canonicalize 済みのパスが、登録済みのフォルダ自身か、その配下か。
    /// `Path::starts_with` は成分ごとの比較なので、`/a/foo` は `/a/foobar` を許さない。
    pub fn allows(&self, canonical: &Path) -> bool {
        self.0
            .lock()
            .map(|list| list.iter().any(|root| canonical.starts_with(root)))
            .unwrap_or(false)
    }
}

/// フォルダの項目の種類。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EntryKindDto {
    /// ファイル（ファイルへのシンボリックリンクを含む）。
    File,
    Dir,
    /// フォルダへのシンボリックリンク。ループを避けるため、UI は展開しない。
    SymlinkDir,
    /// それ以外（壊れたシンボリックリンク、デバイスなど）。
    Other,
}

impl EntryKindDto {
    fn is_dir_like(self) -> bool {
        matches!(self, EntryKindDto::Dir | EntryKindDto::SymlinkDir)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntryDto {
    pub name: String,
    /// 絶対パス。呼び出し側が渡したパスに名前を足したもの（canonicalize した形ではない）。
    pub path: String,
    pub kind: EntryKindDto,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderListingDto {
    /// 並べ替えた後の先頭から、最大 `LIST_LIMIT` 件。
    pub entries: Vec<FolderEntryDto>,
    /// 隠し項目を除いた全件数。
    pub total: usize,
}

/// 存在するフォルダであることを確かめ、許可したフォルダとして登録する。
pub fn open(path: &str, folders: &OpenFolders) -> Result<(), CommandError> {
    let p = validate_path(path)?;
    let canonical = fs::canonicalize(&p)?;
    if !canonical.is_dir() {
        return Err(CommandError::new(
            ErrorKind::InvalidInput,
            "the path is not a folder",
        ));
    }
    // 読めないフォルダは、開く時点で PermissionDenied にする。
    fs::read_dir(&canonical)?;
    folders.register(canonical);
    Ok(())
}

/// 登録済みのフォルダ（またはその配下）の中身。隠し項目（名前がドットで始まるもの）は除く。
/// フォルダが先、その中は名前の自然順（大文字小文字を区別しない、数字は数として比べる）に並べ、先頭の `LIST_LIMIT` 件だけを返す。
pub fn list(path: &str, folders: &OpenFolders) -> Result<FolderListingDto, CommandError> {
    let p = validate_path(path)?;
    let canonical = fs::canonicalize(&p)?;
    if !folders.allows(&canonical) {
        return Err(CommandError::new(
            ErrorKind::NotAllowed,
            "the folder was not opened in this session",
        ));
    }
    if !canonical.is_dir() {
        return Err(CommandError::new(
            ErrorKind::InvalidInput,
            "the path is not a folder",
        ));
    }

    let mut entries = Vec::new();
    for item in fs::read_dir(&canonical)? {
        // 1 件だけ読めない項目があっても、ほかの項目は見せる。
        let Ok(item) = item else { continue };
        let file_name = item.file_name();
        let name = file_name.to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let kind = kind_of(&item);
        entries.push(FolderEntryDto {
            path: p.join(&file_name).to_string_lossy().into_owned(),
            name,
            kind,
        });
    }

    entries.sort_by(|a, b| {
        b.kind
            .is_dir_like()
            .cmp(&a.kind.is_dir_like())
            .then_with(|| natural_cmp(&a.name, &b.name))
            .then_with(|| a.name.cmp(&b.name))
    });
    let total = entries.len();
    entries.truncate(LIST_LIMIT);
    Ok(FolderListingDto { entries, total })
}

fn kind_of(item: &fs::DirEntry) -> EntryKindDto {
    let Ok(file_type) = item.file_type() else {
        return EntryKindDto::Other;
    };
    if file_type.is_symlink() {
        // リンク先を見る。壊れたリンクは Other。
        return match fs::metadata(item.path()) {
            Ok(m) if m.is_dir() => EntryKindDto::SymlinkDir,
            Ok(m) if m.is_file() => EntryKindDto::File,
            _ => EntryKindDto::Other,
        };
    }
    if file_type.is_dir() {
        EntryKindDto::Dir
    } else if file_type.is_file() {
        EntryKindDto::File
    } else {
        EntryKindDto::Other
    }
}

/// 名前の自然順。大文字小文字を区別せず、連続する数字は数として比べる（file2 < file10）。
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let na = take_digits(&mut ai);
                let nb = take_digits(&mut bi);
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                ai.next();
                bi.next();
                let (lx, ly) = (lower(x), lower(y));
                if lx != ly {
                    return lx.cmp(&ly);
                }
            }
        }
    }
}

fn lower(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

fn take_digits(it: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut digits = String::new();
    while let Some(&c) = it.peek() {
        if !c.is_ascii_digit() {
            break;
        }
        digits.push(c);
        it.next();
    }
    digits
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering as AtomicOrdering};

    static N: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ime-folders-{}-{}",
                std::process::id(),
                N.fetch_add(1, AtomicOrdering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }
        fn str(&self, rel: &str) -> String {
            self.path(rel).to_string_lossy().into_owned()
        }
        fn file(&self, rel: &str) {
            let p = self.path(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, b"x").unwrap();
        }
        fn dir(&self, rel: &str) {
            fs::create_dir_all(self.path(rel)).unwrap();
        }
        fn root(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn opened(dir: &TempDir) -> OpenFolders {
        let folders = OpenFolders::default();
        open(&dir.root(), &folders).unwrap();
        folders
    }

    fn names(listing: &FolderListingDto) -> Vec<&str> {
        listing.entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn folders_come_first_then_natural_order_ignoring_case() {
        let dir = TempDir::new();
        for f in ["file10.md", "file2.md", "File1.md", "b.txt", "A.txt", "007.md", "7a.md", "08.md"] {
            dir.file(f);
        }
        dir.dir("zeta");
        dir.dir("Alpha");
        dir.dir("dir10");
        dir.dir("dir9");
        let listing = list(&dir.root(), &opened(&dir)).unwrap();
        assert_eq!(
            names(&listing),
            vec![
                "Alpha", "dir9", "dir10", "zeta", // フォルダが先。dir9 < dir10（数として比べる）
                "007.md", "7a.md", "08.md", // 先頭ゼロは数の比較では無視する。7 < 8
                "A.txt", "b.txt", "File1.md", "file2.md", "file10.md",
            ]
        );
        assert_eq!(listing.total, 12);
    }

    #[test]
    fn hidden_entries_are_excluded_from_entries_and_total() {
        let dir = TempDir::new();
        dir.file("a.md");
        dir.file(".hidden.md");
        dir.dir(".git");
        dir.file(".git/config");
        dir.dir("visible");
        let listing = list(&dir.root(), &opened(&dir)).unwrap();
        assert_eq!(names(&listing), vec!["visible", "a.md"]);
        assert_eq!(listing.total, 2);
    }

    #[test]
    fn entries_report_kind_and_a_path_under_the_given_path() {
        let dir = TempDir::new();
        dir.file("a.md");
        dir.dir("sub");
        let listing = list(&dir.root(), &opened(&dir)).unwrap();
        assert_eq!(listing.entries[0].kind, EntryKindDto::Dir);
        assert_eq!(listing.entries[0].path, dir.str("sub"));
        assert_eq!(listing.entries[1].kind, EntryKindDto::File);
        assert_eq!(listing.entries[1].path, dir.str("a.md"));
        let json = serde_json::to_value(&listing.entries[0]).unwrap();
        assert_eq!(json["kind"], "dir");
        assert_eq!(serde_json::to_value(EntryKindDto::SymlinkDir).unwrap(), "symlinkDir");
    }

    #[test]
    fn more_than_the_limit_is_cut_after_sorting_and_total_is_reported() {
        let dir = TempDir::new();
        for i in 0..(LIST_LIMIT + 3) {
            dir.file(&format!("n{i:05}.md"));
        }
        dir.dir("last-sorted-but-a-folder");
        let listing = list(&dir.root(), &opened(&dir)).unwrap();
        assert_eq!(listing.entries.len(), LIST_LIMIT);
        assert_eq!(listing.total, LIST_LIMIT + 4);
        // 並べ替えた後の先頭が残る: フォルダ、次に n00000 から。
        assert_eq!(listing.entries[0].name, "last-sorted-but-a-folder");
        assert_eq!(listing.entries[1].name, "n00000.md");
        assert_eq!(listing.entries[LIST_LIMIT - 1].name, format!("n{:05}.md", LIST_LIMIT - 2));
    }

    #[test]
    fn exactly_the_limit_is_not_cut() {
        let dir = TempDir::new();
        for i in 0..LIST_LIMIT {
            dir.file(&format!("n{i:05}.md"));
        }
        let listing = list(&dir.root(), &opened(&dir)).unwrap();
        assert_eq!((listing.entries.len(), listing.total), (LIST_LIMIT, LIST_LIMIT));
    }

    #[test]
    fn a_subfolder_of_the_opened_folder_is_allowed() {
        let dir = TempDir::new();
        dir.file("sub/inner/a.md");
        let folders = opened(&dir);
        assert_eq!(names(&list(&dir.str("sub"), &folders).unwrap()), vec!["inner"]);
        assert_eq!(names(&list(&dir.str("sub/inner"), &folders).unwrap()), vec!["a.md"]);
        // 末尾の区切りや `.` を含む書き方でも、同じフォルダとして許す。
        assert!(list(&format!("{}/./sub/", dir.root()), &folders).is_ok());
    }

    #[test]
    fn paths_outside_the_opened_folder_are_not_allowed() {
        let dir = TempDir::new();
        dir.dir("root/sub");
        dir.dir("rootbar"); // 名前の前方一致だけでは許さない
        dir.dir("other");
        let folders = OpenFolders::default();
        open(&dir.str("root"), &folders).unwrap();

        for outside in [dir.str("other"), dir.str("rootbar"), dir.root()] {
            let err = list(&outside, &folders).unwrap_err();
            assert_eq!(err.kind, ErrorKind::NotAllowed, "{outside}");
        }
        // `..` で外へ出る。
        let err = list(&dir.str("root/sub/../../other"), &folders).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotAllowed);
        let err = list(&dir.str("root/.."), &folders).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotAllowed);
    }

    #[test]
    fn nothing_is_allowed_before_a_folder_is_opened() {
        let dir = TempDir::new();
        let err = list(&dir.root(), &OpenFolders::default()).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotAllowed);
    }

    #[test]
    fn several_folders_can_be_registered() {
        let dir = TempDir::new();
        dir.dir("a");
        dir.dir("b");
        dir.dir("c");
        let folders = OpenFolders::default();
        open(&dir.str("a"), &folders).unwrap();
        open(&dir.str("b"), &folders).unwrap();
        assert!(list(&dir.str("a"), &folders).is_ok());
        assert!(list(&dir.str("b"), &folders).is_ok());
        assert_eq!(list(&dir.str("c"), &folders).unwrap_err().kind, ErrorKind::NotAllowed);
    }

    #[test]
    fn open_rejects_missing_non_folder_and_relative_paths() {
        let dir = TempDir::new();
        dir.file("a.md");
        let folders = OpenFolders::default();
        assert_eq!(open(&dir.str("missing"), &folders).unwrap_err().kind, ErrorKind::NotFound);
        assert_eq!(open(&dir.str("a.md"), &folders).unwrap_err().kind, ErrorKind::InvalidInput);
        assert_eq!(open("relative/dir", &folders).unwrap_err().kind, ErrorKind::InvalidInput);
        assert_eq!(open("", &folders).unwrap_err().kind, ErrorKind::InvalidInput);
        // 失敗したものは登録されない。
        assert_eq!(list(&dir.root(), &folders).unwrap_err().kind, ErrorKind::NotAllowed);
    }

    #[test]
    fn list_reports_missing_and_non_folder_paths() {
        let dir = TempDir::new();
        dir.file("a.md");
        let folders = opened(&dir);
        assert_eq!(list(&dir.str("missing"), &folders).unwrap_err().kind, ErrorKind::NotFound);
        // フォルダの外のファイルは NotAllowed、中のファイルは InvalidInput。
        assert_eq!(list(&dir.str("a.md"), &folders).unwrap_err().kind, ErrorKind::InvalidInput);
        assert_eq!(list("relative", &folders).unwrap_err().kind, ErrorKind::InvalidInput);
    }

    #[cfg(unix)]
    mod unix {
        use super::*;
        use std::os::unix::fs::{symlink, PermissionsExt};

        #[test]
        fn symlinked_folders_files_and_broken_links_have_their_own_kinds() {
            let dir = TempDir::new();
            dir.file("real/inner.md");
            dir.file("target.md");
            symlink(dir.path("real"), dir.path("link-dir")).unwrap();
            symlink(dir.path("target.md"), dir.path("link-file.md")).unwrap();
            symlink(dir.path("nowhere"), dir.path("broken")).unwrap();
            let listing = list(&dir.root(), &opened(&dir)).unwrap();
            let kind = |n: &str| listing.entries.iter().find(|e| e.name == n).unwrap().kind;
            assert_eq!(kind("real"), EntryKindDto::Dir);
            assert_eq!(kind("link-dir"), EntryKindDto::SymlinkDir);
            assert_eq!(kind("link-file.md"), EntryKindDto::File);
            assert_eq!(kind("broken"), EntryKindDto::Other);
            // フォルダ（リンクを含む）が先に並ぶ。
            assert_eq!(names(&listing)[..2], ["link-dir", "real"]);
        }

        #[test]
        fn a_symlink_pointing_outside_the_opened_folder_is_not_allowed() {
            let dir = TempDir::new();
            dir.file("outside/secret.md");
            dir.dir("root");
            symlink(dir.path("outside"), dir.path("root/escape")).unwrap();
            let folders = OpenFolders::default();
            open(&dir.str("root"), &folders).unwrap();
            // 一覧にはリンクとして出るが、中は読めない。
            let listing = list(&dir.str("root"), &folders).unwrap();
            assert_eq!(listing.entries[0].kind, EntryKindDto::SymlinkDir);
            let err = list(&dir.str("root/escape"), &folders).unwrap_err();
            assert_eq!(err.kind, ErrorKind::NotAllowed);
            // リンクの先の、さらに奥も同じ。
            let err = list(&dir.str("root/escape/../outside"), &folders).unwrap_err();
            assert_eq!(err.kind, ErrorKind::NotAllowed);
        }

        #[test]
        fn a_symlink_to_a_folder_inside_the_opened_folder_is_allowed() {
            let dir = TempDir::new();
            dir.file("root/real/a.md");
            symlink(dir.path("root/real"), dir.path("root/alias")).unwrap();
            let folders = OpenFolders::default();
            open(&dir.str("root"), &folders).unwrap();
            assert_eq!(names(&list(&dir.str("root/alias"), &folders).unwrap()), vec!["a.md"]);
        }

        #[test]
        fn opening_through_a_symlink_registers_the_real_folder() {
            let dir = TempDir::new();
            dir.file("real/sub/a.md");
            symlink(dir.path("real"), dir.path("alias")).unwrap();
            let folders = OpenFolders::default();
            open(&dir.str("alias"), &folders).unwrap();
            assert!(list(&dir.str("alias/sub"), &folders).is_ok());
            assert!(list(&dir.str("real/sub"), &folders).is_ok());
        }

        #[test]
        fn an_unreadable_folder_is_permission_denied() {
            let dir = TempDir::new();
            dir.file("root/locked/a.md");
            let locked = dir.path("root/locked");
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
            let folders = OpenFolders::default();
            open(&dir.str("root"), &folders).unwrap();
            let result = list(&dir.str("root/locked"), &folders);
            // 後片付けのため、権限を戻してから判定する。
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
            // root で動いている環境では、権限の制限が効かない。
            if let Err(err) = result {
                assert_eq!(err.kind, ErrorKind::PermissionDenied);
            }
        }
    }

    #[test]
    fn natural_order_is_case_insensitive_and_numeric() {
        assert_eq!(natural_cmp("a2", "a10"), Ordering::Less);
        assert_eq!(natural_cmp("A", "a"), Ordering::Equal);
        assert_eq!(natural_cmp("a", "B"), Ordering::Less);
        assert_eq!(natural_cmp("a", "a1"), Ordering::Less);
        assert_eq!(natural_cmp("a01", "a1"), Ordering::Equal);
        assert_eq!(natural_cmp("あ2", "あ10"), Ordering::Less);
    }
}
