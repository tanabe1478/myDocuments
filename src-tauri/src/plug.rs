//! 独自プロトコル `plug:`（ADR-005 の案 2a）。隔離した操作の段（段 2）の Worker のホストのページと、その仲介のコードだけを返す。
//!
//! 返すのは、名前を決めて固定した 2 つのファイルだけ。どちらもビルド時に埋め込む（`include_str!`）ので、ファイルシステムから
//! 任意のファイルを読むことはない。名前の解釈（`..`、パーセントエンコード、大文字小文字の正規化、先頭の `/` の補完）は
//! しない。決めた文字列と完全に一致するパスだけが 200、それ以外はすべて 404。
//!
//! 応答の CSP は、ホストのページの中で動く文脈（仲介のコードと、そこから作る blob の Worker）の上限を決める:
//! `default-src 'none'`（ネットワーク、画像、フレームなどはすべて拒否）、`script-src plug:`（`'self'` ではなく `plug:`。
//! 独自プロトコルの origin は不透明で `'self'` が一致しない。K2）、`worker-src blob:`（部品のコードを blob の Worker にする）。
//! blob の Worker は、作った文脈の CSP を継承する。

use std::borrow::Cow;
use tauri::http::{header, Method, Request, Response, StatusCode};

/// ホストのページ（sandbox の iframe の中身）。ブラウザ版（e2e と dev）が配信するファイルと同じ元（src/plugin-host/）。
const HOST_HTML: &str = include_str!("../../src/plugin-host/host.html");
/// 仲介のコード。ホストのページから `<script src>` で読み込む。
const RELAY_JS: &str = include_str!("../../src/plugin-host/relay.js");

/// 応答の Content-Security-Policy。
pub const CSP: &str = "default-src 'none'; script-src plug:; worker-src blob:";

/// 隔離の検証用のページ（feature `isolation-probe` のビルドだけ）。仲介のページと同じ条件の文脈で、検証のスクリプトを動かす。
#[cfg(feature = "isolation-probe")]
const PROBE_FRAME_HTML: &str = include_str!("../../src/isolated-plugins/probe-frame.html");
#[cfg(feature = "isolation-probe")]
const PROBE_FRAME_JS: &str = include_str!("../../src/isolated-plugins/probe-frame.js");

/// 返すファイルの一覧（パス、Content-Type、中身）。ここにない名前は 404。
#[cfg(not(feature = "isolation-probe"))]
const FILES: [(&str, &str, &str); 2] = [
    ("/host.html", "text/html; charset=utf-8", HOST_HTML),
    ("/relay.js", "text/javascript; charset=utf-8", RELAY_JS),
];
#[cfg(feature = "isolation-probe")]
const FILES: [(&str, &str, &str); 4] = [
    ("/host.html", "text/html; charset=utf-8", HOST_HTML),
    ("/relay.js", "text/javascript; charset=utf-8", RELAY_JS),
    (
        "/probe-frame.html",
        "text/html; charset=utf-8",
        PROBE_FRAME_HTML,
    ),
    (
        "/probe-frame.js",
        "text/javascript; charset=utf-8",
        PROBE_FRAME_JS,
    ),
];

fn status_only(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, CSP)
        .body(Cow::Borrowed(&b""[..]))
        .expect("static response")
}

