//! 版管理・サーバーの基本・利用状況のテスト。  cargo test
//!
//! 版を上げずにプログラムを変えると release_matches が失敗して、直し方を言う。
//! 手順: プログラムを直す → src/version.rs の APP_VERSION と CHANGELOG の先頭、Cargo.toml の version を上げる
//!       → cargo run --bin release -- --release → cargo test

mod common;

use std::time::Duration;

use axum::http::Method;
use common::{copy_tree, repo, settings, Env};
use docmaker::build_info::{fingerprint, record_release, release_digest};
use docmaker::presence::{terminal_key, Presence};
use docmaker::version::{version_key, APP_VERSION, CHANGELOG, RELEASE_DIGEST, RELEASE_VERSION};
use serde_json::{json, Value};

#[test]
fn changelog_head_is_current() {
    assert_eq!(CHANGELOG[0].version, APP_VERSION);
    let keys: Vec<_> = CHANGELOG.iter().map(|e| version_key(e.version)).collect();
    let mut sorted = keys.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(keys, sorted, "更新履歴は新しい版が上");
}

#[test]
fn cargo_version_matches_app_version() {
    assert_eq!(env!("CARGO_PKG_VERSION"), APP_VERSION, "Cargo.toml の version と src/version.rs の APP_VERSION を合わせてください");
}

#[test]
fn version_key_compares_numbers() {
    assert!(version_key("1.10.0") > version_key("1.9.3"));
    assert_eq!(version_key("2"), (2, 0, 0));
    assert_eq!(version_key("x.y"), (0, 0, 0));
}

/// 配る物の中身が、記録（RELEASE_*）と同じか。違えば、版の上げ忘れ。
#[test]
fn release_matches() {
    let now = release_digest(&repo());
    assert_eq!(
        (RELEASE_VERSION, RELEASE_DIGEST),
        (APP_VERSION, now.as_str()),
        "プログラムが変わっています（記録 {RELEASE_VERSION}・{RELEASE_DIGEST} → いま {APP_VERSION}・{now}）。\
         版を上げて（src/version.rs の APP_VERSION と CHANGELOG の先頭、Cargo.toml の version）から `cargo run --bin release -- --release`。\
         まだ配っていない版の直しなら `cargo run --bin release -- --amend`。"
    );
}

#[test]
fn fingerprint_changes_when_a_file_changes() {
    let t = tempfile::tempdir().unwrap();
    copy_tree(t.path());
    let a = fingerprint(t.path());
    std::fs::write(t.path().join("web/index.html"), "<!-- changed -->").unwrap();
    assert_ne!(a, fingerprint(t.path()));
}

#[test]
fn digest_ignores_line_endings_and_docs() {
    let t = tempfile::tempdir().unwrap();
    copy_tree(t.path());
    let a = release_digest(t.path());
    std::fs::write(t.path().join("README.md"), "説明だけ").unwrap();
    let p = t.path().join("web/index.html");
    let crlf = String::from_utf8(std::fs::read(&p).unwrap()).unwrap().replace('\n', "\r\n");
    std::fs::write(&p, crlf).unwrap();
    assert_eq!(a, release_digest(t.path()));
}

#[test]
fn record_release_refuses_without_bump() {
    let t = tempfile::tempdir().unwrap();
    copy_tree(t.path());
    record_release(t.path(), true).unwrap(); // コピーは vendor などを除くので、先に記録し直す
    assert!(record_release(t.path(), false).unwrap().contains("記録済み"));
    std::fs::write(t.path().join("web/index.html"), "<!-- changed -->").unwrap();
    let err = record_release(t.path(), false).unwrap_err();
    assert!(err.contains("版を上げて"), "{err}");
    assert!(record_release(t.path(), true).unwrap().contains("記録しました"));
}

#[tokio::test]
async fn instance_and_stale() {
    let env = Env::with(settings(|_| {}), |s| s.disk_build_ttl = Duration::ZERO);
    let (_, r) = env.get("/api/instance").await;
    assert_eq!((r["app"].as_str(), r["version"].as_str(), r["stale"].as_bool()), (Some("docMaker"), Some(APP_VERSION), Some(false)));
    // 起動したあとにプログラムのファイルが入れ替わった → 古いサーバー
    std::fs::create_dir_all(env.root.join("web/js")).unwrap();
    std::fs::write(env.root.join("web/js/new.js"), "// new").unwrap();
    let (_, r) = env.get("/api/instance").await;
    assert_eq!(r["stale"], json!(true));
}

#[tokio::test]
async fn index_has_fingerprint_urls_and_no_store() {
    let env = Env::new(settings(|_| {}));
    let (status, headers, body) = env.send(Method::GET, "/", None).await;
    let html = String::from_utf8(body).unwrap();
    assert_eq!(status, 200);
    assert_eq!(headers["cache-control"], "no-store");
    assert!(html.contains(&format!("js/core.js?v={}", env.state.build)), "{html}");
    assert!(html.contains(&format!("css/tokens.css?v={}", env.state.build)));
}

