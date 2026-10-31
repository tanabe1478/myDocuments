// 自前コマンドを明示的に permission として登録する。
// capabilities には、ここで列挙したコマンド（allow-*）と dialog だけを許可する。
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "open_document",
            "save_document",
            "save_document_as",
            "load_preferences",
            "save_preferences",
        ]),
    ))
    .expect("failed to run tauri-build");
}
