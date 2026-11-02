mod backgrounds;
mod documents;
mod drafts;
mod entries;
mod error;
mod external;
mod folders;
mod preferences;
mod session;
mod watcher;

use backgrounds::BackgroundImageDto;
use documents::{DiskStateDto, FormatDto, KnownPaths, OpenedDocument, SaveResultDto};
use drafts::{Draft, DraftSummary};
use error::{CommandError, ErrorKind};
use folders::{FolderListingDto, OpenFolders};
use session::Session;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager, RunEvent, State, WindowEvent};
use watcher::{DocumentWatcher, FolderWatcher};

/// 外部変更の通知（payload は { path }）。
const EVENT_DOCUMENT_CHANGED: &str = "document-changed";
/// 監視中のフォルダの項目が増減・名前の変更をされたことの通知（payload は { path }）。
const EVENT_FOLDER_CHANGED: &str = "folder-changed";
/// 窓を閉じる・終了する操作があったことの通知。UI が確認してから `close_app` を呼ぶ。
const EVENT_CLOSE_REQUESTED: &str = "close-requested";

/// 終了時の確認の状態。
/// UI が最初の描画を終えるまで（`ready` になるまで）は、確認の相手がいないので、そのまま閉じる。
#[derive(Default)]
struct CloseGuard {
    ready: AtomicBool,
    /// UI が `close_app` で終了を確定した。以降は止めない。
    confirmed: AtomicBool,
}

// フロントエンドから呼べるコマンドは、ここに列挙したものだけ（build.rs と capabilities/default.json に対応）。

#[tauri::command]
async fn open_document(
    path: String,
    known: State<'_, KnownPaths>,
) -> Result<OpenedDocument, CommandError> {
    documents::open(&path, &known)
}

/// `expected_revision`: この文書が最後に見たディスクの revision（ファイルがない前提なら null）。
/// ディスクの内容が違えば書かずに conflict を返す。`overwrite` は、衝突を承知で上書きする
/// （現在のディスクの内容は backups/ へ退避してから書く）。
#[tauri::command]
async fn save_document(
    app: AppHandle,
    path: String,
    text: String,
    format: FormatDto,
    expected_revision: Option<String>,
    overwrite: bool,
    known: State<'_, KnownPaths>,
) -> Result<SaveResultDto, CommandError> {
    documents::save(
        &path,
        &text,
        format,
        expected_revision.as_deref(),
        overwrite,
        &backups_dir(&app)?,
        &known,
    )
}

#[tauri::command]
async fn save_document_as(
    path: String,
    text: String,
    format: FormatDto,
    known: State<'_, KnownPaths>,
) -> Result<SaveResultDto, CommandError> {
    documents::save_as(&path, &text, format, &known)
}

/// 開いた・保存先に選んだパスの、いまのディスクの状態（present + revision、または missing）。
#[tauri::command]
async fn check_document(
    path: String,
    known: State<'_, KnownPaths>,
) -> Result<DiskStateDto, CommandError> {
    documents::check(&path, &known)
}

/// 外部変更の監視の対象を切り替える。null なら監視をやめる。
#[tauri::command]
async fn watch_document(
    app: AppHandle,
    path: Option<String>,
    known: State<'_, KnownPaths>,
    watcher: State<'_, DocumentWatcher>,
) -> Result<(), CommandError> {
    let target = match path {
        Some(p) => Some(documents::validate_known(&p, &known)?),
        None => None,
    };
    let emitter = app.clone();
    watcher
        .watch(target, move |changed| {
            let _ = emitter.emit(
                EVENT_DOCUMENT_CHANGED,
                serde_json::json!({ "path": changed.to_string_lossy() }),
            );
        })
        .map_err(|e| {
            let kind = match &e.kind {
                notify::ErrorKind::PathNotFound => ErrorKind::NotFound,
                _ => ErrorKind::Io,
            };
            CommandError::new(kind, e.to_string())
        })
}

fn config_dir(app: &AppHandle) -> Result<std::path::PathBuf, CommandError> {
    app.path()
        .app_config_dir()
        .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))
}

#[tauri::command]
async fn load_preferences(app: AppHandle) -> Result<Option<serde_json::Value>, CommandError> {
    preferences::load_from(&config_dir(&app)?)
}

