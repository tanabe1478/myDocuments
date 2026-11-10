//! アプリのログ基盤（ADR-007）。設定で有効にしたときだけ、app_log_dir（macOS では ~/Library/Logs/<identifier>/）の app.log へ
//! JSON Lines で追記する。既定は無効で、無効の間は何も書かない。
//!
//! 1 行は { "t", "level", "source", "event", "data" }。時刻（UTC、ミリ秒まで）はここで付ける。
//! app.log が 1 MiB 以上になったら、書く前に app.log.1 へ移す（既存の app.log.1 は置き換える。残るのは 2 世代だけ）。
//! 入力は検査し、外れた項目は捨てる（エラーで止めない）。書き込みの失敗は無視する（アプリの動作に影響させない）。
//! 本文とファイルのパスは、呼び出し側（src/logging/）が書かない。ここでも、パニックのメッセージと場所のホームディレクトリは `~` にする。
//! 依存は足さない（時刻の整形は std の SystemTime から行う）。

use serde_json::{Map, Value};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FILE_NAME: &str = "app.log";
pub const ROTATED_NAME: &str = "app.log.1";
/// app.log がこの大きさ以上なら、次に書く前に app.log.1 へ移す。
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// 1 回の append_log で受け取る件数の上限（超えた分は捨てる）。
pub const MAX_ENTRIES_PER_CALL: usize = 100;
/// data の項目数の上限（超えた分は捨てる）。
pub const MAX_DATA_ITEMS: usize = 20;
/// data の文字列の上限（文字数。超えた項目は捨てる）。
pub const MAX_STRING_CHARS: usize = 500;
/// source、event、data のキーの長さの上限。
const MAX_NAME_LEN: usize = 64;

const LEVELS: [&str; 3] = ["info", "warn", "error"];

#[derive(Default)]
struct Inner {
    enabled: AtomicBool,
    dir: Mutex<Option<PathBuf>>,
    /// 追記と移し替えを、1 つずつ行うための鍵。
    writing: Mutex<()>,
}

/// ログの状態（有効か、置き場所）。複製しても同じ状態を指す（パニックのフックと、コマンドが共有する）。
#[derive(Clone, Default)]
pub struct LogState(Arc<Inner>);

impl LogState {
    /// 置き場所を決める（起動時に app_log_dir を渡す）。
    pub fn set_dir(&self, dir: PathBuf) {
        *self.0.dir.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir);
    }

    pub fn is_enabled(&self) -> bool {
        self.0.enabled.load(Ordering::SeqCst)
    }

    /// 有効・無効を切り替える。無効から有効に変わったときだけ、起動の情報を 1 行書く。
    pub fn set_enabled(&self, enabled: bool) {
        let was = self.0.enabled.swap(enabled, Ordering::SeqCst);
        if enabled && !was {
            self.write_lines(&[startup_line(SystemTime::now())]);
        }
    }

    /// append_log の本体。無効の間は何も書かない。検査に通った項目だけを書く。
    pub fn append(&self, raw: &Value) {
        if !self.is_enabled() {
            return;
        }
        let lines = build_lines(raw, SystemTime::now());
        if lines.is_empty() {
            return;
        }
        self.write_lines(&lines);
    }

    /// パニックを書く（有効の間だけ）。フックの中なので、鍵が取れなければ（パニックが書き込みの最中に起きた）書かない。
    pub fn record_panic(&self, message: &str, location: Option<(&str, u32)>) {
        if !self.is_enabled() {
            return;
        }
        let Some(dir) = self.0.dir.lock().ok().and_then(|d| d.clone()) else {
            return;
        };
        let mut data = Map::new();
        data.insert("message".into(), Value::String(truncate_chars(&scrub_home(message), MAX_STRING_CHARS)));
        if let Some((file, line)) = location {
            data.insert("file".into(), Value::String(truncate_chars(&scrub_home(file), MAX_STRING_CHARS)));
            data.insert("line".into(), Value::from(line));
        }
        let line = format_line(SystemTime::now(), "error", "rust", "panic", &data);
        if let Ok(_guard) = self.0.writing.try_lock() {
            let _ = write_lines_to(&dir, &[line]);
        }
    }

    fn write_lines(&self, lines: &[String]) {
        let Some(dir) = self.0.dir.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
            return;
        };
        let _guard = self.0.writing.lock().unwrap_or_else(|e| e.into_inner());
        // 書けなくても、アプリの動作には影響させない。
        let _ = write_lines_to(&dir, lines);
    }
}