/// `plug:` への要求に答える。GET と HEAD だけを受け付け、決めた名前だけを返す。
pub fn respond(request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let method = request.method();
    if method != Method::GET && method != Method::HEAD {
        return status_only(StatusCode::METHOD_NOT_ALLOWED);
    }
    // `Uri::path()` は、クエリとフラグメントを除いた、書かれたままのパス（デコードも正規化もしない）。
    let path = request.uri().path();
    let Some((_, content_type, body)) = FILES.iter().find(|(name, _, _)| *name == path) else {
        return status_only(StatusCode::NOT_FOUND);
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, *content_type)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, CSP)
        .header(header::CACHE_CONTROL, "no-store")
        .body(if method == Method::HEAD {
            Cow::Borrowed(&b""[..])
        } else {
            Cow::Borrowed(body.as_bytes())
        })
        .expect("static response")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(uri: &str) -> Response<Cow<'static, [u8]>> {
        respond(
            &Request::builder()
                .method("GET")
                .uri(uri)
                .body(Vec::new())
                .unwrap(),
        )
    }

    fn header_of<'a>(r: &'a Response<Cow<'static, [u8]>>, name: header::HeaderName) -> &'a str {
        r.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
    }

    #[test]
    fn serves_the_two_fixed_files_with_their_content() {
        let host = get("plug://localhost/host.html");
        assert_eq!(host.status(), StatusCode::OK);
        assert_eq!(host.body().as_ref(), HOST_HTML.as_bytes());
        assert_eq!(
            header_of(&host, header::CONTENT_TYPE),
            "text/html; charset=utf-8"
        );

        let relay = get("plug://localhost/relay.js");
        assert_eq!(relay.status(), StatusCode::OK);
        assert_eq!(relay.body().as_ref(), RELAY_JS.as_bytes());
        assert_eq!(
            header_of(&relay, header::CONTENT_TYPE),
            "text/javascript; charset=utf-8"
        );
        assert!(!host.body().is_empty() && !relay.body().is_empty());
    }

    #[test]
    fn the_embedded_files_come_from_the_shared_source_directory() {
        // ブラウザ版が配信するファイルと同じ元（src/plugin-host/）。中身が同じであることは、ここで埋め込んだ文字列と
        // ディスク上のファイルを比べて確かめる。
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src")
            .join("plugin-host");
        assert_eq!(
            std::fs::read_to_string(root.join("host.html")).unwrap(),
            HOST_HTML
        );
        assert_eq!(
            std::fs::read_to_string(root.join("relay.js")).unwrap(),
            RELAY_JS
        );
    }

    #[test]
    fn every_response_carries_the_csp_and_nosniff() {
        for uri in [
            "plug://localhost/host.html",
            "plug://localhost/relay.js",
            "plug://localhost/missing.js",
            "plug://localhost/",
        ] {
            let r = get(uri);
            assert_eq!(header_of(&r, header::CONTENT_SECURITY_POLICY), CSP, "{uri}");
            assert_eq!(
                header_of(&r, header::X_CONTENT_TYPE_OPTIONS),
                "nosniff",
                "{uri}"
            );
        }
        assert_eq!(
            CSP,
            "default-src 'none'; script-src plug:; worker-src blob:"
        );
    }

    #[test]
    fn everything_else_is_404() {
        for uri in [
            "plug://localhost/",
            "plug://localhost",
            "plug://localhost/index.html",
            "plug://localhost/host.html/",
            "plug://localhost/host.htm",
            "plug://localhost/Host.html",
            "plug://localhost/HOST.HTML",
            "plug://localhost/relay.JS",
            "plug://localhost/../host.html",
            "plug://localhost/a/../host.html",
            "plug://localhost/./host.html",
            "plug://localhost/%2e%2e/host.html",
            "plug://localhost/%2E%2E/host.html",
            "plug://localhost/.%2e/host.html",
            "plug://localhost/%2fhost.html",
            "plug://localhost/%2Fhost.html",
            "plug://localhost/host%2ehtml",
            "plug://localhost/host.html%00",
            "plug://localhost/%68ost.html",
            "plug://localhost//host.html",
            "plug://localhost//etc/passwd",
            "plug://localhost/etc/passwd",
            "plug://localhost/..%2f..%2fetc%2fpasswd",
            "plug://localhost/Cargo.toml",
            "plug://localhost/src/plugin-host/host.html",
            "plug://localhost/relay.js/..",
            "plug://localhost/\\host.html",
            "plug://localhost/host.html;x",
        ] {
            let r = get(uri);
            assert_eq!(r.status(), StatusCode::NOT_FOUND, "{uri}");
            assert!(r.body().is_empty(), "{uri}");
        }
    }

    #[cfg(not(feature = "isolation-probe"))]
    #[test]
    fn the_probe_pages_are_not_served_without_the_feature() {
        for uri in [
            "plug://localhost/probe-frame.html",
            "plug://localhost/probe-frame.js",
        ] {
            assert_eq!(get(uri).status(), StatusCode::NOT_FOUND, "{uri}");
        }
        assert_eq!(FILES.len(), 2);
    }

    #[cfg(feature = "isolation-probe")]
    #[test]
    fn the_probe_pages_are_served_with_the_same_csp_only_with_the_feature() {
        for (uri, body) in [
            ("plug://localhost/probe-frame.html", PROBE_FRAME_HTML),
            ("plug://localhost/probe-frame.js", PROBE_FRAME_JS),
        ] {
            let r = get(uri);
            assert_eq!(r.status(), StatusCode::OK, "{uri}");
            assert_eq!(r.body().as_ref(), body.as_bytes());
            assert_eq!(header_of(&r, header::CONTENT_SECURITY_POLICY), CSP);
        }
        assert_eq!(FILES.len(), 4);
    }

    #[test]
    fn a_query_does_not_change_which_file_is_served() {
        // クエリはファイルの選択に使わない（名前は path だけで決まる）。
        assert_eq!(
            get("plug://localhost/host.html?x=1").status(),
            StatusCode::OK
        );
        assert_eq!(
            get("plug://localhost/missing?host.html").status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn only_get_and_head_are_accepted() {
        for method in ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"] {
            let r = respond(
                &Request::builder()
                    .method(method)
                    .uri("plug://localhost/host.html")
                    .body(Vec::new())
                    .unwrap(),
            );
            assert_eq!(r.status(), StatusCode::METHOD_NOT_ALLOWED, "{method}");
            assert!(r.body().is_empty());
        }
        let head = respond(
            &Request::builder()
                .method("HEAD")
                .uri("plug://localhost/host.html")
                .body(Vec::new())
                .unwrap(),
        );
        assert_eq!(head.status(), StatusCode::OK);
        assert!(head.body().is_empty());
    }

    #[test]
    fn the_host_page_has_no_inline_script_and_loads_only_the_relay() {
        // CSP は script-src plug: だけ。インラインのスクリプトは動かないので、ページの中に書かない。
        let scripts: Vec<&str> = HOST_HTML.split("<script").skip(1).collect();
        assert_eq!(scripts.len(), 1);
        assert!(
            scripts[0].trim_start().starts_with("src=\"relay.js\""),
            "{}",
            scripts[0]
        );
        assert!(!HOST_HTML.contains("onload=") && !HOST_HTML.contains("javascript:"));
    }

    #[test]
    fn the_relay_does_not_evaluate_strings() {
        // 仲介のコードは、部品のコードを評価しない（blob の Worker に渡すだけ）。
        for forbidden in [
            "eval(",
            "new Function",
            "Function(",
            "document.write",
            "createElement('script",
            "createElement(\"script",
            "importScripts",
            "insertAdjacentHTML",
            "innerHTML",
        ] {
            assert!(
                !RELAY_JS.contains(forbidden),
                "relay.js contains {forbidden}"
            );
        }
    }
}
