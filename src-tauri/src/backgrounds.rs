//! 背景画像の取り込みと読み出し。Tauri に依存しない部分。
//!
//! 仕様 §13「画像の永続化」の判断: 元ファイルは参照せず、アプリのデータ領域へコピーする。
//! - 形式は拡張子ではなく先頭バイトで判定する（png / jpeg / webp）。
//! - 1 枚 20 MiB まで。
//! - 保存名は内容の SHA-256（小文字 16 進 64 文字）。これが imageId で、同じ内容は 1 つのファイルになる。
//! - 読み出しは imageId の形式だけを受け付けるので、パスの区切りや `..` は通らない。

use crate::documents::validate_path;
use crate::error::{CommandError, ErrorKind};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// 取り込める画像 1 枚の上限。
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Webp,
}

impl ImageFormat {
    pub fn mime(self) -> &'static str {
        match self {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::Webp => "image/webp",
        }
    }
}

/// 先頭バイトから形式を判定する。対応外は `None`。
pub fn sniff_format(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(ImageFormat::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageFormat::Jpeg)
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(ImageFormat::Webp)
    } else {
        None
    }
}

/// imageId の形式（小文字 16 進 64 文字）か。
pub fn is_valid_image_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// 内容の SHA-256 を小文字 16 進にしたもの。
pub fn image_id_of(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut id = String::with_capacity(64);
    for b in digest {
        id.push_str(&format!("{b:02x}"));
    }
    id
}

fn invalid(message: &str) -> CommandError {
    CommandError::new(ErrorKind::InvalidInput, message)
}

/// `path` の画像を `dir`（backgrounds ディレクトリ）へコピーし、imageId を返す。
pub fn import_from(path: &str, dir: &Path) -> Result<String, CommandError> {
    import_with_limit(path, dir, MAX_IMAGE_BYTES)
}

fn import_with_limit(path: &str, dir: &Path, limit: u64) -> Result<String, CommandError> {
    let p = validate_path(path)?;
    let file = File::open(&p)?;
    // 通常のファイルだけ。デバイスや名前付きパイプなど、終わりのないものは読まない。
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(invalid("not a regular file"));
    }
    if meta.len() > limit {
        return Err(invalid("the image is too large"));
    }
    // 取得後に大きくなる場合に備え、上限 + 1 バイトで読むのをやめる。
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid("the image is too large"));
    }
    if sniff_format(&bytes).is_none() {
        return Err(invalid("unsupported image format (png, jpeg or webp)"));
    }
    let id = image_id_of(&bytes);
    std::fs::create_dir_all(dir)?;
    // 同じ内容は同じ名前なので、既にあれば書き込まない（save_atomic が同一バイト列を判定する）。
    docio::save_atomic(&dir.join(&id), &bytes)?;
    Ok(id)
}

/// フロントエンドへ返す画像。バイト列は base64（JSON で運ぶため）。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundImageDto {
    pub mime: String,
    pub data: String,
}

