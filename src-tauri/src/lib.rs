mod documents;
mod error;
mod preferences;

use documents::{FormatDto, KnownPaths, OpenedDocument, SaveOutcomeDto};
use error::{CommandError, ErrorKind};
use std::time::Duration;
use tauri::{AppHandle, Listener, Manager, State};

// フロントエンドから呼べるコマンドは、この 5 つだけ（build.rs と capabilities/default.json に対応）。

#[tauri::command]
async fn open_document(
    path: String,
    known: State<'_, KnownPaths>,
) -> Result<OpenedDocument, CommandError> {
    documents::open(&path, &known)
}

#[tauri::command]
async fn save_document(
    path: String,
    text: String,
    format: FormatDto,
    known: State<'_, KnownPaths>,
) -> Result<SaveOutcomeDto, CommandError> {
    documents::save(&path, &text, format, &known)
}

#[tauri::command]
async fn save_document_as(
    path: String,
    text: String,
    format: FormatDto,
    known: State<'_, KnownPaths>,
) -> Result<SaveOutcomeDto, CommandError> {
    documents::save_as(&path, &text, format, &known)
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(KnownPaths::default())
        .invoke_handler(tauri::generate_handler![
            open_document,
            save_document,
            save_document_as,
            load_preferences,
            save_preferences
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            app.listen("frontend-ready", move |_| show_main_window(&handle));

            // フロントエンドが読み込めなかった場合でも、窓が出ないままにならないための保険。
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(5));
                show_main_window(&handle);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
