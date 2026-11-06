//! HTTP サーバー（axum）。URL と JSON の形は、Flask 版と同じ。

mod error;
mod lotlist;
mod reports;
mod settings;
mod state;
mod system;

use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::http::{header, HeaderValue};
use axum::routing::{get, post};
use axum::Router;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeaderLayer;

pub use state::{me, AppState, DISK_BUILD_TTL};
pub use system::stamp_assets;

/// ひな形（Excel）の保存のため
pub const MAX_BODY: usize = 40 * 1024 * 1024;

pub fn router(state: Arc<AppState>) -> Router {
    // 画面のファイルは web/ から。毎回、変わっていないか確かめさせる（Flask の静的ファイルと同じ）
    let statics = tower::ServiceBuilder::new()
        .layer(SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-cache")))
        .service(ServeDir::new(&state.web_dir).append_index_html_on_directories(false));
    Router::new()
        .route("/", get(system::index))
        .route("/api/build", get(system::build))
        .route("/api/changelog", get(system::changelog))
        .route("/api/health", get(system::health))
        .route("/api/heartbeat", post(system::heartbeat))
        .route("/api/presence", get(system::presence_fleet))
        .route("/api/instance", get(system::instance))
        .route("/api/settings", get(settings::get).post(settings::post))
        .route("/api/lotlist", get(lotlist::list))
        .route("/api/lotlist/source", get(lotlist::source))
        .route("/api/lotlist/refresh", post(lotlist::refresh))
        .route("/api/lotlist/lots", post(lotlist::lots))
        .route("/api/reports/{name}", get(reports::list))
        .route("/api/reports/{name}/delete", post(reports::delete))
        .route("/api/reports/{name}/{rid}", get(reports::get).put(reports::put))
        .fallback_service(statics)
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(state)
}