/// `dir` から imageId の画像を読む。形式が不正な id は `InvalidInput`、無ければ `NotFound`。
pub fn read_from(image_id: &str, dir: &Path) -> Result<BackgroundImageDto, CommandError> {
    if !is_valid_image_id(image_id) {
        return Err(invalid("invalid image id"));
    }
    let bytes = std::fs::read(dir.join(image_id))?;
    let format = sniff_format(&bytes).ok_or_else(|| invalid("stored file is not a supported image"))?;
    Ok(BackgroundImageDto {
        mime: format.mime().to_string(),
        data: STANDARD.encode(&bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let d = std::env::temp_dir().join(format!(
                "ime-bg-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&d).unwrap();
            TempDir(d)
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
        fn write(&self, name: &str, bytes: &[u8]) -> String {
            let p = self.path(name);
            fs::write(&p, bytes).unwrap();
            p.to_string_lossy().into_owned()
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 1];
    const WEBP: &[u8] = b"RIFF\x04\0\0\0WEBPVP8 ";

    #[test]
    fn sniffs_formats_by_leading_bytes() {
        assert_eq!(sniff_format(PNG), Some(ImageFormat::Png));
        assert_eq!(sniff_format(JPEG), Some(ImageFormat::Jpeg));
        assert_eq!(sniff_format(WEBP), Some(ImageFormat::Webp));
        assert_eq!(ImageFormat::Webp.mime(), "image/webp");
    }

    #[test]
    fn rejects_other_formats_and_truncated_headers() {
        assert_eq!(sniff_format(b"GIF89a......"), None);
        assert_eq!(sniff_format(b"<svg xmlns='http://www.w3.org/2000/svg'/>"), None);
        assert_eq!(sniff_format(b"RIFF\0\0\0\0WAVEfmt "), None);
        assert_eq!(sniff_format(&PNG[..4]), None);
        assert_eq!(sniff_format(&[]), None);
    }

    #[test]
    fn the_extension_does_not_decide_the_format() {
        let dir = TempDir::new();
        let store = dir.path("store");
        // png の中身は、拡張子が .txt でも取り込める。
        let ok = dir.write("photo.txt", PNG);
        assert!(import_from(&ok, &store).is_ok());
        // 拡張子が .png でも、中身が画像でなければ取り込めない。
        let bad = dir.write("fake.png", b"not an image at all");
        assert_eq!(import_from(&bad, &store).unwrap_err().kind, ErrorKind::InvalidInput);
    }

    #[test]
    fn rejects_files_over_the_limit_and_accepts_exactly_the_limit() {
        let dir = TempDir::new();
        let store = dir.path("store");

        let over = dir.path("over.png");
        let mut f = File::create(&over).unwrap();
        f.write_all(PNG).unwrap();
        f.set_len(MAX_IMAGE_BYTES + 1).unwrap();
        drop(f);
        let err = import_from(over.to_str().unwrap(), &store).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidInput);
        assert!(err.message.contains("too large"));
        assert!(!store.exists(), "nothing is written for an oversized image");

        let exact = dir.path("exact.png");
        let mut f = File::create(&exact).unwrap();
        f.write_all(PNG).unwrap();
        f.set_len(MAX_IMAGE_BYTES).unwrap();
        drop(f);
        let id = import_from(exact.to_str().unwrap(), &store).unwrap();
        assert!(is_valid_image_id(&id));
    }

    #[test]
    fn rejects_relative_paths_directories_and_missing_files() {
        let dir = TempDir::new();
        let store = dir.path("store");
        assert_eq!(import_from("relative.png", &store).unwrap_err().kind, ErrorKind::InvalidInput);
        assert_eq!(
            import_from(dir.0.to_str().unwrap(), &store).unwrap_err().kind,
            ErrorKind::InvalidInput
        );
        assert_eq!(
            import_from(dir.path("missing.png").to_str().unwrap(), &store).unwrap_err().kind,
            ErrorKind::NotFound
        );
    }

    #[test]
    fn image_id_is_a_content_hash() {
        // SHA-256("abc")
        assert_eq!(
            image_id_of(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(is_valid_image_id(&image_id_of(b"abc")));
    }

    #[test]
    fn validates_image_ids() {
        let good = "a".repeat(64);
        assert!(is_valid_image_id(&good));
        for bad in [
            "",
            "abc",
            &"a".repeat(63),
            &"a".repeat(65),
            &"A".repeat(64),
            &"g".repeat(64),
            "../../etc/passwd",
            &format!("{}/../x", "a".repeat(58)),
            &format!("{}\\x", "a".repeat(62)),
            &format!("{}\0", "a".repeat(63)),
            &format!("{}.png", "a".repeat(60)),
        ] {
            assert!(!is_valid_image_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn identical_content_is_stored_once_under_its_hash() {
        let dir = TempDir::new();
        let store = dir.path("store");
        let a = dir.write("a.png", PNG);
        let b = dir.write("b-copy.png", PNG);

        let id_a = import_from(&a, &store).unwrap();
        let id_b = import_from(&b, &store).unwrap();

        assert_eq!(id_a, id_b);
        assert_eq!(id_a, image_id_of(PNG));
        let entries: Vec<_> = fs::read_dir(&store).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(entries, vec![std::ffi::OsString::from(&id_a)]);
        assert_eq!(fs::read(store.join(&id_a)).unwrap(), PNG);

        // 別の内容は別の id。
        let other = dir.write("c.jpg", JPEG);
        assert_ne!(import_from(&other, &store).unwrap(), id_a);
        assert_eq!(fs::read_dir(&store).unwrap().count(), 2);
    }

    #[test]
    fn the_copy_does_not_depend_on_the_original() {
        let dir = TempDir::new();
        let store = dir.path("store");
        let original = dir.write("orig.png", PNG);
        let id = import_from(&original, &store).unwrap();
        fs::remove_file(&original).unwrap();

        let image = read_from(&id, &store).unwrap();
        assert_eq!(image.mime, "image/png");
        assert_eq!(STANDARD.decode(image.data).unwrap(), PNG);
    }

    #[test]
    fn read_rejects_bad_ids_and_reports_missing_images() {
        let dir = TempDir::new();
        let store = dir.path("store");
        fs::create_dir_all(&store).unwrap();
        // ストアの外に置いたファイルへ、パス区切りで届かない。
        dir.write("secret", PNG);
        assert_eq!(read_from("../secret", &store).unwrap_err().kind, ErrorKind::InvalidInput);
        assert_eq!(read_from("", &store).unwrap_err().kind, ErrorKind::InvalidInput);
        assert_eq!(read_from(&"b".repeat(64), &store).unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn read_refuses_a_stored_file_that_is_not_an_image() {
        let dir = TempDir::new();
        let store = dir.path("store");
        fs::create_dir_all(&store).unwrap();
        let id = "c".repeat(64);
        fs::write(store.join(&id), b"plain text").unwrap();
        assert_eq!(read_from(&id, &store).unwrap_err().kind, ErrorKind::InvalidInput);
    }
}
