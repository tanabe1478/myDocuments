//! 隔離の検証用（Cargo の feature `isolation-probe`。既定では無効）。ADR-005 の「R5 で確かめた隔離」。
//!
//! この feature を付けたビルドにだけ、隔離した文脈（Worker、仲介の iframe）が、ネイティブのコマンドに届いたかを記録する
//! コマンドが入る。届いたかの判定は、webview 側の自己申告ではなく、ここが書くファイル（起動の環境変数
//! `MDE_PROBE_OUT` のディレクトリの `canary.log`）の行で行う。feature なしのビルドには、この module もコマンドも、
//! 許可（capability）も含まれない（lib.rs の cfg、build.rs の cfg）。

use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use tauri::{ipc::CapabilityBuilder, App, Manager};

/// 記録用のコマンドの名前（build.rs のコマンド一覧、許可、フロントエンドの試験が同じ名前を使う）。
pub const COMMANDS: [&str; 3] = [
    "isolation_probe_canary",
    "isolation_probe_config",
    "isolation_probe_report",
];

fn out_dir() -> Option<PathBuf> {
    std::env::var_os("MDE_PROBE_OUT")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// 1 行を、環境変数で指定したディレクトリの `name` に追記する。指定がなければ何もしない。
fn append(name: &str, line: &str) {
    let Some(dir) = out_dir() else { return };
    // 1 行 1 記録にする（改行は潰し、長さに上限（20000 文字））。
    let line: String = line
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(20000)
        .collect();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(name))
    {
        let _ = writeln!(f, "{line}");
    }
}

/// 呼ばれたことを `canary.log` に 1 行書く。隔離した文脈から届いたかどうかの、判定の正本。
#[tauri::command]
pub fn isolation_probe_canary(who: String) -> String {
    append("canary.log", &who);
    "ok".into()
}

#[derive(Serialize)]
pub struct ProbeConfig {
    /// 127.0.0.1 の受け口の URL（例: http://127.0.0.1:PORT）。環境変数 `MDE_PROBE_NET`。
    net: String,
}

#[tauri::command]
pub fn isolation_probe_config() -> ProbeConfig {
    ProbeConfig {
        net: std::env::var("MDE_PROBE_NET").unwrap_or_default(),
    }
}

/// webview 側の自己申告（参考。届いたかの判定には使わない）を `report.jsonl` に書く。
#[tauri::command]
pub fn isolation_probe_report(line: String) {
    append("report.jsonl", &line);
}

/// 記録用のコマンドを main 窓に許可する。この許可は実行時に足す（feature のときだけ。`capabilities/` のファイルには書かない）。
pub fn grant(app: &App) -> tauri::Result<()> {
    let mut capability = CapabilityBuilder::new("isolation-probe").window("main");
    for name in COMMANDS {
        capability = capability.permission(format!("allow-{}", name.replace('_', "-")));
    }
    app.add_capability(capability)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_names_match_the_functions_and_permissions() {
        assert_eq!(
            COMMANDS,
            [
                "isolation_probe_canary",
                "isolation_probe_config",
                "isolation_probe_report"
            ]
        );
    }

    #[test]
    fn nothing_is_written_without_the_output_directory() {
        // 環境変数がなければ何もしない（テストの実行でファイルを作らない）。
        if std::env::var_os("MDE_PROBE_OUT").is_none() {
            assert_eq!(isolation_probe_canary("x".into()), "ok");
        }
    }
}
