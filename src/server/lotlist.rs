//! ロット一覧（品質データ SQLite の写し）。WaveLog routes/lotlist.py と同じ作り。

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::{IntoResponse, Json};
use serde_json::Value;

use super::error::{blocking, ApiError, ApiResult};
use super::state::AppState;
use crate::lot_list::{self, LotError, QueryOpts};

const NO_SOURCE: &str = "品質データの元ファイルが決まっていません。";

fn int_arg(a: &HashMap<String, String>, key: &str, default: i64) -> Result<i64, ApiError> {
    match a.get(key).map(|s| s.trim()) {
        None | Some("") => Ok(default),
        Some(v) => v.parse().map_err(|_| ApiError::bad_request(format!("{key} は整数で指定してください。"))),
    }
}

fn lot_error(e: LotError, source: Value) -> ApiError {
    match e {
        LotError::Invalid(m) => ApiError::bad_request(m),
        LotError::Failed(m) => ApiError::new(503, m).with("source", source),
    }
}

/// page, page_size, search, filters, sorts, group で、写しから引く（lot_list::query）。
pub async fn list(State(s): State<Arc<AppState>>, Query(a): Query<HashMap<String, String>>) -> ApiResult {
    let out = blocking(move || -> Result<Value, ApiError> {
        let (m, ll) = s.lot_mirror();
        let Some(path) = m.read_path() else {
            return Err(ApiError::bad_request("品質データの元ファイルが決まっていません。左の「データ」でファイルを指定してください。").with("source", m.source_info()));
        };
        let get = |k: &str| a.get(k).map_or("", String::as_str);
        let opts = QueryOpts {
            table: get("table"),
            preferred_table: &ll.table,
            page: int_arg(&a, "page", 1)?,
            page_size: int_arg(&a, "page_size", i64::try_from(ll.page_size).unwrap_or(200))?,
            search: get("search"),
            filters: get("filters"),
            sorts: get("sorts"),
            group: get("group") == "1",
            today: None,
        };
        let mut out = lot_list::query(&path, &opts).map_err(|e| lot_error(e, m.source_info()))?;
        if let Some(o) = out.as_object_mut() {
            o.insert("source".into(), m.source_info());
        }
        Ok(out)
    })
    .await??;
    Ok(Json(out).into_response())
}

/// いま読んでいるデータはいつのものか（共有は見に行かない）。
pub async fn source(State(s): State<Arc<AppState>>) -> ApiResult {
    let v = blocking(move || s.lot_mirror().0.source_info()).await?;
    Ok(Json(v).into_response())
}

/// 「再読込」: 共有から取り直す（変わっていなくても写し直す）。
pub async fn refresh(State(s): State<Arc<AppState>>) -> ApiResult {
    let out = blocking(move || -> Result<Value, ApiError> {
        let (m, _) = s.lot_mirror();
        if !m.enabled() {
            return Err(ApiError::bad_request(NO_SOURCE).with("source", m.source_info()));
        }
        let res = m.refresh(true);
        Ok(serde_json::json!({"result": res, "source": m.source_info()}))
    })
    .await??;
    Ok(Json(out).into_response())
}

/// 選んだロットの全行（帳票の 1 枚＝同じロット番号の行のまとまり）。body: {lots: [ロット番号…]}
pub async fn lots(State(s): State<Arc<AppState>>, body: axum::body::Bytes) -> ApiResult {
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let lots = body.get("lots").and_then(Value::as_array).and_then(|a| {
        a.iter()
            .map(|x| match x {
                Value::String(t) => Some(t.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            })
            .collect::<Option<Vec<String>>>()
    });
    let Some(lots) = lots else { return Err(ApiError::bad_request("lots（ロット番号の一覧）が必要です。")) };
    let out = blocking(move || -> Result<Value, ApiError> {
        let (m, ll) = s.lot_mirror();
        let Some(path) = m.read_path() else {
            return Err(ApiError::bad_request(NO_SOURCE).with("source", m.source_info()));
        };
        lot_list::rows_of_lots(&path, &lots, "", &ll.table).map_err(|e| lot_error(e, m.source_info()))
    })
    .await??;
    Ok(Json(out).into_response())
}
