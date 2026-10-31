use std::fmt;

const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// 保存時に使う改行コード。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eol {
    Lf,
    Crlf,
}

impl Eol {
    pub fn as_str(self) -> &'static str {
        match self {
            Eol::Lf => "\n",
            Eol::Crlf => "\r\n",
        }
    }
}

/// 読み込み時に記録する、バイト列上の形式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocumentFormat {
    /// 先頭に UTF-8 BOM があったか。
    pub bom: bool,
    /// 保存時に使う改行コード（混在していた場合は多数派）。
    pub eol: Eol,
    /// 元のバイト列に LF と CRLF が混在していたか。
    pub mixed_eol: bool,
}

impl Default for DocumentFormat {
    /// 新規文書の形式: BOM なし、LF。
    fn default() -> Self {
        DocumentFormat {
            bom: false,
            eol: Eol::Lf,
            mixed_eol: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decoded {
    /// 改行を LF に正規化した本文（BOM は含まない）。
    pub text: String,
    pub format: DocumentFormat,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// UTF-8 として不正。`valid_up_to` は先頭から正しく読めたバイト数。
    InvalidUtf8 { valid_up_to: usize },
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DecodeError::InvalidUtf8 { valid_up_to } => {
                write!(
                    f,
                    "not valid UTF-8 (first invalid byte at offset {valid_up_to})"
                )
            }
        }
    }
}

impl std::error::Error for DecodeError {}

/// バイト列を本文と形式に分ける。UTF-8 でなければエラー。
pub fn decode(bytes: &[u8]) -> Result<Decoded, DecodeError> {
    let (bom, body) = match bytes.strip_prefix(&BOM) {
        Some(rest) => (true, rest),
        None => (false, bytes),
    };
    let raw = std::str::from_utf8(body).map_err(|e| DecodeError::InvalidUtf8 {
        valid_up_to: e.valid_up_to() + if bom { BOM.len() } else { 0 },
    })?;

    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut text = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' if chars.peek() == Some(&'\n') => {
                chars.next();
                crlf += 1;
                text.push('\n');
            }
            '\n' => {
                lf += 1;
                text.push('\n');
            }
            other => text.push(other),
        }
    }

    let eol = if crlf > lf { Eol::Crlf } else { Eol::Lf };
    Ok(Decoded {
        text,
        format: DocumentFormat {
            bom,
            eol,
            mixed_eol: crlf > 0 && lf > 0,
        },
    })
}

