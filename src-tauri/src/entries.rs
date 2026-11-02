//! エクスプローラーからの作成・名前の変更・ゴミ箱への移動。Tauri に依存しない部分。
//!
//! どの操作も、対象の親フォルダを canonicalize（`..` とシンボリックリンクを解決）してから、`open_folder` が
//! 登録したフォルダの配下かを調べる（登録外、`..`、シンボリックリンクで外へ出るものは NotAllowed）。
//! 操作はリンク先ではなく、「canonicalize した親フォルダ + 名前」の項目そのものに効かせる
//! （シンボリックリンクは、リンク自体を名前変更・ゴミ箱へ移す）。登録したフォルダ（ルート）自身は、名前の変更もゴミ箱への移動もしない。
//! 確認してから操作するまでの間に、別のプロセスが親フォルダを差し替える競合は防げない（docs/decision-003 の限界）。

use crate::documents::{validate_path, KnownPaths};
use crate::error::{CommandError, ErrorKind};
use crate::folders::OpenFolders;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// 一度に監視するフォルダの数の上限（inotify などの監視の数に限りがあるため）。超えた分は監視しない。
pub const MAX_WATCHED_FOLDERS: usize = 256;

fn invalid(message: &str) -> CommandError {
    CommandError::new(ErrorKind::InvalidInput, message)
}

fn not_allowed(message: &str) -> CommandError {
    CommandError::new(ErrorKind::NotAllowed, message)
}

/// 新しい名前の検査。1 つのパス成分だけを受け付ける。
/// 拒否: 空・空白だけ、`/` や `\` を含む、`.` と `..`、ドットで始まる（ツリーに出なくなる）、
/// Windows で使えない文字（`<>:"|?*` と制御文字）、末尾のドットと空白。
/// OS によらず同じ規則にする（フォルダを別の OS へ持ち出しても、名前で困らないように）。
/// フロントエンド（src/explorer/names.ts）にも同じ規則があり、こちらが正本。
pub fn validate_name(name: &str) -> Result<(), CommandError> {
    if name.trim().is_empty() {
        return Err(invalid("the name is empty"));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(invalid("the name must not contain a path separator"));
    }
    if name == "." || name == ".." {
        return Err(invalid("the name must not be . or .."));
    }
    if name.starts_with('.') {
        return Err(invalid("the name must not start with a dot"));
    }
    if name.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c)) {
        return Err(invalid("the name contains a character that cannot be used"));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(invalid("the name must not end with a dot or a space"));
    }
    Ok(())
}

/// 親にするフォルダを canonicalize し、登録済みのフォルダの配下であることを確かめる。
fn resolve_dir(dir: &Path, folders: &OpenFolders) -> Result<PathBuf, CommandError> {
    let canonical = fs::canonicalize(dir)?;
    if !folders.allows(&canonical) {
        return Err(not_allowed("the folder was not opened in this session"));
    }
    if !canonical.is_dir() {
        return Err(invalid("the path is not a folder"));
    }
    Ok(canonical)
}

/// 既存の項目を指すパスの解決結果。
struct Item {
    /// 呼び出し側が渡した形の親フォルダ（戻り値のパスはこの形で作る）。
    given_parent: PathBuf,
    name: OsString,
    /// canonicalize した親フォルダ + 名前。操作はこの項目に効かせる。
    item: PathBuf,
}

fn resolve_item(path: &str, folders: &OpenFolders) -> Result<Item, CommandError> {
    let given = validate_path(path)?;
    let (Some(parent), Some(name)) = (given.parent(), given.file_name()) else {
        // `..` で終わるパスや、ルートそのもの。
        return Err(not_allowed("the path does not name an item inside an opened folder"));
    };
    let canonical_parent = resolve_dir(parent, folders)?;
    let item = canonical_parent.join(name);
    // リンクは辿らない（リンク自体が項目）。
    fs::symlink_metadata(&item)?;
    Ok(Item {
        given_parent: parent.to_path_buf(),
        name: name.to_os_string(),
        item,
    })
}

fn path_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

/// 作成の失敗を、フロントエンドへ返すエラーにする。
/// Windows は、同名のフォルダがある場所へ `create_new` でファイルを作ろうとすると、AlreadyExists ではなく
/// PermissionDenied（ERROR_ACCESS_DENIED）を返す。PermissionDenied のとき、作ろうとした項目が実際にあれば
/// （リンクは辿らない）AlreadyExists にする。無ければ権限の問題なので PermissionDenied のまま。ほかの種類は変えない。
/// macOS と Linux は元から AlreadyExists を返すので、この変換は働かない。
fn creation_error(error: io::Error, target: &Path) -> CommandError {
    if error.kind() == io::ErrorKind::PermissionDenied && fs::symlink_metadata(target).is_ok() {
        return CommandError::new(ErrorKind::AlreadyExists, "an item with that name already exists");
    }
    error.into()
}

