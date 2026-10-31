// リリースビルドで Windows のコンソール窓を出さない。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    immersive_markdown_editor_lib::run()
}
