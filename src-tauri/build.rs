// 自前コマンドを明示的に permission として登録する。
// capabilities には、ここで列挙したコマンド（allow-*）と dialog だけを許可する。
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "open_document",
            "save_document",
            "save_document_as",
            "check_document",
            "watch_document",
            "write_draft",
            "list_drafts",
            "read_draft",
            "delete_draft",
            "load_session",
            "save_session",
            "open_folder",
            "list_folder",
            "create_file",
            "create_folder",
            "rename_entry",
            "trash_entry",
            "watch_folders",
            "open_external_url",
            "close_app",
            "load_preferences",
            "save_preferences",
            "import_background_image",
            "read_background_image",
        ]),
    ))
    .expect("failed to run tauri-build");
}
