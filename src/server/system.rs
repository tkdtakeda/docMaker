//! 画面・版・起動の確認（/api/instance）・心拍・利用状況。

use std::sync::{Arc, OnceLock};

use axum::extract::State;
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Json};
use regex::Regex;
use serde_json::{json, Value};

use super::error::{blocking, ApiError, ApiResult};
use super::state::{me, AppState};
use crate::config::APP_ID;
use crate::fsio::now_iso;
use crate::version::{APP_VERSION, CHANGELOG};

fn asset_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r#"((?:href|src)=")((?:css|js)/[^"?]+)(")"#).expect("asset pattern"))
}

/// css・js の URL に指紋を付ける（古い JS を使い回さない）。
pub fn stamp_assets(html: &str, build: &str) -> String {
    asset_re().replace_all(html, |m: &regex::Captures<'_>| format!("{}{}?v={build}{}", &m[1], &m[2], &m[3])).into_owned()
}

/// 画面。いつもサーバーから（キャッシュしない）。
pub async fn index(State(s): State<Arc<AppState>>) -> ApiResult {
    let path = s.web_dir.join("index.html");
    let build = s.build.clone();
    let html = blocking(move || std::fs::read_to_string(path)).await?.map_err(|e| ApiError::new(500, format!("画面（index.html）を読めません: {e}")))?;
    let mut resp = stamp_assets(&html, &build).into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(resp)
}

pub async fn build() -> Json<Value> {
    Json(json!({"version": APP_VERSION}))
}

pub async fn changelog() -> Json<Value> {
    Json(json!({"version": APP_VERSION, "entries": CHANGELOG}))
}

pub async fn health() -> Json<Value> {
    Json(json!({"status": "ok"}))
}

/// 心拍のついでに利用状況を書き（20 秒ごと・裏で）、新しい版があるかを返す（見出しの札）。
pub async fn heartbeat(State(s): State<Arc<AppState>>) -> Json<Value> {
    let (login, pc) = me();
    s.presence.touch_async(&login, &pc);
    Json(json!({"version": s.presence.version_notice(), "me": {"login": login, "pc": pc}}))
}

/// 利用状況（だれが・どの PC で・どの版を使っているか）。
pub async fn presence_fleet(State(s): State<Arc<AppState>>) -> ApiResult {
    let fleet = blocking(move || s.presence.fleet()).await?;
    Ok(Json(fleet).into_response())
}

/// 起動の確認（画面・起動の仕組みが尋ねる）。
pub async fn instance(State(s): State<Arc<AppState>>) -> ApiResult {
    let state = Arc::clone(&s);
    let disk = blocking(move || state.disk_build()).await?;
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    Ok(Json(json!({
        "app": APP_ID, "version": APP_VERSION, "build": s.build,
        // 起動したあとにプログラムのファイルが入れ替わった（このサーバーは古い）。開き直す必要がある
        "stale": disk != s.build,
        "app_path": s.base_dir.display().to_string(), "pid": std::process::id(), "runtime": "rust", "exe": exe,
        "status": "ready", "server_time": now_iso(),
    }))
    .into_response())
}
