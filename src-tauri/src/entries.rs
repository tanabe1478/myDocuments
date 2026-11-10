//! エクスプローラーからの作成・名前の変更・ゴミ箱への移動。Tauri に依存しない部分。
//!
//! どの操作も、対象の親フォルダを canonicalize（`..` とシンボリックリンクを解決）してから、`open_folder` が
//! 登録したフォルダの配下かを調べる（登録外、`..`、シンボリックリンクで外へ出るものは NotAllowed）。
//! 操作はリンク先ではなく、「canonicalize した親フォルダ + 名前」の項目そのものに効かせる
//! （シンボリックリンクは、リンク自体を名前変更・ゴミ箱へ移す）。登録したフォルダ（ルート）自身は、名前の変更もゴミ箱への移動もしない。
//! 確認してから操作するまでの間に、別のプロセスが親フォルダを差し替える競合は防げない（docs/decision-003 の限界）。
//! 移動（`move_entry`）は、移す項目と移し先のフォルダを同じ規則で確かめ、移し先の同じ名前は `Conflict` に従って扱う。

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

/// 移し先に同じ名前の項目があるときの扱い。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conflict {
    /// 何もせず AlreadyExists を返す。
    Fail,
    /// 既存の項目をゴミ箱へ移してから移す。
    Replace,
    /// 拡張子の前に「 2」「 3」…を付けた、空いている名前で移す。
    KeepBoth,
}

impl Conflict {
    /// フロントエンドからの値（"fail" | "replace" | "keep-both"）。それ以外は InvalidInput。
    pub fn parse(value: &str) -> Result<Conflict, CommandError> {
        match value {
            "fail" => Ok(Conflict::Fail),
            "replace" => Ok(Conflict::Replace),
            "keep-both" => Ok(Conflict::KeepBoth),
            _ => Err(invalid("the conflict must be fail, replace or keep-both")),
        }
    }
}

/// 番号を付ける名前の上限（「名前 2」から「名前 999」まで）。
const MAX_KEEP_BOTH_NUMBER: u32 = 999;

/// `name` に番号を付けた名前。拡張子のあるファイルは拡張子の前（`a.md` は `a 2.md`）、
/// フォルダ・拡張子のない名前は末尾（`a` は `a 2`）。ドットで始まる名前の先頭のドットは拡張子の区切りとして扱わない。
fn numbered_name(name: &str, number: u32, is_folder: bool) -> String {
    if !is_folder {
        if let Some(dot) = name.rfind('.') {
            if dot > 0 {
                return format!("{} {}{}", &name[..dot], number, &name[dot..]);
            }
        }
    }
    format!("{name} {number}")
}