/// パニックのフックを入れる。既定のフック（標準エラーへの出力）は残し、その前にログへ書く（有効の間だけ）。
pub fn install_panic_hook(state: LogState) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(no message)".to_string());
        let location = info.location().map(|l| (l.file().to_string(), l.line()));
        state.record_panic(&message, location.as_ref().map(|(f, l)| (f.as_str(), *l)));
        previous(info);
    }));
}

// ---- 検査と整形（状態を持たない。単体テストの対象） ----

/// source、event、data のキーに使える名前: [a-z0-9._-] の 1 から 64 文字。
pub fn is_valid_name(name: &str) -> bool {
    (1..=MAX_NAME_LEN).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'))
}

/// data から、使える項目だけを残す（最大 MAX_DATA_ITEMS 件）。値は数値、真偽値、null、MAX_STRING_CHARS 文字までの文字列だけ。
/// オブジェクトでなければ空。
pub fn sanitize_data(raw: Option<&Value>) -> Map<String, Value> {
    let mut data = Map::new();
    let Some(Value::Object(items)) = raw else {
        return data;
    };
    for (key, value) in items {
        if data.len() >= MAX_DATA_ITEMS {
            break;
        }
        let ok = match value {
            Value::Number(_) | Value::Bool(_) | Value::Null => true,
            Value::String(s) => s.chars().count() <= MAX_STRING_CHARS,
            _ => false,
        };
        if ok && is_valid_name(key) {
            data.insert(key.clone(), value.clone());
        }
    }
    data
}

/// entries（配列）から、書く行を作る。先頭の MAX_ENTRIES_PER_CALL 件だけを見て、level、source、event が合わない項目は捨てる。
pub fn build_lines(raw: &Value, now: SystemTime) -> Vec<String> {
    let Value::Array(entries) = raw else {
        return Vec::new();
    };
    entries
        .iter()
        .take(MAX_ENTRIES_PER_CALL)
        .filter_map(|entry| {
            let object = entry.as_object()?;
            let level = object.get("level")?.as_str()?;
            let source = object.get("source")?.as_str()?;
            let event = object.get("event")?.as_str()?;
            if !LEVELS.contains(&level) || !is_valid_name(source) || !is_valid_name(event) {
                return None;
            }
            Some(format_line(now, level, source, event, &sanitize_data(object.get("data"))))
        })
        .collect()
}

/// 1 行（改行なし）。キーの並びは t、level、source、event、data で固定する。
fn format_line(now: SystemTime, level: &str, source: &str, event: &str, data: &Map<String, Value>) -> String {
    let text = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string());
    let data = serde_json::to_string(data).unwrap_or_else(|_| "{}".to_string());
    format!(
        "{{\"t\":{},\"level\":{},\"source\":{},\"event\":{},\"data\":{}}}",
        text(&format_time(now)),
        text(level),
        text(source),
        text(event),
        data
    )
}

/// 有効になったときに Rust が書く、起動の情報（アプリの版、OS、CPU の種類）。
fn startup_line(now: SystemTime) -> String {
    let mut data = Map::new();
    data.insert("version".into(), Value::String(env!("CARGO_PKG_VERSION").to_string()));
    data.insert("os".into(), Value::String(std::env::consts::OS.to_string()));
    data.insert("arch".into(), Value::String(std::env::consts::ARCH.to_string()));
    format_line(now, "info", "rust", "start", &data)
}