/// 本文（LF）を、形式に従ってバイト列へ戻す。
/// `format.mixed_eol` は無視する（多数派の `eol` に揃えて出力する）。
pub fn encode(text: &str, format: &DocumentFormat) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + if format.bom { BOM.len() } else { 0 });
    if format.bom {
        out.extend_from_slice(&BOM);
    }
    match format.eol {
        Eol::Lf => out.extend_from_slice(text.as_bytes()),
        Eol::Crlf => {
            for (i, part) in text.split('\n').enumerate() {
                if i > 0 {
                    out.extend_from_slice(b"\r\n");
                }
                out.extend_from_slice(part.as_bytes());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fmt(bom: bool, eol: Eol, mixed: bool) -> DocumentFormat {
        DocumentFormat {
            bom,
            eol,
            mixed_eol: mixed,
        }
    }

    fn roundtrip(bytes: &[u8]) -> Vec<u8> {
        let d = decode(bytes).expect("decode");
        encode(&d.text, &d.format)
    }

    #[test]
    fn lf_roundtrip() {
        let src = "# 見出し\n本文\n\n- a\n- b\n".as_bytes();
        let d = decode(src).unwrap();
        assert_eq!(d.format, fmt(false, Eol::Lf, false));
        assert_eq!(d.text, "# 見出し\n本文\n\n- a\n- b\n");
        assert_eq!(roundtrip(src), src);
    }

    #[test]
    fn crlf_roundtrip_and_text_is_lf() {
        let src = "# 見出し\r\n本文\r\n".as_bytes();
        let d = decode(src).unwrap();
        assert_eq!(d.format, fmt(false, Eol::Crlf, false));
        assert_eq!(d.text, "# 見出し\n本文\n");
        assert_eq!(roundtrip(src), src);
    }

    #[test]
    fn bom_is_recorded_and_restored() {
        let mut src = vec![0xEF, 0xBB, 0xBF];
        src.extend_from_slice("あ\n".as_bytes());
        let d = decode(&src).unwrap();
        assert!(d.format.bom);
        assert_eq!(d.text, "あ\n");
        assert_eq!(roundtrip(&src), src);
    }

    #[test]
    fn bom_and_crlf_roundtrip() {
        let mut src = vec![0xEF, 0xBB, 0xBF];
        src.extend_from_slice("日本語\r\n二行目\r\n".as_bytes());
        let d = decode(&src).unwrap();
        assert_eq!(d.format, fmt(true, Eol::Crlf, false));
        assert_eq!(roundtrip(&src), src);
    }

    #[test]
    fn bom_only_file() {
        let src = [0xEF, 0xBB, 0xBF];
        let d = decode(&src).unwrap();
        assert_eq!(d.text, "");
        assert!(d.format.bom);
        assert_eq!(roundtrip(&src), src);
    }

    #[test]
    fn empty_file_defaults_to_lf_without_bom() {
        let d = decode(b"").unwrap();
        assert_eq!(d.text, "");
        assert_eq!(d.format, DocumentFormat::default());
        assert_eq!(roundtrip(b""), b"");
    }

    #[test]
    fn no_trailing_newline_is_kept() {
        assert_eq!(roundtrip(b"a\r\nb"), b"a\r\nb");
        assert_eq!(roundtrip(b"a\nb"), b"a\nb");
    }

    #[test]
    fn mixed_eol_majority_crlf() {
        let src = b"a\r\nb\r\nc\nd\r\n";
        let d = decode(src).unwrap();
        assert_eq!(d.format, fmt(false, Eol::Crlf, true));
        assert_eq!(d.text, "a\nb\nc\nd\n");
        // 保存すると多数派 (CRLF) に揃う。
        assert_eq!(encode(&d.text, &d.format), b"a\r\nb\r\nc\r\nd\r\n");
    }

    #[test]
    fn mixed_eol_majority_lf() {
        let src = b"a\nb\nc\r\nd\n";
        let d = decode(src).unwrap();
        assert_eq!(d.format, fmt(false, Eol::Lf, true));
        assert_eq!(encode(&d.text, &d.format), b"a\nb\nc\nd\n");
    }

    #[test]
    fn mixed_eol_tie_prefers_lf() {
        let d = decode(b"a\r\nb\nc").unwrap();
        assert_eq!(d.format, fmt(false, Eol::Lf, true));
    }

    #[test]
    fn lone_cr_is_kept_as_a_character() {
        let src = b"a\rb\r\nc\r\n";
        let d = decode(src).unwrap();
        assert_eq!(d.text, "a\rb\nc\n");
        assert_eq!(d.format, fmt(false, Eol::Crlf, false));
        assert_eq!(roundtrip(src), src);
    }

    #[test]
    fn trailing_cr_then_lf_pair_is_crlf() {
        let d = decode(b"\r\n\r\n").unwrap();
        assert_eq!(d.text, "\n\n");
        assert_eq!(d.format.eol, Eol::Crlf);
    }

    #[test]
    fn invalid_utf8_is_rejected_with_offset() {
        let err = decode(&[b'a', 0xFF, b'b']).unwrap_err();
        assert_eq!(err, DecodeError::InvalidUtf8 { valid_up_to: 1 });
        // Shift_JIS の「あ」(82 A0)
        assert!(decode(&[0x82, 0xA0]).is_err());
    }

    #[test]
    fn invalid_utf8_offset_includes_bom() {
        let err = decode(&[0xEF, 0xBB, 0xBF, b'a', 0xC3]).unwrap_err();
        assert_eq!(err, DecodeError::InvalidUtf8 { valid_up_to: 4 });
    }

    #[test]
    fn encode_ignores_mixed_flag_and_uses_eol() {
        let f = fmt(true, Eol::Crlf, true);
        assert_eq!(
            encode("x\ny", &f),
            [&[0xEF, 0xBB, 0xBF][..], b"x\r\ny"].concat()
        );
    }

    #[test]
    fn non_ascii_text_is_preserved() {
        let src = "絵文字😀と結合文字e\u{301}\r\n".as_bytes();
        assert_eq!(roundtrip(src), src);
    }
}