/// `parent`（登録済みのフォルダの配下）に空のファイルを作る。既にあれば AlreadyExists（上書きしない）。戻り値は新しいパス。
pub fn create_file(parent: &str, name: &str, folders: &OpenFolders) -> Result<String, CommandError> {
    validate_name(name)?;
    let given = validate_path(parent)?;
    let canonical = resolve_dir(&given, folders)?;
    let target = canonical.join(name);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| creation_error(e, &target))?;
    Ok(path_string(given.join(name)))
}

/// `parent`（登録済みのフォルダの配下）にフォルダを作る。既にあれば AlreadyExists。戻り値は新しいパス。
pub fn create_folder(parent: &str, name: &str, folders: &OpenFolders) -> Result<String, CommandError> {
    validate_name(name)?;
    let given = validate_path(parent)?;
    let canonical = resolve_dir(&given, folders)?;
    let target = canonical.join(name);
    fs::create_dir(&target).map_err(|e| creation_error(e, &target))?;
    Ok(path_string(given.join(name)))
}

/// 同じ項目か（大文字小文字を区別しない FS で、`a.md` と `A.md` が同じ項目を指すか）。
#[cfg(unix)]
fn same_entry(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_entry(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// 項目の名前を変える（同じフォルダの中で）。既存の別の項目は上書きしない（AlreadyExists）。
/// 大文字小文字だけの変更は、FS が区別しなくても通す。戻り値は新しいパス。
/// 名前を変えた項目が登録済みの文書（またはそれを含むフォルダ）なら、新しいパスも `known` に登録する。
pub fn rename_entry(
    path: &str,
    new_name: &str,
    folders: &OpenFolders,
    known: &KnownPaths,
) -> Result<String, CommandError> {
    validate_name(new_name)?;
    let given = validate_path(path)?;
    let Item {
        given_parent,
        name,
        item,
    } = resolve_item(path, folders)?;
    if folders.is_root(&item) {
        return Err(not_allowed("an opened folder itself cannot be renamed"));
    }
    if name == OsString::from(new_name) {
        return Ok(path_string(given));
    }

    let target = item.with_file_name(new_name);
    match fs::symlink_metadata(&target) {
        Ok(_) => {
            // 大文字小文字だけの違いで、同じ項目を指すときだけ通す（ほかの項目は上書きしない）。
            let case_only = name.to_string_lossy().to_lowercase() == new_name.to_lowercase();
            if !(case_only && same_entry(&item, &target)) {
                return Err(CommandError::new(
                    ErrorKind::AlreadyExists,
                    "an item with that name already exists",
                ));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    fs::rename(&item, &target)?;

    let new_path = given_parent.join(new_name);
    known.register_renamed(&given, &new_path);
    Ok(path_string(new_path))
}

/// ゴミ箱へ移す処理。テストでは差し替える。
pub type Trasher<'a> = &'a dyn Fn(&Path) -> Result<(), String>;

/// 項目をゴミ箱へ移す。登録したフォルダ自身は移さない（NotAllowed）。
/// `trasher` には、canonicalize した親フォルダ + 名前（リンクならリンク自体）を渡す。
pub fn trash_entry(path: &str, folders: &OpenFolders, trasher: Trasher<'_>) -> Result<(), CommandError> {
    let Item { item, .. } = resolve_item(path, folders)?;
    if folders.is_root(&item) {
        return Err(not_allowed("an opened folder itself cannot be moved to the trash"));
    }
    trasher(&item).map_err(|message| CommandError::new(ErrorKind::Io, message))
}

/// OS のゴミ箱へ移す。macOS は Finder を操作しない NSFileManager の方式（Finder の方式は、自動化の許可を求め、音が鳴る）。
/// どの OS でも、シンボリックリンクはリンク自体を移す（trash クレートの仕様）。
#[cfg(target_os = "macos")]
pub fn system_trash(path: &Path) -> Result<(), String> {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut context = trash::TrashContext::default();
    context.set_delete_method(DeleteMethod::NsFileManager);
    context.delete(path).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn system_trash(path: &Path) -> Result<(), String> {
    trash::delete(path).map_err(|e| e.to_string())
}

/// 監視するフォルダの検査。登録済みのフォルダの配下だけを受け付け（それ以外は NotAllowed）、
/// なくなったフォルダ・フォルダでないものは除く。重複も除き、`MAX_WATCHED_FOLDERS` 件までにする。
/// 戻り値は、渡された形のパス。
pub fn resolve_watch_dirs(paths: &[String], folders: &OpenFolders) -> Result<Vec<PathBuf>, CommandError> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for path in paths {
        let given = validate_path(path)?;
        let canonical = match fs::canonicalize(&given) {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        if !folders.allows(&canonical) {
            return Err(not_allowed("the folder was not opened in this session"));
        }
        if canonical.is_dir() && !dirs.contains(&given) {
            dirs.push(given);
        }
    }
    dirs.truncate(MAX_WATCHED_FOLDERS);
    Ok(dirs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::folders;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    /// テストのパスは、すべて一時ディレクトリから作る（OS ごとの絶対パスの書き方を直書きしない）。
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ime-entries-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        /// `rel` は `/` 区切りで書き、成分ごとに join する（`/` を含む文字列をそのまま join すると、
        /// Windows では `\` と `/` が混ざったパスになる）。
        fn path(&self, rel: &str) -> PathBuf {
            rel.split('/').fold(self.0.clone(), |path, component| path.join(component))
        }
        fn str(&self, rel: &str) -> String {
            self.path(rel).to_string_lossy().into_owned()
        }
        /// `rel` から `..` を `ups` 回たどり、`rest`（`/` 区切り。空なら足さない）を続けたパス。成分ごとに組み立てる。
        fn parent_of(&self, rel: &str, ups: usize, rest: &str) -> String {
            let mut path = self.path(rel);
            for _ in 0..ups {
                path.push("..");
            }
            for component in rest.split('/').filter(|c| !c.is_empty()) {
                path.push(component);
            }
            path.to_string_lossy().into_owned()
        }
        fn file(&self, rel: &str, content: &str) {
            let p = self.path(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, content).unwrap();
        }
        fn dir(&self, rel: &str) {
            fs::create_dir_all(self.path(rel)).unwrap();
        }
        fn read(&self, rel: &str) -> String {
            fs::read_to_string(self.path(rel)).unwrap()
        }
        fn exists(&self, rel: &str) -> bool {
            fs::symlink_metadata(self.path(rel)).is_ok()
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// `root` を開いたフォルダとして登録する。
    fn opened(dir: &TempDir, root: &str) -> OpenFolders {
        dir.dir(root);
        let folders = OpenFolders::default();
        folders::open(&dir.str(root), &folders).unwrap();
        folders
    }

    fn kind<T: std::fmt::Debug>(result: Result<T, CommandError>) -> ErrorKind {
        result.unwrap_err().kind
    }

    /// ゴミ箱の代わり。渡された対象を記録する。
    fn recorder() -> (Rc<RefCell<Vec<PathBuf>>>, impl Fn(&Path) -> Result<(), String>) {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let calls_ref = calls.clone();
        (calls, move |p: &Path| {
            calls_ref.borrow_mut().push(p.to_path_buf());
            Ok(())
        })
    }

    // ---- 名前 ----

    #[test]
    fn names_that_are_not_a_single_plain_path_component_are_rejected() {
        for bad in [
            "", " ", "   ", "\t", ".", "..", "a/b", "a\\b", "/", "\\", ".hidden", ".md", "a.", "a ", "a:b", "a<b", "a>b",
            "a\"b", "a|b", "a?b", "a*b", "a\nb", "a\0b", "a\u{7f}b",
        ] {
            assert_eq!(kind(validate_name(bad)), ErrorKind::InvalidInput, "{bad:?}");
        }
    }

    #[test]
    fn ordinary_names_are_accepted() {
        for good in ["a.md", "メモ.md", "my notes", "a b.txt", "x", "a.b.c", "日本語の名前", "a-b_c (1).md", "ab"] {
            assert!(validate_name(good).is_ok(), "{good:?}");
        }
    }

    // ---- 作成 ----

    #[test]
    fn create_file_makes_an_empty_file_and_returns_its_path() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.dir("root/sub");
        let path = create_file(&dir.str("root/sub"), "new.md", &folders).unwrap();
        assert_eq!(path, dir.str("root/sub/new.md"));
        assert_eq!(dir.read("root/sub/new.md"), "");
        // ルート自身の直下にも作れる。
        assert!(create_file(&dir.str("root"), "top.md", &folders).is_ok());
    }

    #[test]
    fn create_file_never_overwrites_an_existing_item() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "keep me");
        dir.dir("root/folder");
        assert_eq!(kind(create_file(&dir.str("root"), "a.md", &folders)), ErrorKind::AlreadyExists);
        assert_eq!(kind(create_file(&dir.str("root"), "folder", &folders)), ErrorKind::AlreadyExists);
        assert_eq!(dir.read("root/a.md"), "keep me");
    }

    #[test]
    fn create_folder_makes_a_folder_and_does_not_reuse_an_existing_one() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/f.md", "x");
        let path = create_folder(&dir.str("root"), "sub", &folders).unwrap();
        assert_eq!(path, dir.str("root/sub"));
        assert!(dir.path("root/sub").is_dir());
        assert_eq!(kind(create_folder(&dir.str("root"), "sub", &folders)), ErrorKind::AlreadyExists);
        assert_eq!(kind(create_folder(&dir.str("root"), "f.md", &folders)), ErrorKind::AlreadyExists);
    }

    // ---- 作成の失敗の変換（Windows は、同名のフォルダがあると PermissionDenied を返す） ----

    fn io_error(kind: io::ErrorKind) -> io::Error {
        io::Error::from(kind)
    }

    #[test]
    fn a_permission_error_for_an_item_that_exists_becomes_already_exists() {
        let dir = TempDir::new();
        dir.file("a.md", "x");
        dir.dir("folder");
        for rel in ["a.md", "folder"] {
            let err = creation_error(io_error(io::ErrorKind::PermissionDenied), &dir.path(rel));
            assert_eq!(err.kind, ErrorKind::AlreadyExists, "{rel}");
        }
    }

    #[test]
    fn a_permission_error_for_an_item_that_does_not_exist_stays_a_permission_error() {
        let dir = TempDir::new();
        let err = creation_error(io_error(io::ErrorKind::PermissionDenied), &dir.path("missing.md"));
        assert_eq!(err.kind, ErrorKind::PermissionDenied);
        // 親が無くても（確かめる項目がなくても）権限のエラーのまま。
        let err = creation_error(io_error(io::ErrorKind::PermissionDenied), &dir.path("no/such/dir/x.md"));
        assert_eq!(err.kind, ErrorKind::PermissionDenied);
    }

    #[test]
    fn other_errors_are_not_changed_even_when_the_item_exists() {
        let dir = TempDir::new();
        dir.file("a.md", "x");
        for kind in [
            io::ErrorKind::NotFound,
            io::ErrorKind::AlreadyExists,
            io::ErrorKind::InvalidInput,
            io::ErrorKind::Other,
        ] {
            let expected = CommandError::from(io_error(kind));
            assert_eq!(creation_error(io_error(kind), &dir.path("a.md")), expected, "{kind:?}");
        }
    }

    #[test]
    fn create_rejects_invalid_names_and_creates_nothing() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        for bad in ["", "..", "a/b", ".x", "a:b"] {
            assert_eq!(kind(create_file(&dir.str("root"), bad, &folders)), ErrorKind::InvalidInput);
            assert_eq!(kind(create_folder(&dir.str("root"), bad, &folders)), ErrorKind::InvalidInput);
        }
        assert_eq!(fs::read_dir(dir.path("root")).unwrap().count(), 0);
        assert!(!dir.exists("a"));
    }

    #[test]
    fn create_outside_the_opened_folders_is_not_allowed() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.dir("other");
        dir.dir("rootbar");
        for outside in [dir.str("other"), dir.str("rootbar"), dir.0.to_string_lossy().into_owned()] {
            assert_eq!(kind(create_file(&outside, "x.md", &folders)), ErrorKind::NotAllowed, "{outside}");
            assert_eq!(kind(create_folder(&outside, "x", &folders)), ErrorKind::NotAllowed, "{outside}");
        }
        // `..` で外へ出る。
        dir.dir("root/sub");
        let escape = dir.parent_of("root/sub", 2, "other");
        assert_eq!(kind(create_file(&escape, "x.md", &folders)), ErrorKind::NotAllowed);
        assert!(!dir.exists("other/x.md"));
        // 何も開いていない。
        assert_eq!(
            kind(create_file(&dir.str("root"), "x.md", &OpenFolders::default())),
            ErrorKind::NotAllowed
        );
    }

    #[test]
    fn create_reports_a_missing_parent_a_file_parent_and_a_relative_path() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "x");
        assert_eq!(kind(create_file(&dir.str("root/missing"), "x.md", &folders)), ErrorKind::NotFound);
        assert_eq!(kind(create_file(&dir.str("root/a.md"), "x.md", &folders)), ErrorKind::InvalidInput);
        assert_eq!(kind(create_file("relative", "x.md", &folders)), ErrorKind::InvalidInput);
    }

    // ---- 名前の変更 ----

    #[test]
    fn rename_moves_the_item_and_returns_the_new_path() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "hello");
        let known = KnownPaths::default();
        let new_path = rename_entry(&dir.str("root/a.md"), "b.md", &folders, &known).unwrap();
        assert_eq!(new_path, dir.str("root/b.md"));
        assert_eq!(dir.read("root/b.md"), "hello");
        assert!(!dir.exists("root/a.md"));
    }

    #[test]
    fn rename_never_overwrites_another_item() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "A");
        dir.file("root/b.md", "B");
        dir.dir("root/sub");
        let known = KnownPaths::default();
        assert_eq!(kind(rename_entry(&dir.str("root/a.md"), "b.md", &folders, &known)), ErrorKind::AlreadyExists);
        assert_eq!(kind(rename_entry(&dir.str("root/a.md"), "sub", &folders, &known)), ErrorKind::AlreadyExists);
        assert_eq!(kind(rename_entry(&dir.str("root/sub"), "b.md", &folders, &known)), ErrorKind::AlreadyExists);
        assert_eq!((dir.read("root/a.md"), dir.read("root/b.md")), ("A".into(), "B".into()));
        assert!(dir.path("root/sub").is_dir());
    }

    #[test]
    fn rename_to_the_same_name_changes_nothing() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "A");
        let known = KnownPaths::default();
        let path = rename_entry(&dir.str("root/a.md"), "a.md", &folders, &known).unwrap();
        assert_eq!(path, dir.str("root/a.md"));
        assert_eq!(dir.read("root/a.md"), "A");
    }

    #[test]
    fn a_change_of_letter_case_only_is_allowed_even_when_the_filesystem_ignores_case() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/note.md", "N");
        dir.dir("root/Docs");
        let known = KnownPaths::default();
        let path = rename_entry(&dir.str("root/note.md"), "NOTE.md", &folders, &known).unwrap();
        assert_eq!(path, dir.str("root/NOTE.md"));
        rename_entry(&dir.str("root/Docs"), "docs", &folders, &known).unwrap();
        let names: Vec<String> = fs::read_dir(dir.path("root"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"NOTE.md".to_string()), "{names:?}");
        assert!(names.contains(&"docs".to_string()), "{names:?}");
        assert_eq!(names.len(), 2);
        assert_eq!(dir.read("root/NOTE.md"), "N");
    }

    #[test]
    fn a_different_item_whose_name_differs_only_in_case_is_not_overwritten() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "lower");
        // 大文字小文字を区別する FS でだけ、別の項目として並べられる。
        fs::write(dir.path("root/A.md"), "upper").unwrap();
        let case_sensitive = fs::read_to_string(dir.path("root/a.md")).unwrap() == "lower";
        if !case_sensitive {
            return;
        }
        let known = KnownPaths::default();
        assert_eq!(kind(rename_entry(&dir.str("root/a.md"), "A.md", &folders, &known)), ErrorKind::AlreadyExists);
        assert_eq!((dir.read("root/a.md"), dir.read("root/A.md")), ("lower".into(), "upper".into()));
    }

    #[test]
    fn rename_registers_the_new_path_of_a_known_document_and_of_documents_inside_a_renamed_folder() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "x");
        dir.file("root/sub/deep/b.md", "y");
        dir.file("root/other.md", "z");
        let known = KnownPaths::default();
        for p in ["root/a.md", "root/sub/deep/b.md", "root/other.md"] {
            known.register(&dir.path(p));
        }

        rename_entry(&dir.str("root/a.md"), "renamed.md", &folders, &known).unwrap();
        assert!(known.contains(&dir.path("root/renamed.md")));

        rename_entry(&dir.str("root/sub"), "moved", &folders, &known).unwrap();
        assert!(known.contains(&dir.path("root/moved/deep/b.md")));
        // 無関係な文書は増えない。
        assert!(!known.contains(&dir.path("root/renamed-other.md")));
        assert!(!known.contains(&dir.path("root/moved/other.md")));
    }

    #[test]
    fn a_failed_rename_registers_nothing() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "x");
        dir.file("root/b.md", "x");
        let known = KnownPaths::default();
        known.register(&dir.path("root/a.md"));
        assert!(rename_entry(&dir.str("root/a.md"), "b.md", &folders, &known).is_err());
        assert!(!known.contains(&dir.path("root/b.md")));
    }

    #[test]
    fn rename_rejects_invalid_names_and_keeps_the_item() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "x");
        let known = KnownPaths::default();
        for bad in ["", "..", "a/b", "../x", ".hidden", "a.", "a:b"] {
            assert_eq!(kind(rename_entry(&dir.str("root/a.md"), bad, &folders, &known)), ErrorKind::InvalidInput);
        }
        assert_eq!(dir.read("root/a.md"), "x");
    }

    #[test]
    fn the_opened_folder_itself_cannot_be_renamed() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        let known = KnownPaths::default();
        assert_eq!(kind(rename_entry(&dir.str("root"), "renamed", &folders, &known)), ErrorKind::NotAllowed);
        assert!(dir.path("root").is_dir());
        assert!(!dir.exists("renamed"));

        // 登録したフォルダが、別の登録したフォルダの中にあっても、ルートとして守る。
        dir.dir("root/inner");
        folders::open(&dir.str("root/inner"), &folders).unwrap();
        assert_eq!(kind(rename_entry(&dir.str("root/inner"), "x", &folders, &known)), ErrorKind::NotAllowed);
        assert!(dir.path("root/inner").is_dir());
    }

    #[test]
    fn rename_outside_the_opened_folders_is_not_allowed() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("other/x.md", "x");
        dir.file("root/sub/y.md", "y");
        let known = KnownPaths::default();
        assert_eq!(kind(rename_entry(&dir.str("other/x.md"), "z.md", &folders, &known)), ErrorKind::NotAllowed);
        let escape = dir.parent_of("root/sub", 2, "other/x.md");
        assert_eq!(kind(rename_entry(&escape, "z.md", &folders, &known)), ErrorKind::NotAllowed);
        // `..` で終わるパス。
        assert_eq!(
            kind(rename_entry(&dir.parent_of("root/sub", 1, ""), "z", &folders, &known)),
            ErrorKind::NotAllowed
        );
        assert!(dir.exists("other/x.md") && !dir.exists("other/z.md"));
    }

    #[test]
    fn rename_reports_a_missing_item_and_a_relative_path() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        let known = KnownPaths::default();
        assert_eq!(kind(rename_entry(&dir.str("root/missing.md"), "b.md", &folders, &known)), ErrorKind::NotFound);
        assert_eq!(kind(rename_entry("relative.md", "b.md", &folders, &known)), ErrorKind::InvalidInput);
    }

    // ---- ゴミ箱 ----

    #[test]
    fn trash_hands_the_item_under_the_canonical_parent_to_the_trasher() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/sub/a.md", "x");
        let (calls, trasher) = recorder();
        trash_entry(&dir.str("root/sub/a.md"), &folders, &trasher).unwrap();
        let expected = fs::canonicalize(dir.path("root/sub")).unwrap().join("a.md");
        assert_eq!(*calls.borrow(), vec![expected]);
        // 差し替えた処理は何も消さない。実際の移動は trasher の仕事。
        assert!(dir.exists("root/sub/a.md"));

        // フォルダも同じ。
        trash_entry(&dir.str("root/sub"), &folders, &trasher).unwrap();
        assert_eq!(calls.borrow().len(), 2);
        assert_eq!(calls.borrow()[1], fs::canonicalize(dir.path("root")).unwrap().join("sub"));
    }

    #[test]
    fn trash_refuses_the_root_outside_paths_and_missing_items_without_calling_the_trasher() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "x");
        dir.file("other/o.md", "x");
        dir.dir("root/inner");
        folders::open(&dir.str("root/inner"), &folders).unwrap();
        let (calls, trasher) = recorder();

        assert_eq!(kind(trash_entry(&dir.str("root"), &folders, &trasher)), ErrorKind::NotAllowed);
        assert_eq!(kind(trash_entry(&dir.str("root/inner"), &folders, &trasher)), ErrorKind::NotAllowed);
        assert_eq!(kind(trash_entry(&dir.str("other/o.md"), &folders, &trasher)), ErrorKind::NotAllowed);
        assert_eq!(
            kind(trash_entry(&dir.parent_of("root/inner", 2, "other/o.md"), &folders, &trasher)),
            ErrorKind::NotAllowed
        );
        assert_eq!(kind(trash_entry(&dir.str("root/missing.md"), &folders, &trasher)), ErrorKind::NotFound);
        assert_eq!(kind(trash_entry("relative.md", &folders, &trasher)), ErrorKind::InvalidInput);
        assert_eq!(kind(trash_entry(&dir.str("root/a.md"), &OpenFolders::default(), &trasher)), ErrorKind::NotAllowed);
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn a_failure_of_the_trasher_is_reported_as_io() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "x");
        let failing = |_: &Path| Err::<(), String>("the trash is not available".to_string());
        let err = trash_entry(&dir.str("root/a.md"), &folders, &failing).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Io);
        assert!(err.message.contains("the trash is not available"));
        assert!(dir.exists("root/a.md"));
    }

    /// 本物のゴミ箱へ移す。手元の環境のゴミ箱を汚さないよう、IME_TEST_REAL_TRASH=1 のとき（CI）だけ動かす。
    /// 失敗したときは、ゴミ箱が使えない理由（OS のエラー）を出力する（Linux のランナーでは、ゴミ箱の場所が使えないことがある）。
    #[test]
    fn real_trash_moves_a_file_and_a_folder_out_of_the_opened_folder() {
        if std::env::var("IME_TEST_REAL_TRASH").as_deref() != Ok("1") {
            eprintln!("skipped: set IME_TEST_REAL_TRASH=1 to move items to the real trash");
            return;
        }
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/trash-me.md", "x");
        dir.file("root/trash-folder/inner.md", "y");
        for rel in ["root/trash-me.md", "root/trash-folder"] {
            let result = trash_entry(&dir.str(rel), &folders, &system_trash);
            if let Err(e) = &result {
                eprintln!("the real trash failed for {rel}: kind={:?} message={}", e.kind, e.message);
            }
            result.unwrap_or_else(|e| panic!("the real trash is not usable: {} ({:?})", e.message, e.kind));
            assert!(!dir.exists(rel), "{rel} is still in the folder after it was moved to the trash");
        }
    }

    // ---- 監視するフォルダの検査 ----

    #[test]
    fn watch_dirs_keep_allowed_folders_and_skip_vanished_ones_and_files() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.dir("root/a");
        dir.file("root/f.md", "x");
        let paths = vec![
            dir.str("root"),
            dir.str("root/a"),
            dir.str("root/a"),
            dir.str("root/gone"),
            dir.str("root/f.md"),
        ];
        let dirs = resolve_watch_dirs(&paths, &folders).unwrap();
        assert_eq!(dirs, vec![dir.path("root"), dir.path("root/a")]);
    }

    #[test]
    fn watch_dirs_reject_a_folder_outside_the_opened_ones() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.dir("other");
        assert_eq!(
            kind(resolve_watch_dirs(&[dir.str("root"), dir.str("other")], &folders)),
            ErrorKind::NotAllowed
        );
        assert_eq!(kind(resolve_watch_dirs(&["relative".to_string()], &folders)), ErrorKind::InvalidInput);
        assert_eq!(kind(resolve_watch_dirs(&[dir.str("root")], &OpenFolders::default())), ErrorKind::NotAllowed);
    }

    #[test]
    fn watch_dirs_are_capped() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        let mut paths = Vec::new();
        for i in 0..(MAX_WATCHED_FOLDERS + 5) {
            dir.dir(&format!("root/d{i}"));
            paths.push(dir.str(&format!("root/d{i}")));
        }
        assert_eq!(resolve_watch_dirs(&paths, &folders).unwrap().len(), MAX_WATCHED_FOLDERS);
    }

    // ---- シンボリックリンク ----

    #[cfg(unix)]
    mod unix {
        use super::*;
        use std::os::unix::fs::symlink;

        #[test]
        fn create_through_a_symlink_that_points_outside_is_not_allowed() {
            let dir = TempDir::new();
            dir.dir("outside");
            let folders = opened(&dir, "root");
            symlink(dir.path("outside"), dir.path("root/escape")).unwrap();
            assert_eq!(kind(create_file(&dir.str("root/escape"), "x.md", &folders)), ErrorKind::NotAllowed);
            assert_eq!(kind(create_folder(&dir.str("root/escape"), "x", &folders)), ErrorKind::NotAllowed);
            assert_eq!(fs::read_dir(dir.path("outside")).unwrap().count(), 0);
        }

        #[test]
        fn a_path_through_an_escaping_symlink_cannot_be_renamed_or_trashed() {
            let dir = TempDir::new();
            dir.file("outside/secret.md", "s");
            let folders = opened(&dir, "root");
            symlink(dir.path("outside"), dir.path("root/escape")).unwrap();
            let known = KnownPaths::default();
            let through = dir.str("root/escape/secret.md");
            assert_eq!(kind(rename_entry(&through, "x.md", &folders, &known)), ErrorKind::NotAllowed);
            let (calls, trasher) = recorder();
            assert_eq!(kind(trash_entry(&through, &folders, &trasher)), ErrorKind::NotAllowed);
            assert!(calls.borrow().is_empty());
            assert_eq!(dir.read("outside/secret.md"), "s");
        }

        #[test]
        fn a_permission_error_for_a_dangling_symlink_becomes_already_exists() {
            let dir = TempDir::new();
            symlink(dir.path("nowhere"), dir.path("broken")).unwrap();
            let err = creation_error(io::Error::from(io::ErrorKind::PermissionDenied), &dir.path("broken"));
            assert_eq!(err.kind, ErrorKind::AlreadyExists);
        }

        #[test]
        fn creating_inside_a_symlink_to_a_folder_inside_the_root_is_allowed() {
            let dir = TempDir::new();
            let folders = opened(&dir, "root");
            dir.dir("root/real");
            symlink(dir.path("root/real"), dir.path("root/alias")).unwrap();
            let path = create_file(&dir.str("root/alias"), "x.md", &folders).unwrap();
            assert_eq!(path, dir.str("root/alias/x.md"));
            assert!(dir.exists("root/real/x.md"));
        }

        #[test]
        fn rename_acts_on_the_link_itself_not_on_its_target() {
            let dir = TempDir::new();
            dir.file("outside/target.md", "t");
            dir.file("root/real.md", "r");
            let folders = opened(&dir, "root");
            symlink(dir.path("outside/target.md"), dir.path("root/link.md")).unwrap();
            symlink(dir.path("outside"), dir.path("root/linkdir")).unwrap();
            let known = KnownPaths::default();

            rename_entry(&dir.str("root/link.md"), "renamed.md", &folders, &known).unwrap();
            assert!(fs::symlink_metadata(dir.path("root/renamed.md")).unwrap().file_type().is_symlink());
            assert!(!dir.exists("root/link.md"));
            assert_eq!(dir.read("outside/target.md"), "t");

            // 外を指すフォルダへのリンクも、リンクとして名前を変えられる（中へは入らない）。
            rename_entry(&dir.str("root/linkdir"), "renamed-dir", &folders, &known).unwrap();
            assert!(fs::symlink_metadata(dir.path("root/renamed-dir")).unwrap().file_type().is_symlink());
            assert!(dir.path("outside/target.md").exists());
        }

        #[test]
        fn trash_hands_over_the_link_itself_not_its_target() {
            let dir = TempDir::new();
            dir.file("outside/target.md", "t");
            let folders = opened(&dir, "root");
            symlink(dir.path("outside/target.md"), dir.path("root/link.md")).unwrap();
            symlink(dir.path("outside"), dir.path("root/linkdir")).unwrap();
            symlink(dir.path("nowhere"), dir.path("root/broken")).unwrap();
            let (calls, trasher) = recorder();
            for name in ["link.md", "linkdir", "broken"] {
                trash_entry(&dir.str(&format!("root/{name}")), &folders, &trasher).unwrap();
            }
            let root = fs::canonicalize(dir.path("root")).unwrap();
            assert_eq!(
                *calls.borrow(),
                vec![root.join("link.md"), root.join("linkdir"), root.join("broken")]
            );
            for p in calls.borrow().iter() {
                assert!(fs::symlink_metadata(p).unwrap().file_type().is_symlink());
            }
        }

        #[test]
        fn a_symlink_that_aliases_the_opened_folder_is_not_treated_as_the_root() {
            let dir = TempDir::new();
            let folders = opened(&dir, "root");
            dir.dir("root/sub");
            symlink(dir.path("root"), dir.path("root/self")).unwrap();
            let known = KnownPaths::default();
            // 登録したフォルダへのリンクは、リンクとして名前を変えられる（フォルダ自身は動かない）。
            rename_entry(&dir.str("root/self"), "loop", &folders, &known).unwrap();
            assert!(dir.path("root/sub").is_dir());
            assert!(fs::symlink_metadata(dir.path("root/loop")).unwrap().file_type().is_symlink());
        }
    }
}
