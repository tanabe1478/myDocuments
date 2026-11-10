mod backgrounds;
mod clipboard;
mod documents;
mod drafts;
mod entries;
mod error;
mod external;
mod folders;
mod logging;
mod plugin_permissions;
mod preferences;
#[cfg(feature = "isolation-probe")]
mod probe;
mod session;
mod watcher;

use backgrounds::BackgroundImageDto;
use documents::{DiskStateDto, FormatDto, KnownPaths, OpenedDocument, SaveResultDto};
use drafts::{Draft, DraftSummary};
use error::{CommandError, ErrorKind};
use folders::{FolderListingDto, OpenFolders};
use logging::LogState;
use plugin_permissions::PluginPermissions;
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

/// 項目を、開いたフォルダの配下の別のフォルダへ移す。`conflict`（"fail" | "replace" | "keep-both"）は、移し先に同じ名前の項目があるときの扱い。
/// 戻り値は移した後のパス。開いた文書（または、それを含むフォルダ）なら、新しいパスも保存・監視できるように登録する。
#[tauri::command]
async fn move_entry(
    path: String,
    dest_dir: String,
    conflict: String,
    folders: State<'_, OpenFolders>,
    known: State<'_, KnownPaths>,
) -> Result<String, CommandError> {
    let conflict = entries::Conflict::parse(&conflict)?;
    entries::move_entry(&path, &dest_dir, conflict, &folders, &known, &entries::system_trash)
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

/// クリップボードに文字列を書く（書くだけ。読む口はない）。空と、100,000 文字を超える文字列は InvalidInput。
/// 部品の権限（clipboard.write）は、本体の UI が確かめてから呼ぶ。clipboard-manager の JavaScript 向けのコマンドは許可していない。
#[tauri::command]
async fn write_clipboard_text(app: AppHandle, text: String) -> Result<(), CommandError> {
    clipboard::write(&app, &text)
}

/// 部品の権限の、利用者の決定（アプリのデータ領域の plugin-permissions.json）。壊れている・ないときは空。
#[tauri::command]
async fn load_plugin_permissions(app: AppHandle) -> Result<PluginPermissions, CommandError> {
    plugin_permissions::load_from(&data_dir(&app)?)
}

/// 形（版、部品の id、権限の名前、granted / denied）と大きさを検査して保存する。
#[tauri::command]
async fn save_plugin_permissions(app: AppHandle, permissions: serde_json::Value) -> Result<(), CommandError> {
    plugin_permissions::save_to(&data_dir(&app)?, &permissions)
}

/// アプリのログを記録するかを切り替える（設定「ログを記録する」。既定は無効）。無効から有効に変わったとき、起動の情報を 1 行書く。
/// 書き込みの失敗は、アプリの動作に影響させない（常に Ok）。
#[tauri::command]
async fn set_logging(enabled: bool, log: State<'_, LogState>) -> Result<(), CommandError> {
    log.set_enabled(enabled);
    Ok(())
}

/// ログの行（{ level, source, event, data? } の配列。時刻はここで付ける）を、有効の間だけ app.log へ追記する。
/// 形が合わない項目は捨てる（エラーにしない）。無効の間は何も書かず、書けなくても Ok を返す。部品の隔離した iframe からは呼べない（capabilities は main の窓だけ）。
#[tauri::command]
async fn append_log(entries: serde_json::Value, log: State<'_, LogState>) -> Result<(), CommandError> {
    log.append(&entries);
    Ok(())
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

/// フロントエンドから呼べるコマンドの一覧。`isolation-probe` の feature のときだけ、記録用のコマンドが加わる（probe.rs）。
macro_rules! app_commands {
    ($($extra:path),* $(,)?) => {
        tauri::generate_handler![
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
            move_entry,
            watch_folders,
            open_external_url,
            close_app,
            load_preferences,
            save_preferences,
            import_background_image,
            read_background_image,
            write_clipboard_text,
            load_plugin_permissions,
            save_plugin_permissions,
            set_logging,
            append_log,
            $($extra),*
        ]
    };
}

pub fn run() {
    // ログの状態。パニックのフックも同じ状態を見る（有効の間だけ書く。既定のフックは残す）。
    let log_state = LogState::default();
    logging::install_panic_hook(log_state.clone());
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // リンクを開くための Rust 側の API（OpenerExt）だけを使う。JavaScript 向けのコマンドは capabilities で許可せず、
        // <a> のクリックを横取りする注入スクリプトも無効にする（開く入口は open_external_url だけ）。
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .manage(KnownPaths::default())
        .manage(OpenFolders::default())
        .manage(DocumentWatcher::default())
        .manage(FolderWatcher::default())
        .manage(CloseGuard::default())
        .manage(log_state);
    // クリップボードに書くための Rust 側の API（ClipboardExt）だけを使う。JavaScript 向けのコマンドは capabilities で許可しない
    // （書く入口は write_clipboard_text だけ）。隔離の検証用のビルドは、書き込みを記録に差し替えるので、プラグインを入れない。
    #[cfg(not(feature = "isolation-probe"))]
    let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    #[cfg(not(feature = "isolation-probe"))]
    let builder = builder.invoke_handler(app_commands!());
    #[cfg(feature = "isolation-probe")]
    let builder = builder.invoke_handler(app_commands!(
        probe::isolation_probe_canary,
        probe::isolation_probe_config,
        probe::isolation_probe_report
    ));
    let app = builder
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
            // 隔離の検証用のコマンドの許可。feature のときだけ足す。
            #[cfg(feature = "isolation-probe")]
            probe::grant(app)?;

            // ログの置き場所（macOS では ~/Library/Logs/<identifier>/）。決められなければ、ログは書かれない。
            if let Ok(dir) = app.path().app_log_dir() {
                app.state::<LogState>().set_dir(dir);
            }

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

/// 隔離の検証用のコマンド（feature `isolation-probe`）が、feature のときだけ含まれることの検査。
/// tauri-build が出力した ACL の生成物（コマンドの許可の一覧、capability）を読む。
#[cfg(test)]
mod probe_gate_tests {
    use std::path::Path;

    fn generated_text() -> String {
        let out = Path::new(env!("OUT_DIR"));
        ["acl-manifests.json", "capabilities.json", "app-manifest/__app__-permission-files"]
            .iter()
            .map(|name| std::fs::read_to_string(out.join(name)).unwrap_or_else(|e| panic!("{name}: {e}")))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_app_commands_are_in_the_generated_acl() {
        // 対照: 生成物の読み方が合っていること（自前のコマンドは、どのビルドでも載る）。
        let text = generated_text();
        assert!(text.contains("open_external_url") && text.contains("allow-open-external-url"));
    }

    #[cfg(not(feature = "isolation-probe"))]
    #[test]
    fn without_the_feature_no_probe_command_or_permission_exists() {
        assert!(!cfg!(feature = "isolation-probe"));
        let text = generated_text();
        assert!(!text.contains("isolation_probe") && !text.contains("isolation-probe"), "the probe commands leaked into the default build");
        // 許可（capabilities/default.json）にも、記録用のコマンドはない。
        let caps = include_str!("../capabilities/default.json");
        assert!(!caps.contains("probe"));
    }

    #[cfg(feature = "isolation-probe")]
    #[test]
    fn with_the_feature_the_probe_commands_exist_and_the_default_capability_does_not_grant_them() {
        let text = generated_text();
        for name in crate::probe::COMMANDS {
            assert!(text.contains(name), "{name}");
            assert!(text.contains(&format!("allow-{}", name.replace('_', "-"))), "{name}");
        }
        // 許可は実行時に足す（probe::grant）。ファイルの capability には書かない。
        assert!(!include_str!("../capabilities/default.json").contains("probe"));
    }
}

/// クリップボードの許可は、自前のコマンドの許可だけであることの検査（ADR-005 の R6）。clipboard-manager の JavaScript 向けの許可は、
/// 窓（capability）にも、ビルドが出力した ACL の生成物の capability にも入っていない。
#[cfg(test)]
mod clipboard_acl_tests {
    #[test]
    fn the_capability_grants_only_the_own_command_for_the_clipboard() {
        let caps: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let permissions: Vec<&str> = caps["permissions"].as_array().unwrap().iter().filter_map(|p| p.as_str()).collect();
        assert!(permissions.contains(&"allow-write-clipboard-text"));
        assert!(permissions.contains(&"allow-load-plugin-permissions"));
        assert!(permissions.contains(&"allow-save-plugin-permissions"));
        assert!(
            !permissions.iter().any(|p| p.contains("clipboard-manager") || p.starts_with("clipboard")),
            "no JavaScript-facing clipboard-manager permission may be granted: {permissions:?}"
        );
        // 窓に許可するのは main だけ。
        assert_eq!(caps["windows"], serde_json::json!(["main"]));
    }

    #[test]
    fn the_generated_capability_has_no_clipboard_manager_permission() {
        let out = std::path::Path::new(env!("OUT_DIR")).join("capabilities.json");
        let text = std::fs::read_to_string(out).unwrap();
        assert!(text.contains("allow-write-clipboard-text"));
        assert!(!text.contains("clipboard-manager"), "a clipboard-manager permission is granted to a window");
    }
}

/// capability に `remote` の指定がないことの検査（ADR-005 の R8）。仲介の iframe は srcdoc（送り元の URL が about:srcdoc）なので、Tauri は、
/// その送り元からのネイティブへの呼び出しをリモートの扱いにする。capability に `remote` の許可（URL の指定）があると、
/// srcdoc の文脈が許可の対象になりうるので、ファイルにも、ビルドが出力した ACL の生成物の capability にも、ないことを確かめる。
#[cfg(test)]
mod no_remote_capability_tests {
    #[test]
    fn the_capability_file_has_no_remote() {
        let caps: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(caps.get("remote").is_none(), "capabilities/default.json must not have a remote entry");
        assert!(caps.get("local").is_none() || caps["local"] == serde_json::json!(true));
    }

    #[test]
    fn the_generated_capabilities_have_no_remote_entry() {
        let out = std::path::Path::new(env!("OUT_DIR")).join("capabilities.json");
        let text = std::fs::read_to_string(out).unwrap();
        let all: serde_json::Value = serde_json::from_str(&text).unwrap();
        let entries = all.as_object().expect("capabilities.json is an object keyed by capability id");
        assert!(!entries.is_empty());
        for (id, capability) in entries {
            // 生成物の capability の `remote` は、空か、ない（ある場合は URL の一覧が入る）。
            let remote = capability.get("remote");
            assert!(
                remote.is_none() || remote == Some(&serde_json::Value::Null),
                "capability {id} has a remote entry: {remote:?}"
            );
        }
    }
}

/// ログのコマンド（set_logging、append_log）は、ほかの自前のコマンドと同じ作りで許可されることの検査（ADR-007）。
/// 許可は main の窓だけ（部品の隔離した iframe は、capability の対象にならない）。
#[cfg(test)]
mod logging_acl_tests {
    #[test]
    fn the_logging_commands_are_granted_to_the_main_window_only() {
        let caps: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let permissions: Vec<&str> = caps["permissions"].as_array().unwrap().iter().filter_map(|p| p.as_str()).collect();
        assert!(permissions.contains(&"allow-set-logging"));
        assert!(permissions.contains(&"allow-append-log"));
        assert!(!permissions.iter().any(|p| (p.starts_with("log:") || p.contains("plugin-log") || p.contains("logging") || p.contains("append-log")) && !matches!(*p, "allow-set-logging" | "allow-append-log")), "no other log permission (such as a log plugin) may be granted: {permissions:?}");
        assert_eq!(caps["windows"], serde_json::json!(["main"]));
    }

    #[test]
    fn the_generated_acl_has_both_commands() {
        let out = std::path::Path::new(env!("OUT_DIR"));
        let text = ["acl-manifests.json", "capabilities.json"]
            .iter()
            .map(|name| std::fs::read_to_string(out.join(name)).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        for name in ["set_logging", "append_log"] {
            assert!(text.contains(name), "{name}");
            assert!(text.contains(&format!("allow-{}", name.replace('_', "-"))), "{name}");
        }
    }
}
