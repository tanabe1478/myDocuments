//! 既定のブラウザでリンクを開く。開けるのは http と https（ホストのあるもの）だけ。
//! 検査（`validate`）と開く処理（`open`）を分けてあり、単体テストは検査だけを呼ぶ（ブラウザは開かない）。
//! フロントエンドも同じ検査をするが、Web UI の側は信用しないので、ここでも必ず検査する。

use crate::error::{CommandError, ErrorKind};
use tauri::{AppHandle, Url};
use tauri_plugin_opener::OpenerExt;

/// 長すぎる文字列は受け付けない（リンクの URL として現実的な上限）。
const MAX_URL_LEN: usize = 8192;

/// 開いてよい URL か検査して、解析した URL を返す。http / https で、ホストがあるものだけ。それ以外は InvalidInput。
pub fn validate(raw: &str) -> Result<Url, CommandError> {
    let invalid = |message: &str| CommandError::new(ErrorKind::InvalidInput, message);
    if raw.len() > MAX_URL_LEN {
        return Err(invalid("the url is too long"));
    }
    // 前後の空白は受け付けない（解析器が黙って取り除くので、先に弾く）。
    if raw.trim() != raw {
        return Err(invalid("the url has surrounding whitespace"));
    }
    let url = Url::parse(raw).map_err(|_| invalid("the url is not valid"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(invalid("only http and https urls can be opened"));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(invalid("the url has no host"));
    }
    // 解析器は "https:example.com" や "http:///host" のような崩れた書き方を補って受け入れる。書かれたとおりの形（scheme://host）だけを通す。
    let after_scheme = raw.get(url.scheme().len()..).unwrap_or_default();
    let authority = after_scheme.strip_prefix("://").unwrap_or_default();
    if authority.is_empty() || authority.starts_with(['/', '\\', '?', '#']) {
        return Err(invalid("the url must be written as scheme://host"));
    }
    Ok(url)
}

/// 検査を通った URL だけを、既定のブラウザで開く。
pub fn open(app: &AppHandle, raw: &str) -> Result<(), CommandError> {
    let url = validate(raw)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| CommandError::new(ErrorKind::Io, e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(raw: &str) -> Option<ErrorKind> {
        validate(raw).err().map(|e| e.kind)
    }

    #[test]
    fn allows_http_and_https_with_a_host() {
        for raw in [
            "http://example.com",
            "https://example.com/path?q=1#frag",
            "https://example.com:8443/a",
            "https://user@example.com/",
            "http://127.0.0.1:4173/",
            "https://[::1]/",
            "https://日本語.example/パス",
            "HTTPS://EXAMPLE.COM/",
        ] {
            assert!(validate(raw).is_ok(), "{raw} should be allowed");
        }
    }

    #[test]
    fn normalizes_through_the_parser() {
        assert_eq!(validate("HTTPS://EXAMPLE.COM/a b").unwrap().as_str(), "https://example.com/a%20b");
    }

    #[test]
    fn rejects_other_schemes_as_invalid_input() {
        for raw in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "mailto:a@example.com",
            "tel:+81312345678",
            "ftp://example.com/",
            "data:text/html,<b>x</b>",
            "vscode://open",
            "ssh://example.com",
            "blob:https://example.com/uuid",
        ] {
            assert_eq!(kind(raw), Some(ErrorKind::InvalidInput), "{raw} should be rejected");
        }
    }

    #[test]
    fn rejects_relative_and_malformed_input() {
        for raw in [
            "",
            "   ",
            "#section",
            "./note.md",
            "../note.md",
            "/etc/passwd",
            "note.md",
            "example.com",
            "//example.com/",
            "https://",
            "http:///path",
            "https:example.com",
            " https://example.com",
            "https://example.com ",
            "https://exa mple.com/",
        ] {
            assert_eq!(kind(raw), Some(ErrorKind::InvalidInput), "{raw:?} should be rejected");
        }
    }

    #[test]
    fn rejects_overlong_urls() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
        assert_eq!(kind(&long), Some(ErrorKind::InvalidInput));
    }
}
