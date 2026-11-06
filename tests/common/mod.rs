//! テストの共通の道具: 本体の最小のコピー・サンプル DB・HTTP の呼び出し。
#![allow(dead_code)]

pub mod sample_db;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::Router;
use docmaker::config::Settings;
use docmaker::server::{router, AppState};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

pub fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn copy_dir(src: &Path, dst: &Path, skip: &[&str]) {
    std::fs::create_dir_all(dst).expect("mkdir");
    for e in std::fs::read_dir(src).expect("read_dir").flatten() {
        let (p, name) = (e.path(), e.file_name().to_string_lossy().into_owned());
        if skip.contains(&name.as_str()) {
            continue;
        }
        if p.is_dir() {
            copy_dir(&p, &dst.join(&name), skip);
        } else {
            std::fs::copy(&p, dst.join(&name)).expect("copy");
        }
    }
}

/// 本体の最小のコピー（vendor・layouts は除く）。入れ替えの試しに使う。
pub fn copy_tree(dst: &Path) {
    for d in ["src", "web", "config"] {
        copy_dir(&repo().join(d), &dst.join(d), &["vendor", "layouts"]);
    }
    for f in ["Cargo.toml", "Cargo.lock"] {
        std::fs::copy(repo().join(f), dst.join(f)).expect("copy");
    }
}

pub fn sample_db(path: &Path, rows: usize) {
    sample_db::build(path, rows, 7).expect("sample db");
}

/// 本体のコピーと、それを根にしたサーバー（settings は初期値に重ねる）。
pub struct Env {
    pub tmp: tempfile::TempDir,
    pub root: PathBuf,
    pub state: Arc<AppState>,
    pub app: Router,
}

impl Env {
    pub fn new(settings: Settings) -> Self {
        Self::build(|_| settings, |_| {})
    }

    /// 状態を作った直後に手を入れてから（共有する前に）サーバーを組む。
    pub fn with(settings: Settings, tweak: impl FnOnce(&mut AppState)) -> Self {
        Self::build(|_| settings, tweak)
    }

    /// 根のフォルダ（一時）が決まってから設定を作る版。
    pub fn build(make_settings: impl FnOnce(&Path) -> Settings, tweak: impl FnOnce(&mut AppState)) -> Self {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().to_path_buf();
        copy_tree(&root);
        let mut state = AppState::new(&root, Some(make_settings(&root)));
        tweak(Arc::get_mut(&mut state).expect("unique"));
        let app = router(state.clone());
        Self { tmp, root, state, app }
    }

    pub async fn send(&self, method: Method, uri: &str, body: Option<Vec<u8>>) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut b = Request::builder().method(method).uri(uri);
        if body.is_some() {
            b = b.header(header::CONTENT_TYPE, "application/json");
        }
        let req = b.body(Body::from(body.unwrap_or_default())).expect("request");
        let resp = self.app.clone().oneshot(req).await.expect("response");
        let (status, headers) = (resp.status(), resp.headers().clone());
        (status, headers, resp.into_body().collect().await.expect("body").to_bytes().to_vec())
    }

    pub async fn get(&self, uri: &str) -> (StatusCode, Value) {
        let (s, _, b) = self.send(Method::GET, uri, None).await;
        (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
    }

    pub async fn json(&self, method: Method, uri: &str, body: &Value) -> (StatusCode, Value) {
        let (s, _, b) = self.send(method, uri, Some(serde_json::to_vec(body).expect("json"))).await;
        (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
    }
}

pub fn settings(f: impl FnOnce(&mut Settings)) -> Settings {
    let mut s = Settings::default();
    f(&mut s);
    s
}
