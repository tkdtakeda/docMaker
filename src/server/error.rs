//! API の誤りの返し方（{"error": 文, …}）。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

pub struct ApiError {
    status: StatusCode,
    body: Value,
}

impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), body: json!({"error": message.into()}) }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }

    /// 返す JSON に項目を足す（例: source）。
    pub fn with(mut self, key: &str, value: Value) -> Self {
        if let Some(m) = self.body.as_object_mut() {
            m.insert(key.into(), value);
        }
        self
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

pub type ApiResult = Result<Response, ApiError>;

/// 重い処理（ファイル・DB）を、待ち受けの糸を止めずに別の糸で行う。
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f).await.map_err(|e| ApiError::new(500, format!("内部エラー: {e}")))
}