/// UTC の ISO 8601（ミリ秒まで）。例: 2026-11-10T04:47:40.375Z。UNIX 時刻より前は 1970-01-01T00:00:00.000Z。
pub fn format_time(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let millis = since.subsec_millis();
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// 1970-01-01 からの日数を、グレゴリオ暦の（年、月、日）にする（Howard Hinnant の civil_from_days）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// 文字列の中のホームディレクトリ（/Users/<名前>、/home/<名前>、C:\Users\<名前>）を `~` にする。
pub fn scrub_home(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    'scan: while !rest.is_empty() {
        for prefix in ["/Users/", "/home/"] {
            if let Some(tail) = rest.strip_prefix(prefix) {
                let end = tail.find(|c: char| matches!(c, '/' | '\\') || c.is_whitespace()).unwrap_or(tail.len());
                out.push('~');
                rest = &tail[end..];
                continue 'scan;
            }
        }
        // C:\Users\<名前>（区切りは \ か /。ドライブ文字は 1 文字）。
        let mut chars = rest.chars();
        if let (Some(drive), Some(':')) = (chars.next(), chars.next()) {
            let after = &rest[drive.len_utf8() + 1..];
            if drive.is_ascii_alphabetic() {
                for sep in ['\\', '/'] {
                    let users = format!("{sep}Users{sep}");
                    if let Some(tail) = after.strip_prefix(users.as_str()) {
                        let end = tail.find(|c: char| matches!(c, '/' | '\\') || c.is_whitespace()).unwrap_or(tail.len());
                        out.push('~');
                        rest = &tail[end..];
                        continue 'scan;
                    }
                }
            }
        }
        let c = rest.chars().next().unwrap_or_default();
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

// ---- ファイルへの書き込み ----

/// 書く前に app.log が MAX_FILE_BYTES 以上なら app.log.1 へ移し（既存の app.log.1 は置き換える）、app.log へ追記する。
fn write_lines_to(dir: &Path, lines: &[String]) -> io::Result<()> {
    if lines.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    let current = dir.join(FILE_NAME);
    if fs::metadata(&current).map(|m| m.len() >= MAX_FILE_BYTES).unwrap_or(false) {
        let rotated = dir.join(ROTATED_NAME);
        let _ = fs::remove_file(&rotated);
        fs::rename(&current, &rotated)?;
    }
    let mut bytes = String::new();
    for line in lines {
        bytes.push_str(line);
        bytes.push('\n');
    }
    let mut file = OpenOptions::new().create(true).append(true).open(&current)?;
    file.write_all(bytes.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::AtomicU32;
    use std::time::Duration;

    static N: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            // 存在しないサブディレクトリを返す（書き込みが作ることを確認するため）。
            TempDir(std::env::temp_dir().join(format!("ime-log-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))))
        }
        fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
        fn lines(&self, name: &str) -> Vec<Value> {
            fs::read_to_string(self.file(name))
                .unwrap_or_default()
                .lines()
                .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("not JSON: {l}: {e}")))
                .collect()
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn state_in(dir: &TempDir, enabled: bool) -> LogState {
        let state = LogState::default();
        state.set_dir(dir.0.clone());
        if enabled {
            // 起動の行は別のテストで見る。ここでは捨てる。
            state.0.enabled.store(true, Ordering::SeqCst);
        }
        state
    }

    fn entry(event: &str) -> Value {
        json!({ "level": "info", "source": "app", "event": event, "data": { "n": 1 } })
    }

    #[test]
    fn appends_json_lines_with_t_level_source_event_and_data() {
        let dir = TempDir::new();
        let state = state_in(&dir, true);
        state.append(&json!([
            { "level": "warn", "source": "typing-sound", "event": "clock.stalled", "data": { "elapsed_ms": 612, "ok": false, "note": null, "state": "running" } },
            { "level": "info", "source": "app", "event": "visibility" }
        ]));
        state.append(&json!([entry("later")]));
        let lines = dir.lines(FILE_NAME);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["level"], "warn");
        assert_eq!(lines[0]["source"], "typing-sound");
        assert_eq!(lines[0]["event"], "clock.stalled");
        assert_eq!(lines[0]["data"], json!({ "elapsed_ms": 612, "ok": false, "note": null, "state": "running" }));
        // data がなければ空のオブジェクト。
        assert_eq!(lines[1]["data"], json!({}));
        assert_eq!(lines[2]["event"], "later");
        // 時刻は UTC の ISO 8601（ミリ秒まで）。
        for line in &lines {
            let t = line["t"].as_str().unwrap();
            assert_eq!(t.len(), 24, "{t}");
            assert!(t.ends_with('Z') && t.as_bytes()[10] == b'T' && t.as_bytes()[19] == b'.', "{t}");
        }
        // 1 行 1 件で、キーの並びは t、level、source、event、data。
        let raw = fs::read_to_string(dir.file(FILE_NAME)).unwrap();
        assert!(raw.lines().next().unwrap().starts_with("{\"t\":\""));
        let keys: Vec<usize> = ["\"t\"", "\"level\"", "\"source\"", "\"event\"", "\"data\""].iter().map(|k| raw.find(k).unwrap()).collect();
        assert!(keys.windows(2).all(|w| w[0] < w[1]));
        assert!(raw.ends_with('\n'));
    }

    #[test]
    fn creates_the_directory_when_missing() {
        let dir = TempDir::new();
        assert!(!dir.0.exists());
        state_in(&dir, true).append(&json!([entry("x")]));
        assert!(dir.file(FILE_NAME).exists());
    }

    #[test]
    fn writes_nothing_while_disabled_and_does_not_even_create_the_directory() {
        let dir = TempDir::new();
        let state = state_in(&dir, false);
        state.append(&json!([entry("x")]));
        assert!(!dir.0.exists());
        // 有効にして、無効に戻すと、また書かない。
        state.set_enabled(true);
        state.set_enabled(false);
        let before = dir.lines(FILE_NAME).len();
        state.append(&json!([entry("y")]));
        assert_eq!(dir.lines(FILE_NAME).len(), before);
    }

    #[test]
    fn moves_app_log_to_app_log_1_at_one_mib_and_keeps_only_two_generations() {
        let dir = TempDir::new();
        fs::create_dir_all(&dir.0).unwrap();
        let state = state_in(&dir, true);
        // 1 MiB に 1 バイト足りない: まだ移さない。
        fs::write(dir.file(FILE_NAME), vec![b'a'; (MAX_FILE_BYTES - 1) as usize]).unwrap();
        state.append(&json!([entry("first")]));
        assert!(!dir.file(ROTATED_NAME).exists());
        // ちょうど 1 MiB 以上になったので、次の書き込みの前に移す。
        let full = fs::metadata(dir.file(FILE_NAME)).unwrap().len();
        assert!(full >= MAX_FILE_BYTES);
        state.append(&json!([entry("second")]));
        assert_eq!(fs::metadata(dir.file(ROTATED_NAME)).unwrap().len(), full);
        let current = dir.lines(FILE_NAME);
        assert_eq!(current.len(), 1);
        assert_eq!(current[0]["event"], "second");
        // さらに溢れさせると、app.log.1 は置き換わり、3 世代目は残らない。
        let marker = fs::read(dir.file(FILE_NAME)).unwrap();
        let mut filler = marker.clone();
        filler.resize(MAX_FILE_BYTES as usize, b' ');
        fs::write(dir.file(FILE_NAME), &filler).unwrap();
        state.append(&json!([entry("third")]));
        assert_eq!(fs::read(dir.file(ROTATED_NAME)).unwrap(), filler);
        assert_eq!(dir.lines(FILE_NAME)[0]["event"], "third");
        let mut names: Vec<String> = fs::read_dir(&dir.0).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, vec![FILE_NAME.to_string(), ROTATED_NAME.to_string()]);
    }

    #[test]
    fn drops_entries_and_items_that_break_the_limits_without_failing() {
        let dir = TempDir::new();
        let state = state_in(&dir, true);
        let mut many = Map::new();
        for i in 0..30 {
            many.insert(format!("k{i:02}"), json!(i));
        }
        state.append(&json!([
            { "level": "debug", "source": "app", "event": "bad-level" },
            { "level": "info", "source": "App", "event": "bad-source-case" },
            { "level": "info", "source": "", "event": "empty-source" },
            { "level": "info", "source": "a".repeat(65), "event": "long-source" },
            { "level": "info", "source": "app", "event": "has space" },
            { "level": "info", "source": "app", "event": "日本語" },
            { "level": "info", "source": "app" },
            "not an object",
            42,
            null,
            { "level": "info", "source": "app", "event": "items", "data": Value::Object(many) },
            { "level": "error", "source": "app", "event": "values", "data": {
                "text": "あ".repeat(500), "toolong": "あ".repeat(501), "nested": { "a": 1 }, "list": [1], "num": 1.5, "flag": true, "nothing": null,
                "Bad-Key": 1, "has space": 2, "": 3
            } },
            { "level": "info", "source": "app", "event": "data-not-object", "data": [1, 2] },
            { "level": "info", "source": "app", "event": "boundary", "data": { "n": 64 } },
            { "level": "info", "source": "a".repeat(64), "event": "e".repeat(64) }
        ]));
        let lines = dir.lines(FILE_NAME);
        let events: Vec<&str> = lines.iter().map(|l| l["event"].as_str().unwrap()).collect();
        assert_eq!(events[..4], ["items", "values", "data-not-object", "boundary"]);
        assert_eq!(events.len(), 5);
        // 項目は 20 まで。
        assert_eq!(lines[0]["data"].as_object().unwrap().len(), MAX_DATA_ITEMS);
        // 外れた値とキーだけが捨てられる。
        let values = lines[1]["data"].as_object().unwrap();
        let mut keys: Vec<&str> = values.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["flag", "nothing", "num", "text"]);
        assert_eq!(values["text"].as_str().unwrap().chars().count(), 500);
        assert_eq!(lines[2]["data"], json!({}));
    }

    #[test]
    fn takes_at_most_100_entries_per_call_and_ignores_a_non_array() {
        let dir = TempDir::new();
        let state = state_in(&dir, true);
        let entries: Vec<Value> = (0..150).map(|i| entry(&format!("e{i}"))).collect();
        state.append(&Value::Array(entries));
        let lines = dir.lines(FILE_NAME);
        assert_eq!(lines.len(), MAX_ENTRIES_PER_CALL);
        assert_eq!(lines[99]["event"], "e99");
        state.append(&json!({ "level": "info", "source": "app", "event": "x" }));
        state.append(&json!("text"));
        state.append(&Value::Null);
        assert_eq!(dir.lines(FILE_NAME).len(), MAX_ENTRIES_PER_CALL);
    }

    #[test]
    fn an_unwritable_location_does_not_fail_or_panic() {
        // ディレクトリを作れない（親がファイル）、app.log がディレクトリ、のどちらも、呼び出しは普通に戻る。
        let dir = TempDir::new();
        fs::create_dir_all(&dir.0).unwrap();
        fs::write(dir.file("blocker"), b"x").unwrap();
        let blocked = LogState::default();
        blocked.set_dir(dir.file("blocker").join("sub"));
        blocked.set_enabled(true);
        blocked.append(&json!([entry("x")]));
        blocked.record_panic("boom", Some(("src/lib.rs", 1)));

        let directory_as_file = TempDir::new();
        fs::create_dir_all(directory_as_file.file(FILE_NAME)).unwrap();
        let state = state_in(&directory_as_file, true);
        state.append(&json!([entry("x")]));
        state.set_enabled(false);
        state.set_enabled(true);

        // 置き場所が決まっていない状態でも、同じ。
        let none = LogState::default();
        none.set_enabled(true);
        none.append(&json!([entry("x")]));
    }

    #[test]
    fn turning_on_writes_one_startup_line_with_version_os_and_arch() {
        let dir = TempDir::new();
        let state = state_in(&dir, false);
        state.set_enabled(true);
        let lines = dir.lines(FILE_NAME);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["level"], "info");
        assert_eq!(lines[0]["source"], "rust");
        assert_eq!(lines[0]["event"], "start");
        assert_eq!(lines[0]["data"]["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(lines[0]["data"]["os"], std::env::consts::OS);
        assert_eq!(lines[0]["data"]["arch"], std::env::consts::ARCH);
        // 有効のまま、もう一度有効にしても、書かない。無効にして有効にすれば、また 1 行。
        state.set_enabled(true);
        assert_eq!(dir.lines(FILE_NAME).len(), 1);
        state.set_enabled(false);
        state.set_enabled(true);
        assert_eq!(dir.lines(FILE_NAME).len(), 2);
    }

    #[test]
    fn a_panic_is_written_only_while_enabled_with_message_file_and_line() {
        let dir = TempDir::new();
        let state = state_in(&dir, false);
        state.record_panic("ignored", Some(("src/lib.rs", 1)));
        assert!(!dir.0.exists());

        state.set_enabled(true);
        state.record_panic("called `Option::unwrap()` on a `None` value", Some(("src/lib.rs", 42)));
        state.record_panic("no location", None);
        let lines = dir.lines(FILE_NAME);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[1]["level"], "error");
        assert_eq!(lines[1]["source"], "rust");
        assert_eq!(lines[1]["event"], "panic");
        assert_eq!(lines[1]["data"], json!({ "message": "called `Option::unwrap()` on a `None` value", "file": "src/lib.rs", "line": 42 }));
        assert_eq!(lines[2]["data"], json!({ "message": "no location" }));
    }

    #[test]
    fn the_panic_hook_writes_while_enabled_and_keeps_the_previous_hook() {
        // 実際のパニックで、フックが呼ばれ、前のフックも呼ばれる（プロセス全体のフックなので、このテストの中だけで入れて戻す）。
        let dir = TempDir::new();
        let state = state_in(&dir, true);
        let before = std::panic::take_hook();
        let previous_called = Arc::new(AtomicBool::new(false));
        let flag = previous_called.clone();
        std::panic::set_hook(Box::new(move |_| flag.store(true, Ordering::SeqCst)));
        install_panic_hook(state.clone());
        let result = std::panic::catch_unwind(|| panic!("hook-test-message"));
        let _ = std::panic::take_hook();
        std::panic::set_hook(before);
        assert!(result.is_err());
        assert!(previous_called.load(Ordering::SeqCst), "the default hook must still run");
        let lines = dir.lines(FILE_NAME);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["event"], "panic");
        assert_eq!(lines[0]["data"]["message"], "hook-test-message");
        assert!(lines[0]["data"]["file"].as_str().unwrap().ends_with("logging.rs"));
        assert!(lines[0]["data"]["line"].as_u64().unwrap() > 0);
    }

    #[test]
    fn formats_the_time_as_utc_iso_8601_with_milliseconds() {
        let at = |secs: u64, ms: u64| UNIX_EPOCH + Duration::from_millis(secs * 1000 + ms);
        assert_eq!(format_time(at(0, 0)), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_time(at(1_700_000_000, 123)), "2023-11-14T22:13:20.123Z");
        // うるう日、年の境、2 月 28 日の翌日（うるう年でない年）。
        assert_eq!(format_time(at(951_782_400, 0)), "2000-02-29T00:00:00.000Z");
        assert_eq!(format_time(at(1_709_164_800, 999)), "2024-02-29T00:00:00.999Z");
        assert_eq!(format_time(at(1_735_689_599, 1)), "2024-12-31T23:59:59.001Z");
        assert_eq!(format_time(at(1_735_689_600, 0)), "2025-01-01T00:00:00.000Z");
        assert_eq!(format_time(at(1_740_700_800, 0)), "2025-02-28T00:00:00.000Z");
        assert_eq!(format_time(at(1_740_787_200, 0)), "2025-03-01T00:00:00.000Z");
        assert_eq!(format_time(at(1_794_286_060, 375)), "2026-11-10T04:47:40.375Z");
        // 2100 年はうるう年ではない。
        assert_eq!(format_time(at(4_107_542_400, 0)), "2100-03-01T00:00:00.000Z");
        // UNIX 時刻より前は、起点。
        assert_eq!(format_time(UNIX_EPOCH - Duration::from_secs(5)), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn names_follow_a_z_0_9_dot_underscore_hyphen_up_to_64_characters() {
        for ok in ["a", "typing-sound", "clock.stalled", "a_b", "0", &"a".repeat(64)] {
            assert!(is_valid_name(ok), "{ok}");
        }
        for bad in ["", "A", "a b", "あ", "a/b", "a:b", &"a".repeat(65)] {
            assert!(!is_valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn scrubs_the_home_directory_in_text() {
        assert_eq!(scrub_home("failed at /Users/alice/Documents/a.md now"), "failed at ~/Documents/a.md now");
        assert_eq!(scrub_home("/home/bob/.cargo/registry/src/x.rs"), "~/.cargo/registry/src/x.rs");
        assert_eq!(scrub_home(r"C:\Users\carol\Documents\a.md"), r"~\Documents\a.md");
        assert_eq!(scrub_home("C:/Users/carol/a.md"), "~/a.md");
        assert_eq!(scrub_home("home is /Users/alice"), "home is ~");
        assert_eq!(scrub_home("src/lib.rs"), "src/lib.rs");
        assert_eq!(scrub_home("日本語 /Users/あ/い"), "日本語 ~/い");
    }
}