/// 項目 `item` を `dest_dir`（登録済みのフォルダの配下）へ移す。戻り値は移した後のパス（渡された `dest_dir` の形 + 最終の名前）。
/// 同じフォルダへの移動は何もせず、元のパスを返す。フォルダを自分自身の中へは移せない（NotAllowed）。登録したフォルダ（ルート）自身は移さない。
/// 移し先の同じ名前は、`dest_dir` + 名前の項目の有無（リンクは辿らない。FS が大文字小文字を区別しなければ、違う大文字小文字も見つかる）で判定し、
/// `conflict` に従う。ゴミ箱へ移せなければ移さない。`rename` の失敗（別のディスクなど）は、コピーと削除で代用せず、そのまま返す。
/// 成功したら、開いている文書の記録（`known`）を新しいパスへ引き継ぐ。
pub fn move_entry(
    path: &str,
    dest_dir: &str,
    conflict: Conflict,
    folders: &OpenFolders,
    known: &KnownPaths,
    trasher: Trasher<'_>,
) -> Result<String, CommandError> {
    let given = validate_path(path)?;
    let Item { name, item, .. } = resolve_item(path, folders)?;
    if folders.is_root(&item) {
        return Err(not_allowed("an opened folder itself cannot be moved"));
    }
    let given_dest = validate_path(dest_dir)?;
    let dest = resolve_dir(&given_dest, folders)?;

    // 同じフォルダへの移動は、何もしない（FS が大文字小文字を区別しないときの表記の違いも、同じフォルダとして扱う）。
    if let Some(parent) = item.parent() {
        if parent == dest || same_entry(parent, &dest) {
            return Ok(path_string(given));
        }
    }
    // フォルダを自分自身の中へは移せない。リンクはリンク自体として扱う（リンク先の中かどうかでは判定しない）。
    let is_real_folder = fs::symlink_metadata(&item)?.file_type().is_dir();
    if is_real_folder && dest.ancestors().any(|a| a == item || same_entry(a, &item)) {
        return Err(not_allowed("a folder cannot be moved into itself"));
    }

    let mut final_name = name.to_string_lossy().into_owned();
    let mut target = dest.join(&name);
    match fs::symlink_metadata(&target) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
        Ok(_) => match conflict {
            Conflict::Fail => {
                return Err(CommandError::new(
                    ErrorKind::AlreadyExists,
                    "an item with that name already exists",
                ));
            }
            Conflict::Replace => {
                if folders.is_root(&target) {
                    return Err(not_allowed("an opened folder itself cannot be replaced"));
                }
                // 移す項目が、置き換える項目の中にある（置き換えると、移す項目も一緒にゴミ箱へ入る）。
                if item.ancestors().skip(1).any(|a| a == target || same_entry(a, &target)) {
                    return Err(not_allowed("an item cannot replace the folder that contains it"));
                }
                // ゴミ箱へ移せなければ、移さない。
                trasher(&target).map_err(|message| CommandError::new(ErrorKind::Io, message))?;
            }
            Conflict::KeepBoth => {
                let mut found = None;
                for number in 2..=MAX_KEEP_BOTH_NUMBER {
                    let candidate = numbered_name(&final_name, number, is_real_folder);
                    validate_name(&candidate)?;
                    match fs::symlink_metadata(dest.join(&candidate)) {
                        Err(e) if e.kind() == io::ErrorKind::NotFound => {
                            found = Some(candidate);
                            break;
                        }
                        Err(e) => return Err(e.into()),
                        Ok(_) => {}
                    }
                }
                let Some(candidate) = found else {
                    return Err(CommandError::new(
                        ErrorKind::AlreadyExists,
                        "no free name is left for the item",
                    ));
                };
                target = dest.join(&candidate);
                final_name = candidate;
            }
        },
    }
    fs::rename(&item, &target)?;

    let new_path = given_dest.join(&final_name);
    known.register_renamed(&given, &new_path);
    Ok(path_string(new_path))
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

    // ---- 移動 ----

    /// ゴミ箱の代わり。渡された対象を記録し、実際に取り除く（置き換えで、移し先が空くことを確かめるため）。
    fn removing_recorder() -> (Rc<RefCell<Vec<PathBuf>>>, impl Fn(&Path) -> Result<(), String>) {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let calls_ref = calls.clone();
        (calls, move |p: &Path| {
            calls_ref.borrow_mut().push(p.to_path_buf());
            let meta = fs::symlink_metadata(p).map_err(|e| e.to_string())?;
            if meta.file_type().is_dir() {
                fs::remove_dir_all(p).map_err(|e| e.to_string())
            } else {
                fs::remove_file(p).map_err(|e| e.to_string())
            }
        })
    }

    fn mv(dir: &TempDir, folders: &OpenFolders, from: &str, to: &str, conflict: Conflict) -> Result<String, CommandError> {
        let known = KnownPaths::default();
        let (_, trasher) = recorder();
        move_entry(&dir.str(from), &dir.str(to), conflict, folders, &known, &trasher)
    }

    /// FS が大文字小文字を区別しないか（一時ディレクトリで確かめる）。
    fn ignores_case(dir: &TempDir) -> bool {
        dir.file("case-probe.txt", "x");
        fs::symlink_metadata(dir.path("CASE-PROBE.TXT")).is_ok()
    }

    #[test]
    fn move_puts_a_file_and_a_folder_into_another_folder_and_returns_the_new_path() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "A");
        dir.file("root/folder/inner/b.md", "B");
        dir.dir("root/dest");
        let moved = mv(&dir, &folders, "root/a.md", "root/dest", Conflict::Fail).unwrap();
        assert_eq!(moved, dir.str("root/dest/a.md"));
        assert_eq!(dir.read("root/dest/a.md"), "A");
        assert!(!dir.exists("root/a.md"));

        let moved = mv(&dir, &folders, "root/folder", "root/dest", Conflict::Fail).unwrap();
        assert_eq!(moved, dir.str("root/dest/folder"));
        assert_eq!(dir.read("root/dest/folder/inner/b.md"), "B");
        assert!(!dir.exists("root/folder"));

        // 深いところから、ルート直下へも移せる。
        let moved = mv(&dir, &folders, "root/dest/folder/inner/b.md", "root", Conflict::Fail).unwrap();
        assert_eq!(moved, dir.str("root/b.md"));
        assert_eq!(dir.read("root/b.md"), "B");
    }

    #[test]
    fn move_into_the_folder_it_is_already_in_changes_nothing_and_returns_the_original_path() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/sub/a.md", "A");
        dir.file("root/top.md", "T");
        let path = mv(&dir, &folders, "root/sub/a.md", "root/sub", Conflict::Fail).unwrap();
        assert_eq!(path, dir.str("root/sub/a.md"));
        assert_eq!(dir.read("root/sub/a.md"), "A");
        // 衝突の扱いによらない（keep-both でも、番号付きの複製を作らない）。
        for conflict in [Conflict::Replace, Conflict::KeepBoth] {
            let path = mv(&dir, &folders, "root/top.md", "root", conflict).unwrap();
            assert_eq!(path, dir.str("root/top.md"));
        }
        assert_eq!(fs::read_dir(dir.path("root")).unwrap().count(), 2);
        assert_eq!(fs::read_dir(dir.path("root/sub")).unwrap().count(), 1);
        // `..` を挟んだ同じフォルダの指定も、同じフォルダとして扱う。
        let around = dir.parent_of("root/sub", 1, "sub");
        let known = KnownPaths::default();
        let (calls, trasher) = recorder();
        let path = move_entry(&dir.str("root/sub/a.md"), &around, Conflict::Replace, &folders, &known, &trasher).unwrap();
        assert_eq!(path, dir.str("root/sub/a.md"));
        assert!(calls.borrow().is_empty());
    }

    #[test]
    fn a_folder_cannot_be_moved_into_itself_or_into_its_own_descendant() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a/b/c/x.md", "x");
        dir.dir("root/sibling");
        for to in ["root/a", "root/a/b", "root/a/b/c"] {
            assert_eq!(kind(mv(&dir, &folders, "root/a", to, Conflict::Fail)), ErrorKind::NotAllowed, "{to}");
            assert_eq!(kind(mv(&dir, &folders, "root/a", to, Conflict::KeepBoth)), ErrorKind::NotAllowed, "{to}");
        }
        assert_eq!(dir.read("root/a/b/c/x.md"), "x");
        // 兄弟のフォルダには移せる。名前の前方一致（a と ab）は、自分の中とは見ない。
        dir.dir("root/ab");
        assert!(mv(&dir, &folders, "root/a", "root/ab", Conflict::Fail).is_ok());
        assert!(mv(&dir, &folders, "root/ab/a", "root/sibling", Conflict::Fail).is_ok());
    }

    #[test]
    fn the_opened_folder_itself_and_paths_outside_the_opened_folders_cannot_be_moved() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("other/o.md", "o");
        dir.file("root/sub/a.md", "a");
        dir.dir("root/inner");
        folders::open(&dir.str("root/inner"), &folders).unwrap();
        dir.dir("elsewhere");
        for conflict in [Conflict::Fail, Conflict::Replace, Conflict::KeepBoth] {
            // ルート自身。
            assert_eq!(kind(mv(&dir, &folders, "root", "root/sub", conflict)), ErrorKind::NotAllowed);
            assert_eq!(kind(mv(&dir, &folders, "root/inner", "root/sub", conflict)), ErrorKind::NotAllowed);
            // 外の項目、外の移し先。
            assert_eq!(kind(mv(&dir, &folders, "other/o.md", "root/sub", conflict)), ErrorKind::NotAllowed);
            assert_eq!(kind(mv(&dir, &folders, "root/sub/a.md", "other", conflict)), ErrorKind::NotAllowed);
            assert_eq!(kind(mv(&dir, &folders, "root/sub/a.md", "elsewhere", conflict)), ErrorKind::NotAllowed);
        }
        // `..` で外へ出る移し先、`..` で外の項目を指す。
        let escape = dir.parent_of("root/sub", 2, "other");
        let known = KnownPaths::default();
        let (_, trasher) = recorder();
        assert_eq!(
            kind(move_entry(&dir.str("root/sub/a.md"), &escape, Conflict::Fail, &folders, &known, &trasher)),
            ErrorKind::NotAllowed
        );
        let escaped_item = dir.parent_of("root/sub", 2, "other/o.md");
        assert_eq!(
            kind(move_entry(&escaped_item, &dir.str("root/sub"), Conflict::Fail, &folders, &known, &trasher)),
            ErrorKind::NotAllowed
        );
        // 何も開いていない。
        assert_eq!(
            kind(move_entry(&dir.str("root/sub/a.md"), &dir.str("root"), Conflict::Fail, &OpenFolders::default(), &known, &trasher)),
            ErrorKind::NotAllowed
        );
        assert!(dir.exists("other/o.md") && dir.exists("root/sub/a.md") && !dir.exists("other/a.md"));
    }

    #[test]
    fn move_reports_missing_items_missing_destinations_file_destinations_and_relative_paths() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "a");
        dir.file("root/f.md", "f");
        dir.dir("root/dest");
        assert_eq!(kind(mv(&dir, &folders, "root/missing.md", "root/dest", Conflict::Fail)), ErrorKind::NotFound);
        assert_eq!(kind(mv(&dir, &folders, "root/a.md", "root/nowhere", Conflict::Fail)), ErrorKind::NotFound);
        assert_eq!(kind(mv(&dir, &folders, "root/a.md", "root/f.md", Conflict::Fail)), ErrorKind::InvalidInput);
        let known = KnownPaths::default();
        let (_, trasher) = recorder();
        assert_eq!(
            kind(move_entry("relative.md", &dir.str("root/dest"), Conflict::Fail, &folders, &known, &trasher)),
            ErrorKind::InvalidInput
        );
        assert_eq!(
            kind(move_entry(&dir.str("root/a.md"), "relative", Conflict::Fail, &folders, &known, &trasher)),
            ErrorKind::InvalidInput
        );
        assert_eq!(dir.read("root/a.md"), "a");
    }

    #[test]
    fn the_conflict_value_is_one_of_three_names() {
        assert_eq!(Conflict::parse("fail").unwrap(), Conflict::Fail);
        assert_eq!(Conflict::parse("replace").unwrap(), Conflict::Replace);
        assert_eq!(Conflict::parse("keep-both").unwrap(), Conflict::KeepBoth);
        for bad in ["", "Fail", "overwrite", "keep_both", "keepboth"] {
            assert_eq!(kind(Conflict::parse(bad)), ErrorKind::InvalidInput, "{bad:?}");
        }
    }

    #[test]
    fn fail_returns_already_exists_and_changes_nothing_for_a_file_and_a_folder() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "new A");
        dir.file("root/dest/a.md", "old A");
        dir.file("root/sub/dup/inner.md", "new dup");
        dir.file("root/dest/dup/old.md", "old dup");
        dir.file("root/sub/mixed", "a file");
        dir.dir("root/dest/mixed");
        for from in ["root/a.md", "root/sub/dup", "root/sub/mixed"] {
            assert_eq!(kind(mv(&dir, &folders, from, "root/dest", Conflict::Fail)), ErrorKind::AlreadyExists, "{from}");
        }
        assert_eq!(dir.read("root/a.md"), "new A");
        assert_eq!(dir.read("root/dest/a.md"), "old A");
        assert!(dir.exists("root/sub/dup/inner.md") && !dir.exists("root/dest/dup/inner.md"));
        assert_eq!(dir.read("root/dest/dup/old.md"), "old dup");
        assert!(dir.exists("root/sub/mixed") && dir.path("root/dest/mixed").is_dir());
    }

    #[test]
    fn replace_hands_the_existing_item_to_the_trash_and_then_moves_the_item_there() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "new A");
        dir.file("root/dest/a.md", "old A");
        dir.file("root/sub/dup/inner.md", "new dup");
        dir.file("root/dest/dup/old.md", "old dup");
        let known = KnownPaths::default();
        let (calls, trasher) = removing_recorder();

        let moved = move_entry(&dir.str("root/a.md"), &dir.str("root/dest"), Conflict::Replace, &folders, &known, &trasher).unwrap();
        assert_eq!(moved, dir.str("root/dest/a.md"));
        assert_eq!(dir.read("root/dest/a.md"), "new A");
        assert!(!dir.exists("root/a.md"));
        let canonical_dest = fs::canonicalize(dir.path("root/dest")).unwrap();
        assert_eq!(*calls.borrow(), vec![canonical_dest.join("a.md")]);

        // フォルダを、同じ名前のフォルダへ。既存のフォルダは中身ごと、1 つの項目としてゴミ箱へ渡る。
        let moved = move_entry(&dir.str("root/sub/dup"), &dir.str("root/dest"), Conflict::Replace, &folders, &known, &trasher).unwrap();
        assert_eq!(moved, dir.str("root/dest/dup"));
        assert_eq!(calls.borrow().len(), 2);
        assert_eq!(calls.borrow()[1], canonical_dest.join("dup"));
        assert_eq!(dir.read("root/dest/dup/inner.md"), "new dup");
        assert!(!dir.exists("root/dest/dup/old.md"));
    }

    #[test]
    fn replace_without_a_same_named_item_does_not_touch_the_trash() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "A");
        dir.dir("root/dest");
        let known = KnownPaths::default();
        let (calls, trasher) = recorder();
        move_entry(&dir.str("root/a.md"), &dir.str("root/dest"), Conflict::Replace, &folders, &known, &trasher).unwrap();
        assert!(calls.borrow().is_empty());
        assert_eq!(dir.read("root/dest/a.md"), "A");
    }

    #[test]
    fn replace_refuses_when_the_item_is_inside_the_item_it_would_replace() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        // root/docs/inner/docs を root へ移すと、同じ名前の root/docs（祖先）を置き換えることになる。
        dir.file("root/docs/inner/docs/x.md", "x");
        dir.file("root/docs/y.md", "y");
        dir.file("root/pack/pack", "a file named like its folder");
        let known = KnownPaths::default();
        let (calls, trasher) = removing_recorder();
        for from in ["root/docs/inner/docs", "root/pack/pack"] {
            let err = move_entry(&dir.str(from), &dir.str("root"), Conflict::Replace, &folders, &known, &trasher).unwrap_err();
            assert_eq!(err.kind, ErrorKind::NotAllowed, "{from}");
        }
        assert!(calls.borrow().is_empty());
        assert_eq!(dir.read("root/docs/inner/docs/x.md"), "x");
        assert_eq!(dir.read("root/docs/y.md"), "y");
        assert!(dir.exists("root/pack/pack"));
        // fail と keep-both は、それぞれの決めたとおり（AlreadyExists と、番号付きで移す）。
        assert_eq!(kind(mv(&dir, &folders, "root/docs/inner/docs", "root", Conflict::Fail)), ErrorKind::AlreadyExists);
        let moved = mv(&dir, &folders, "root/docs/inner/docs", "root", Conflict::KeepBoth).unwrap();
        assert_eq!(moved, dir.str("root/docs 2"));
        assert_eq!(dir.read("root/docs 2/x.md"), "x");
    }

    #[test]
    fn replace_does_not_replace_a_registered_opened_folder() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.dir("root/inner");
        folders::open(&dir.str("root/inner"), &folders).unwrap();
        dir.file("root/sub/inner/x.md", "x");
        let known = KnownPaths::default();
        let (calls, trasher) = removing_recorder();
        let err = move_entry(&dir.str("root/sub/inner"), &dir.str("root"), Conflict::Replace, &folders, &known, &trasher).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotAllowed);
        assert!(calls.borrow().is_empty());
        assert!(dir.path("root/inner").is_dir() && dir.exists("root/sub/inner/x.md"));
    }

    #[test]
    fn replace_does_not_move_when_the_trash_fails() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "new");
        dir.file("root/dest/a.md", "old");
        let known = KnownPaths::default();
        let failing = |_: &Path| Err::<(), String>("the trash is not available".to_string());
        let err = move_entry(&dir.str("root/a.md"), &dir.str("root/dest"), Conflict::Replace, &folders, &known, &failing).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Io);
        assert!(err.message.contains("the trash is not available"));
        assert_eq!(dir.read("root/a.md"), "new");
        assert_eq!(dir.read("root/dest/a.md"), "old");
        assert!(!known.contains(&dir.path("root/dest/a.md")));
    }

    #[test]
    fn keep_both_numbers_the_name_before_the_extension() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "A");
        dir.file("root/dest/a.md", "old A");
        let moved = mv(&dir, &folders, "root/a.md", "root/dest", Conflict::KeepBoth).unwrap();
        assert_eq!(moved, dir.str("root/dest/a 2.md"));
        assert_eq!(dir.read("root/dest/a 2.md"), "A");
        assert_eq!(dir.read("root/dest/a.md"), "old A");
        // もう 1 つ同じ名前を移すと、次の番号。
        dir.file("root/sub/a.md", "A3");
        let moved = mv(&dir, &folders, "root/sub/a.md", "root/dest", Conflict::KeepBoth).unwrap();
        assert_eq!(moved, dir.str("root/dest/a 3.md"));
        assert_eq!(dir.read("root/dest/a 3.md"), "A3");
    }

    #[test]
    fn keep_both_without_an_extension_and_for_folders_appends_the_number() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/README", "r");
        dir.file("root/dest/README", "old r");
        dir.file("root/notes.v1/x.md", "x");
        dir.dir("root/dest/notes.v1");
        dir.file("root/arch.tar.gz", "z");
        dir.file("root/dest/arch.tar.gz", "old z");
        assert_eq!(mv(&dir, &folders, "root/README", "root/dest", Conflict::KeepBoth).unwrap(), dir.str("root/dest/README 2"));
        // フォルダは、名前にドットがあっても末尾に付ける。
        assert_eq!(mv(&dir, &folders, "root/notes.v1", "root/dest", Conflict::KeepBoth).unwrap(), dir.str("root/dest/notes.v1 2"));
        assert_eq!(dir.read("root/dest/notes.v1 2/x.md"), "x");
        // 拡張子は最後のドットから。
        assert_eq!(mv(&dir, &folders, "root/arch.tar.gz", "root/dest", Conflict::KeepBoth).unwrap(), dir.str("root/dest/arch.tar 2.gz"));
    }

    #[test]
    fn keep_both_skips_numbers_that_are_taken_by_files_folders_and_links() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "A");
        dir.file("root/dest/a.md", "old");
        dir.file("root/dest/a 2.md", "two");
        dir.dir("root/dest/a 3.md");
        dir.file("root/dest/a 5.md", "five");
        let moved = mv(&dir, &folders, "root/a.md", "root/dest", Conflict::KeepBoth).unwrap();
        assert_eq!(moved, dir.str("root/dest/a 4.md"));
        assert_eq!(dir.read("root/dest/a 2.md"), "two");
        assert_eq!(dir.read("root/dest/a 4.md"), "A");
    }

    #[test]
    fn keep_both_gives_up_when_every_number_up_to_the_limit_is_taken() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "A");
        dir.file("root/dest/a.md", "old");
        for n in 2..=MAX_KEEP_BOTH_NUMBER {
            fs::write(dir.path(&format!("root/dest/a {n}.md")), "x").unwrap();
        }
        assert_eq!(kind(mv(&dir, &folders, "root/a.md", "root/dest", Conflict::KeepBoth)), ErrorKind::AlreadyExists);
        assert_eq!(dir.read("root/a.md"), "A");
        // 上限の 1 つ手前までなら、最後の番号が付く。
        fs::remove_file(dir.path(&format!("root/dest/a {MAX_KEEP_BOTH_NUMBER}.md"))).unwrap();
        let moved = mv(&dir, &folders, "root/a.md", "root/dest", Conflict::KeepBoth).unwrap();
        assert_eq!(moved, dir.str(&format!("root/dest/a {MAX_KEEP_BOTH_NUMBER}.md")));
    }

    #[test]
    fn numbered_names_follow_the_extension_rule_and_stay_valid_names() {
        assert_eq!(numbered_name("a.md", 2, false), "a 2.md");
        assert_eq!(numbered_name("a.md", 2, true), "a.md 2");
        assert_eq!(numbered_name("README", 3, false), "README 3");
        assert_eq!(numbered_name("メモ.txt", 10, false), "メモ 10.txt");
        assert_eq!(numbered_name("a.tar.gz", 2, false), "a.tar 2.gz");
        // ドットで始まる名前（ツリーには出ない）は、先頭のドットを拡張子の区切りにしない。
        assert_eq!(numbered_name(".env", 2, false), ".env 2");
        for name in ["a.md", "README", "メモ.txt", "a.tar.gz", "my notes.md"] {
            for n in [2, 9, 10, MAX_KEEP_BOTH_NUMBER] {
                assert!(validate_name(&numbered_name(name, n, false)).is_ok(), "{name} {n}");
                assert!(validate_name(&numbered_name(name, n, true)).is_ok(), "{name} {n}");
            }
        }
    }

    #[test]
    fn a_name_that_differs_only_in_letter_case_is_the_same_name_when_the_filesystem_ignores_case() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        if !ignores_case(&dir) {
            eprintln!("skipped: this filesystem tells names apart by letter case");
            return;
        }
        dir.file("root/sub/note.md", "new");
        dir.file("root/NOTE.md", "old");
        assert_eq!(kind(mv(&dir, &folders, "root/sub/note.md", "root", Conflict::Fail)), ErrorKind::AlreadyExists);
        assert_eq!(dir.read("root/sub/note.md"), "new");
        // keep-both は、番号を付けて別の名前にする。
        let moved = mv(&dir, &folders, "root/sub/note.md", "root", Conflict::KeepBoth).unwrap();
        assert_eq!(moved, dir.str("root/note 2.md"));
        assert_eq!(dir.read("root/note 2.md"), "new");
        assert_eq!(dir.read("root/NOTE.md"), "old");
        // replace は、違う大文字小文字の既存の項目をゴミ箱へ渡す。
        dir.file("root/sub/note.md", "newer");
        let (calls, trasher) = removing_recorder();
        let known = KnownPaths::default();
        move_entry(&dir.str("root/sub/note.md"), &dir.str("root"), Conflict::Replace, &folders, &known, &trasher).unwrap();
        assert_eq!(calls.borrow().len(), 1);
        assert_eq!(dir.read("root/note.md"), "newer");
    }

    #[test]
    fn a_name_that_differs_only_in_letter_case_is_a_different_name_when_the_filesystem_tells_them_apart() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        if ignores_case(&dir) {
            eprintln!("skipped: this filesystem ignores letter case");
            return;
        }
        dir.file("root/sub/note.md", "lower");
        dir.file("root/NOTE.md", "upper");
        let moved = mv(&dir, &folders, "root/sub/note.md", "root", Conflict::Fail).unwrap();
        assert_eq!(moved, dir.str("root/note.md"));
        assert_eq!((dir.read("root/note.md"), dir.read("root/NOTE.md")), ("lower".into(), "upper".into()));
    }

    #[test]
    fn move_registers_the_new_path_of_a_known_document_and_of_documents_inside_a_moved_folder() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "x");
        dir.file("root/sub/deep/b.md", "y");
        dir.file("root/other.md", "z");
        dir.dir("root/dest");
        let known = KnownPaths::default();
        for p in ["root/a.md", "root/sub/deep/b.md", "root/other.md"] {
            known.register(&dir.path(p));
        }
        let (_, trasher) = recorder();
        move_entry(&dir.str("root/a.md"), &dir.str("root/dest"), Conflict::Fail, &folders, &known, &trasher).unwrap();
        assert!(known.contains(&dir.path("root/dest/a.md")));
        move_entry(&dir.str("root/sub"), &dir.str("root/dest"), Conflict::Fail, &folders, &known, &trasher).unwrap();
        assert!(known.contains(&dir.path("root/dest/sub/deep/b.md")));
        // 番号を付けて移したときは、付けた名前のパスが登録される。
        dir.file("root/dest/other.md", "old");
        move_entry(&dir.str("root/other.md"), &dir.str("root/dest"), Conflict::KeepBoth, &folders, &known, &trasher).unwrap();
        assert!(known.contains(&dir.path("root/dest/other 2.md")));
        // 無関係なパスは増えない。
        assert!(!known.contains(&dir.path("root/dest/unrelated.md")));
    }

    #[test]
    fn a_failed_move_registers_nothing() {
        let dir = TempDir::new();
        let folders = opened(&dir, "root");
        dir.file("root/a.md", "x");
        dir.file("root/dest/a.md", "old");
        let known = KnownPaths::default();
        known.register(&dir.path("root/a.md"));
        let (_, trasher) = recorder();
        assert!(move_entry(&dir.str("root/a.md"), &dir.str("root/dest"), Conflict::Fail, &folders, &known, &trasher).is_err());
        assert!(!known.contains(&dir.path("root/dest/a.md")));
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
        fn a_path_through_an_escaping_symlink_cannot_be_moved_or_be_a_destination() {
            let dir = TempDir::new();
            dir.file("outside/secret.md", "s");
            dir.file("root/a.md", "a");
            dir.dir("root/dest");
            let folders = opened(&dir, "root");
            symlink(dir.path("outside"), dir.path("root/escape")).unwrap();
            assert_eq!(
                kind(mv(&dir, &folders, "root/escape/secret.md", "root/dest", Conflict::Fail)),
                ErrorKind::NotAllowed
            );
            assert_eq!(kind(mv(&dir, &folders, "root/a.md", "root/escape", Conflict::Fail)), ErrorKind::NotAllowed);
            assert_eq!(dir.read("outside/secret.md"), "s");
            assert!(!dir.exists("outside/a.md"));
        }

        #[test]
        fn move_acts_on_the_link_itself_not_on_its_target() {
            let dir = TempDir::new();
            dir.file("outside/target.md", "t");
            dir.dir("root/dest");
            let folders = opened(&dir, "root");
            symlink(dir.path("outside/target.md"), dir.path("root/link.md")).unwrap();
            symlink(dir.path("outside"), dir.path("root/linkdir")).unwrap();
            symlink(dir.path("nowhere"), dir.path("root/broken")).unwrap();
            for name in ["link.md", "linkdir", "broken"] {
                let moved = mv(&dir, &folders, &format!("root/{name}"), "root/dest", Conflict::Fail).unwrap();
                assert_eq!(moved, dir.str(&format!("root/dest/{name}")));
                assert!(fs::symlink_metadata(dir.path(&format!("root/dest/{name}"))).unwrap().file_type().is_symlink());
                assert!(!dir.exists(&format!("root/{name}")));
            }
            assert_eq!(dir.read("outside/target.md"), "t");
        }

        #[test]
        fn a_link_to_a_folder_can_be_moved_into_the_folder_it_points_to() {
            let dir = TempDir::new();
            dir.file("root/real/x.md", "x");
            let folders = opened(&dir, "root");
            symlink(dir.path("root/real"), dir.path("root/alias")).unwrap();
            // リンク先の中かどうかではなく、リンク自体として扱う（リンクは自分自身ではない）。
            let moved = mv(&dir, &folders, "root/alias", "root/real", Conflict::Fail).unwrap();
            assert_eq!(moved, dir.str("root/real/alias"));
            assert!(fs::symlink_metadata(dir.path("root/real/alias")).unwrap().file_type().is_symlink());
            assert_eq!(dir.read("root/real/x.md"), "x");
        }

        #[test]
        fn replace_hands_over_an_existing_link_itself_not_its_target() {
            let dir = TempDir::new();
            dir.file("outside/target.md", "t");
            dir.file("root/sub/link.md", "plain file");
            dir.dir("root/dest");
            let folders = opened(&dir, "root");
            symlink(dir.path("outside/target.md"), dir.path("root/dest/link.md")).unwrap();
            let known = KnownPaths::default();
            let (calls, trasher) = removing_recorder();
            move_entry(&dir.str("root/sub/link.md"), &dir.str("root/dest"), Conflict::Replace, &folders, &known, &trasher).unwrap();
            let canonical_dest = fs::canonicalize(dir.path("root/dest")).unwrap();
            assert_eq!(*calls.borrow(), vec![canonical_dest.join("link.md")]);
            assert_eq!(dir.read("outside/target.md"), "t");
            assert_eq!(dir.read("root/dest/link.md"), "plain file");
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
