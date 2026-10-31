//! CRLF + BOM の文書を実ファイルとして開き、保存の往復でバイト列が保たれることを確認する。
//! fixture はバイト列から生成する（git の改行変換で壊れないように、ファイルとしては置かない）。

use docio::{decode, encode, save_atomic, Eol, SaveOutcome};
use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

const FIXTURE: &[u8] = b"\xEF\xBB\xBF# \xE8\xA6\x8B\xE5\x87\xBA\xE3\x81\x97\r\n\r\n\xE6\x9C\xAC\xE6\x96\x87\xE3\x81\xAE1\xE8\xA1\x8C\xE7\x9B\xAE\r\n- a\r\n- b\r\n";

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> TempDir {
        // テストは並列に走るので、テストごとに別のディレクトリを使う。
        let dir =
            std::env::temp_dir().join(format!("docio-fixture-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn open(path: &std::path::Path) -> docio::Decoded {
    decode(&fs::read(path).unwrap()).expect("fixture is UTF-8")
}

#[test]
fn unmodified_save_keeps_bytes_and_mtime() {
    let dir = TempDir::new("unmodified");
    let path = dir.0.join("crlf-bom.md");
    fs::write(&path, FIXTURE).unwrap();
    let past = SystemTime::now() - Duration::from_secs(86_400);
    OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(past)
        .unwrap();
    let mtime = fs::metadata(&path).unwrap().modified().unwrap();

    let d = open(&path);
    assert!(d.format.bom);
    assert_eq!(d.format.eol, Eol::Crlf);
    assert!(!d.text.contains('\r'), "the editing text is LF only");

    let outcome = save_atomic(&path, &encode(&d.text, &d.format)).unwrap();

    assert_eq!(outcome, SaveOutcome::Unchanged);
    assert_eq!(fs::read(&path).unwrap(), FIXTURE);
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), mtime);
}

#[test]
fn one_character_edit_keeps_bom_and_crlf() {
    let dir = TempDir::new("edited");
    let path = dir.0.join("crlf-bom.md");
    fs::write(&path, FIXTURE).unwrap();

    let d = open(&path);
    let edited = d.text.replacen("1行目", "2行目", 1);
    assert_ne!(edited, d.text);

    let outcome = save_atomic(&path, &encode(&edited, &d.format)).unwrap();
    assert_eq!(outcome, SaveOutcome::Written);

    let bytes = fs::read(&path).unwrap();
    assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]), "BOM is kept");
    let body = &bytes[3..];
    // すべての LF が CRLF の一部。
    let lf = body.iter().filter(|&&b| b == b'\n').count();
    let crlf = body.windows(2).filter(|w| w == b"\r\n").count();
    assert_eq!(lf, crlf);
    assert_eq!(lf, 5);
    // 変更は 1 文字だけ（'1' → '2'）。
    let expected = String::from_utf8(FIXTURE.to_vec())
        .unwrap()
        .replacen("1行目", "2行目", 1);
    assert_eq!(bytes, expected.into_bytes());
    assert_eq!(
        fs::read_dir(&dir.0).unwrap().count(),
        1,
        "no temp files left"
    );
}

#[test]
fn non_utf8_file_is_refused_on_open() {
    let dir = TempDir::new("sjis");
    let path = dir.0.join("sjis.md");
    fs::write(&path, [0x82, 0xA0, 0x0D, 0x0A]).unwrap();
    assert!(decode(&fs::read(&path).unwrap()).is_err());
}
