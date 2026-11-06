//! 画面から変える設定（品質データの元ファイルなど）。data/user_settings.json に保存する。

use std::sync::Arc;

use axum::extract::State;
use axum::response::{IntoResponse, Json};
use serde_json::{json, Map, Value};

use super::error::{blocking, ApiError, ApiResult};
use super::state::AppState;
use crate::fsio::write_json_atomic;

/// 画面から変えてよい項目（間隔などは設定ファイルで）
const LOT_KEYS: [&str; 2] = ["source", "table"];
const MAX_LEN: usize = 500;

fn current(s: &AppState) -> Value {
    let ll = s.effective().lot_list;
    json!({"lot_list": {"source": ll.source, "table": ll.table, "page_size": ll.page_size}})
}

pub async fn get(State(s): State<Arc<AppState>>) -> ApiResult {
    let v = blocking(move || current(&s)).await?;
    Ok(Json(v).into_response())
}

pub async fn post(State(s): State<Arc<AppState>>, body: axum::body::Bytes) -> ApiResult {
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let Some(ll) = body.get("lot_list").and_then(Value::as_object) else {
        return Err(ApiError::bad_request("lot_list が必要です。"));
    };
    let mut clean = Map::new();
    for k in LOT_KEYS {
        let Some(v) = ll.get(k) else { continue };
        match v.as_str() {
            Some(t) if t.chars().count() <= MAX_LEN && !t.contains('\0') => {
                // パスのコピーで付く引用符を外す
                clean.insert(k.into(), json!(t.trim().trim_matches('"')));
            }
            _ => return Err(ApiError::bad_request(format!("{k} が正しくありません（{MAX_LEN} 文字までの文字列）。"))),
        }
    }
    let out = blocking(move || -> std::io::Result<Value> {
        let path = s.user_settings_path();
        let mut cur = match crate::fsio::read_json(&path) {
            Ok(Some(Value::Object(m))) => m,
            _ => Map::new(),
        };
        let mut lot = cur.get("lot_list").and_then(Value::as_object).cloned().unwrap_or_default();
        lot.extend(clean);
        cur.insert("lot_list".into(), Value::Object(lot));
        write_json_atomic(&path, &Value::Object(cur), true, 2.0)?;
        Ok(current(&s))
    })
    .await?
    .map_err(|e| ApiError::new(503, format!("設定を保存できません：{e}")))?;
    Ok(Json(out).into_response())
}
