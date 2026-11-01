use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::Path;

/// ディスク上のバイト列の revision（SHA-256 の 16 進、小文字 64 桁）。
pub fn revision_of(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// ファイルの現在の状態。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiskState {
    Present { revision: String },
    Missing,
}

/// `path` の現在の内容の revision。ファイルがなければ `Missing`。
/// シンボリックリンクはリンク先の内容を読む。
pub fn disk_state(path: &Path) -> io::Result<DiskState> {
    match fs::read(path) {
        Ok(bytes) => Ok(DiskState::Present {
            revision: revision_of(&bytes),
        }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(DiskState::Missing),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revision_is_the_sha256_hex_of_the_bytes() {
        // "abc" の SHA-256（FIPS 180-2 の例）。
        assert_eq!(
            revision_of(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(revision_of(b"").len(), 64);
        assert_ne!(revision_of(b"a"), revision_of(b"b"));
    }
}