#[tauri::command]
async fn save_preferences(app: AppHandle, prefs: serde_json::Value) -> Result<(), CommandError> {
    preferences::save_to(&config_dir(&app)?, &prefs)
}

fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))
}

fn backups_dir(app: &AppHandle) -> Result<std::path::PathBuf, CommandError> {
    data_dir(app).map(|d| d.join("backups"))
}

fn drafts_dir(app: &AppHandle) -> Result<std::path::PathBuf, CommandError> {
    data_dir(app).map(|d| d.join("drafts"))
}

/// 草稿を書く。戻り値は書いたファイルのパス。
#[tauri::command]
async fn write_draft(app: AppHandle, draft: Draft) -> Result<String, CommandError> {
    drafts::write(&drafts_dir(&app)?, &draft)
}

#[tauri::command]
async fn list_drafts(app: AppHandle) -> Result<Vec<DraftSummary>, CommandError> {
    drafts::list(&drafts_dir(&app)?)
}

#[tauri::command]
async fn read_draft(app: AppHandle, draft_id: String) -> Result<Option<Draft>, CommandError> {
    drafts::read(&drafts_dir(&app)?, &draft_id)
}

#[tauri::command]
async fn delete_draft(app: AppHandle, draft_id: String) -> Result<(), CommandError> {
    drafts::delete(&drafts_dir(&app)?, &draft_id)
}

#[tauri::command]
async fn load_session(app: AppHandle) -> Result<Session, CommandError> {
    session::load_from(&data_dir(&app)?)
}

#[tauri::command]
async fn save_session(app: AppHandle, session: Session) -> Result<(), CommandError> {
    session::save_to(&data_dir(&app)?, &session)
}

/// エクスプローラーに開くフォルダを選んだとき（ダイアログの結果、または前回のセッションの復元）に呼ぶ。
/// 存在するフォルダであることを確かめ、許可したフォルダとして登録する。
#[tauri::command]
async fn open_folder(path: String, folders: State<'_, OpenFolders>) -> Result<(), CommandError> {
    folders::open(&path, &folders)
}

/// 開いたフォルダ（またはその配下）の中身。それ以外のパスは NotAllowed。
#[tauri::command]
async fn list_folder(
    path: String,
    folders: State<'_, OpenFolders>,
) -> Result<FolderListingDto, CommandError> {
    folders::list(&path, &folders)
}

/// 開いたフォルダの配下に、空のファイルを作る。既にあれば AlreadyExists（上書きしない）。戻り値は新しいパス。
#[tauri::command]
async fn create_file(
    parent: String,
    name: String,
    folders: State<'_, OpenFolders>,
) -> Result<String, CommandError> {
    entries::create_file(&parent, &name, &folders)
}

/// 開いたフォルダの配下に、フォルダを作る。既にあれば AlreadyExists。戻り値は新しいパス。
#[tauri::command]
async fn create_folder(
    parent: String,
    name: String,
    folders: State<'_, OpenFolders>,
) -> Result<String, CommandError> {
    entries::create_folder(&parent, &name, &folders)
}

/// 項目の名前を変える。既存の別の項目は上書きしない。戻り値は新しいパス。
/// 開いた文書（または、それを含むフォルダ）なら、新しいパスも保存・監視できるように登録する。
#[tauri::command]
async fn rename_entry(
    path: String,
    new_name: String,
    folders: State<'_, OpenFolders>,
    known: State<'_, KnownPaths>,
) -> Result<String, CommandError> {
    entries::rename_entry(&path, &new_name, &folders, &known)
}

/// 項目をゴミ箱へ移す。開いたフォルダ自身は移さない。
#[tauri::command]
async fn trash_entry(path: String, folders: State<'_, OpenFolders>) -> Result<(), CommandError> {
    entries::trash_entry(&path, &folders, &entries::system_trash)
}

/// エクスプローラーが見せているフォルダ（ルートと展開中のフォルダ）の監視を、渡したフォルダに切り替える。
/// 項目の増減・名前の変更があったフォルダを、`folder-changed`（payload は { path }）で知らせる。
#[tauri::command]
async fn watch_folders(
    app: AppHandle,
    paths: Vec<String>,
    folders: State<'_, OpenFolders>,
    watcher: State<'_, FolderWatcher>,
) -> Result<(), CommandError> {
    let dirs = entries::resolve_watch_dirs(&paths, &folders)?;
    watcher
        .watch(dirs, move |changed| {
            let _ = app.emit(
                EVENT_FOLDER_CHANGED,
                serde_json::json!({ "path": changed.to_string_lossy() }),
            );
        })
        .map_err(|e| {
            let kind = match &e.kind {
                notify::ErrorKind::PathNotFound => ErrorKind::NotFound,
                _ => ErrorKind::Io,
            };
            CommandError::new(kind, e.to_string())
        })
}