#[tokio::test]
async fn static_files_are_served_with_revalidation() {
    let env = Env::new(settings(|_| {}));
    let (status, headers, body) = env.send(Method::GET, "/report.html", None).await;
    assert_eq!(status, 200);
    assert_eq!(headers["cache-control"], "no-cache");
    assert!(String::from_utf8_lossy(&body).contains("report/js/adapter.js"));
    assert_eq!(env.send(Method::GET, "/js/core.js", None).await.0, 200);
}

#[tokio::test]
async fn changelog_and_build() {
    let env = Env::new(settings(|_| {}));
    assert_eq!(env.get("/api/build").await.1["version"], json!(APP_VERSION));
    assert_eq!(env.get("/api/changelog").await.1["entries"][0]["version"], json!(APP_VERSION));
    assert_eq!(env.get("/api/health").await.1["status"], json!("ok"));
}

#[tokio::test]
async fn heartbeat_writes_presence() {
    let env = Env::new(settings(|_| {}));
    let (s, _) = env.json(Method::POST, "/api/heartbeat", &json!({"visible": true})).await;
    assert_eq!(s, 200);
    let mut f = Value::Null;
    for _ in 0..100 {
        f = env.get("/api/presence").await.1;
        if f["total"] == json!(1) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(f["total"], json!(1), "{f}");
    assert_eq!(f["items"][0]["online"], json!(true));
    assert_eq!(f["items"][0]["version"], json!(APP_VERSION));
}

// ---------------------------------------------------------------- 利用状況
fn presence_in(t: &tempfile::TempDir) -> (std::sync::Arc<Presence>, std::path::PathBuf) {
    let dir = t.path().join("p");
    (Presence::new(Some(dir.clone())), dir)
}

fn write_hist(dir: &std::path::Path, key: &str, version: &str) {
    std::fs::create_dir_all(dir.join("history")).unwrap();
    let at = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let rec = json!({"key": key, "login": "u", "pc": "pc", "version": version, "lastAt": at, "sessions": 1});
    std::fs::write(dir.join("history").join(format!("{key}.json")), rec.to_string()).unwrap();
}

#[test]
fn latest_is_newest_of_all() {
    let t = tempfile::tempdir().unwrap();
    let (p, dir) = presence_in(&t);
    write_hist(&dir, "a", "0.9.0");
    write_hist(&dir, "b", "0.100.0");
    write_hist(&dir, "c", "0.2.0");
    assert_eq!(p.latest_version().as_deref(), Some("0.100.0")); // 数で比べる（文字なら 0.9.0）
    p.refresh_newest();
    let n = p.version_notice().unwrap();
    assert_eq!((n["latestVersion"].as_str(), n["outdated"].as_bool()), (Some("0.100.0"), Some(true)));
}

#[test]
fn not_outdated_when_newest() {
    let t = tempfile::tempdir().unwrap();
    let (p, dir) = presence_in(&t);
    write_hist(&dir, "a", APP_VERSION);
    p.refresh_newest();
    assert_eq!(p.version_notice().unwrap()["outdated"], json!(false));
}

#[test]
fn unknown_is_none_not_false() {
    let t = tempfile::tempdir().unwrap();
    let (p, _) = presence_in(&t);
    assert!(p.version_notice().is_none()); // 数えていないときは「分からない」
}

#[test]
fn unreadable_file_is_kept() {
    let t = tempfile::tempdir().unwrap();
    let (p, dir) = presence_in(&t);
    std::fs::create_dir_all(dir.join("history")).unwrap();
    let bad = dir.join("history/x.json");
    std::fs::write(&bad, "{ broken").unwrap();
    p.fleet();
    assert!(bad.exists()); // 読めないものは消さない
}

#[test]
fn touch_then_leave() {
    let t = tempfile::tempdir().unwrap();
    let (p, _) = presence_in(&t);
    assert!(p.touch("u", "pc1", true));
    let f = p.fleet();
    assert_eq!((f["total"].as_u64(), f["online"].as_u64()), (Some(1), Some(1)));
    p.leave("u", "pc1");
    let f = p.fleet();
    assert_eq!((f["total"].as_u64(), f["online"].as_u64()), (Some(1), Some(0))); // 記録は残り、いま使っているは消える
    assert_eq!(f["items"][0]["sessions"], json!(1));
}

#[test]
fn key_is_safe_for_filenames() {
    let k = terminal_key("a:b", "pc 1");
    assert!(!k.chars().any(|c| "\\/:*?\"<>|".contains(c) || c.is_whitespace()), "{k}");
    assert_eq!(terminal_key("tanaka", "PC-B"), "PC-B@tanaka");
}
