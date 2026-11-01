//! docio の読み書きの計測（perf/ から呼ばれる）。標準ライブラリだけで時間を測り、JSON を 1 行出す。
//!
//! 使い方（release で測る）:
//!   cargo run --release --manifest-path crates/docio/Cargo.toml --example perf -- \
//!     --iters 50 --tmp <作業ディレクトリ> <A.md> <B.md> ...
//!
//! 測る操作（ファイルごと、反復 --iters 回。単位はマイクロ秒）:
//! - read: fs::read（ページキャッシュに載った状態）
//! - decode: BOM と改行の判定、LF への正規化
//! - encode: 記録した形式への復元
//! - revision: SHA-256（revision_of）
//! - save_atomic_changed: 内容が毎回変わる原子的保存（一時ファイル、fsync、rename）。実際に書いた回数が反復数と一致することを assert する
//! - save_atomic_unchanged: 同じ内容の保存（比較して書かない）
//! - save_checked_changed: アプリの保存と同じ経路（ハッシュによる競合検査 + 原子的保存）。内容は毎回変わる（save_atomic とは別のファイルへ書き、同じく assert する）

use docio::{decode, encode, revision_of, save_atomic, save_checked, CheckedSave, SaveOutcome, DEFAULT_BACKUP_LIMITS};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

fn micros(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1e6
}

/// nearest-rank の分位点（perf/lib/util.mjs の quantile と同じ）。
fn quantile(sorted: &[f64], p: f64) -> f64 {
    let rank = ((p * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len());
    sorted[rank - 1]
}

fn summary(mut xs: Vec<f64>) -> String {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    format!(
        "{{\"n\":{},\"median\":{:.1},\"p95\":{:.1},\"min\":{:.1},\"max\":{:.1}}}",
        xs.len(),
        quantile(&xs, 0.5),
        quantile(&xs, 0.95),
        xs[0],
        xs[xs.len() - 1]
    )
}

fn main() {
    let mut iters = 30usize;
    let mut tmp: Option<PathBuf> = None;
    let mut files: Vec<PathBuf> = Vec::new();
    let mut args = env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--iters" => iters = args.next().and_then(|v| v.parse().ok()).expect("--iters N"),
            "--tmp" => tmp = args.next().map(PathBuf::from),
            _ => files.push(PathBuf::from(a)),
        }
    }
    let tmp = tmp.expect("--tmp <dir> が必要です");
    fs::create_dir_all(&tmp).unwrap();
    let backups = tmp.join("backups");

    let mut entries = Vec::new();
    for file in &files {
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        let bytes = fs::read(file).unwrap();
        let decoded = decode(&bytes).expect("fixture は UTF-8");
        // save_atomic と save_checked は別のファイルへ書く（互いの書き込みで revision が食い違い、競合や無変更になるのを避ける）。
        let target = tmp.join(&name);
        let target_checked = tmp.join(format!("checked-{name}"));
        let _ = fs::remove_file(&target);
        let _ = fs::remove_file(&target_checked);

        let mut read = Vec::new();
        let mut dec = Vec::new();
        let mut enc = Vec::new();
        let mut rev = Vec::new();
        let mut save_changed = Vec::new();
        let mut save_same = Vec::new();
        let mut checked = Vec::new();

        // 暖機を 1 回分捨てる（iters + 1 回走らせて先頭を落とす）。
        // 内容は 1 回ごとに、末尾へ改行を 1 つ足す/外すで入れ替える（毎回、直前と違う内容になる）。
        let mut variant = bytes.clone();
        let mut last_revision: Option<String> = None;
        // 実際に書いた（Written）回数。iters + 1 と一致しなければ、測っているのが「変更あり」の保存ではない。
        let mut written_atomic = 0usize;
        let mut written_checked = 0usize;
        for i in 0..=iters {
            let t = Instant::now();
            let r = fs::read(file).unwrap();
            let d = micros(t);
            std::hint::black_box(&r);
            read.push(d);

            let t = Instant::now();
            let dd = decode(&r).unwrap();
            dec.push(micros(t));
            std::hint::black_box(&dd);

            let t = Instant::now();
            let e = encode(&decoded.text, &decoded.format);
            enc.push(micros(t));
            std::hint::black_box(&e);

            let t = Instant::now();
            let h = revision_of(&bytes);
            rev.push(micros(t));
            std::hint::black_box(&h);

            if i % 2 == 0 {
                variant.push(b'\n');
            } else {
                variant.pop();
            }
            let t = Instant::now();
            let outcome = save_atomic(&target, &variant).unwrap();
            save_changed.push(micros(t));
            if outcome == SaveOutcome::Written {
                written_atomic += 1;
            }

            let t = Instant::now();
            save_atomic(&target, &variant).unwrap();
            save_same.push(micros(t));

            let t = Instant::now();
            let res = save_checked(
                &target_checked,
                &variant,
                last_revision.as_deref(),
                false,
                &backups,
                DEFAULT_BACKUP_LIMITS,
            )
            .unwrap();
            checked.push(micros(t));
            if let CheckedSave::Saved { outcome, revision, .. } = res {
                if outcome == SaveOutcome::Written {
                    written_checked += 1;
                }
                last_revision = Some(revision);
            }
        }
        assert_eq!(written_atomic, iters + 1, "save_atomic_changed が毎回は書いていない");
        assert_eq!(written_checked, iters + 1, "save_checked_changed が毎回は書いていない");
        for v in [&mut read, &mut dec, &mut enc, &mut rev, &mut save_changed, &mut save_same, &mut checked] {
            v.remove(0);
        }
        entries.push(format!(
            "{{\"file\":{:?},\"bytes\":{},\"read\":{},\"decode\":{},\"encode\":{},\"revision\":{},\"save_atomic_changed\":{},\"save_atomic_unchanged\":{},\"save_checked_changed\":{}}}",
            name,
            bytes.len(),
            summary(read),
            summary(dec),
            summary(enc),
            summary(rev),
            summary(save_changed),
            summary(save_same),
            summary(checked)
        ));
        let _ = fs::remove_file(&target);
        let _ = fs::remove_file(&target_checked);
    }
    println!(
        "{{\"unit\":\"us\",\"iters\":{},\"profile\":{:?},\"files\":[{}]}}",
        iters,
        if cfg!(debug_assertions) { "debug" } else { "release" },
        entries.join(",")
    );
}
