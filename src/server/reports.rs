//! 帳票（プリセット）とひな形の保存（画面の report/js/adapter.js の CDB.db が呼ぶ）。

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Json};
use serde_json::{json, Value};

use super::error::{blocking, ApiError, ApiResult};
use super::state::AppState;
use crate::report_store::{ReportStore, StoreError, MAX_BYTES};

fn store(s: &AppState) -> ReportStore {
    ReportStore::new(s.reports_root())
}

pub async fn list(State(s): State<Arc<AppState>>, Path(name): Path<String>) -> ApiResult {
    let out = blocking(move || {
        let st = store(&s);
        st.list(&name).map(|items| json!({"items": items, "dir": st.root().display().to_string()}))
    })
    .await?
    .map_err(|e| match e {
        StoreError::Invalid(m) => ApiError::bad_request(m),
        StoreError::Io(e) => ApiError::new(503, format!("帳票の保存先を読めません：{e}")),
    })?;
    Ok(Json(out).into_response())
}

pub async fn get(State(s): State<Arc<AppState>>, Path((name, rid)): Path<(String, String)>) -> ApiResult {
    let rec = blocking(move || store(&s).get(&name, &rid))
        .await?
        .map_err(|e| match e {
            StoreError::Invalid(m) => ApiError::bad_request(m),
            StoreError::Io(e) => ApiError::new(503, format!("帳票を読めません：{e}")),
        })?;
    match rec {
        Some(item) => Ok(Json(json!({"item": item})).into_response()),
        None => Err(ApiError::new(404, "帳票が見つかりません")),
    }
}

pub async fn put(State(s): State<Arc<AppState>>, Path((name, rid)): Path<(String, String)>, body: Bytes) -> ApiResult {
    let size = body.len();
    if size > MAX_BYTES {
        return Err(ApiError::new(413, format!("大きすぎます（{}MB まで）", MAX_BYTES / 1024 / 1024)));
    }
    let rec: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let id = rid.clone();
    blocking(move || store(&s).put(&name, &rid, &rec, size)).await?.map_err(|e| match e {
        StoreError::Invalid(m) => ApiError::bad_request(m),
        StoreError::Io(e) => ApiError::new(503, format!("帳票を保存できません（保存先：{e}）")),
    })?;
    Ok(Json(json!({"ok": true, "id": id})).into_response())
}

/// body: {ids: [ID…]}。消した数を返す。
pub async fn delete(State(s): State<Arc<AppState>>, Path(name): Path<String>, body: Bytes) -> ApiResult {
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let Some(ids) = body.get("ids").and_then(Value::as_array).cloned() else {
        return Err(ApiError::bad_request("ids が必要です"));
    };
    let n = blocking(move || store(&s).delete(&name, &ids)).await?.map_err(|e| match e {
        StoreError::Invalid(m) => ApiError::bad_request(m),
        StoreError::Io(e) => ApiError::new(503, format!("帳票を削除できません：{e}")),
    })?;
    Ok(Json(json!({"ok": true, "deleted": n})).into_response())
}