/// リンクを既定のブラウザで開く。http / https でホストのある URL だけ（それ以外は InvalidInput）。
/// 検査はここでも行う（Web UI の検査は信用しない）。プラグインの JavaScript 向けのコマンドは許可していない。
#[tauri::command]
async fn open_external_url(app: AppHandle, url: String) -> Result<(), CommandError> {
    external::open(&app, &url)
}

/// UI が終了の確認を済ませた後に呼ぶ。アプリを終了する。
#[tauri::command]
async fn close_app(app: AppHandle, guard: State<'_, CloseGuard>) -> Result<(), CommandError> {
    guard.confirmed.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

fn backgrounds_dir(app: &AppHandle) -> Result<std::path::PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("backgrounds"))
        .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))
}

/// ダイアログで選んだ画像を、アプリのデータ領域へコピーする。戻り値は imageId。
#[tauri::command]
async fn import_background_image(app: AppHandle, path: String) -> Result<String, CommandError> {
    backgrounds::import_from(&path, &backgrounds_dir(&app)?)
}

#[tauri::command]
async fn read_background_image(
    app: AppHandle,
    image_id: String,
) -> Result<BackgroundImageDto, CommandError> {
    backgrounds::read_from(&image_id, &backgrounds_dir(&app)?)
}

/// 窓は非表示で作り、フロントエンドが最初の描画を終えてから表示する（起動時のちらつき対策）。
/// この方式は MDE（https://github.com/sevenevesai/MDE、MIT）の src-tauri/src/lib.rs を参考にした。
/// コードは移植していない。
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(false) {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // リンクを開くための Rust 側の API（OpenerExt）だけを使う。JavaScript 向けのコマンドは capabilities で許可せず、
        // <a> のクリックを横取りする注入スクリプトも無効にする（開く入口は open_external_url だけ）。
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .manage(KnownPaths::default())
        .manage(OpenFolders::default())
        .manage(DocumentWatcher::default())
        .manage(FolderWatcher::default())
        .manage(CloseGuard::default())
        .invoke_handler(tauri::generate_handler![
            open_document,
            save_document,
            save_document_as,
            check_document,
            watch_document,
            write_draft,
            list_drafts,
            read_draft,
            delete_draft,
            load_session,
            save_session,
            open_folder,
            list_folder,
            create_file,
            create_folder,
            rename_entry,
            trash_entry,
            watch_folders,
            open_external_url,
            close_app,
            load_preferences,
            save_preferences,
            import_background_image,
            read_background_image
        ])
        .on_window_event(|window, event| {
            // 窓の閉じるボタン。UI が準備できているときは止めて、UI に未保存の確認を任せる。
            if let WindowEvent::CloseRequested { api, .. } = event {
                let guard = window.state::<CloseGuard>();
                if guard.ready.load(Ordering::SeqCst) && !guard.confirmed.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.emit(EVENT_CLOSE_REQUESTED, ());
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            app.listen("frontend-ready", move |_| {
                handle.state::<CloseGuard>().ready.store(true, Ordering::SeqCst);
                show_main_window(&handle);
            });

            // フロントエンドが読み込めなかった場合でも、窓が出ないままにならないための保険。
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(5));
                show_main_window(&handle);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        // macOS の Cmd+Q など、窓を閉じずにアプリの終了だけが要求された場合も、確認を挟む。
        // code が Some のときは `close_app`（確認済み）などによる終了なので止めない。
        // 窓がなくなった後の終了要求も止めない。
        if let RunEvent::ExitRequested { api, code: None, .. } = event {
            let guard = handle.state::<CloseGuard>();
            let has_window = handle.get_webview_window("main").is_some();
            if has_window
                && guard.ready.load(Ordering::SeqCst)
                && !guard.confirmed.load(Ordering::SeqCst)
            {
                api.prevent_exit();
                let _ = handle.emit(EVENT_CLOSE_REQUESTED, ());
            }
        }
    });
}
