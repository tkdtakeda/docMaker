//! 設定。初期値 → config/settings.json（配る物）→ data/user_settings.json（画面から変える）の順に重ねる。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const APP_ID: &str = "docMaker";
pub const USER_SETTINGS: &str = "user_settings.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerCfg {
    pub host: String,
    pub port: u16,
    pub open_browser: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LotListCfg {
    pub source: String,
    pub table: String,
    pub page_size: u64,
    pub interval_sec: u64,
    pub stale_hours: f64,
}

/// 置き場（空なら既定の場所）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DirCfg {
    pub dir: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub server: ServerCfg,
    pub lot_list: LotListCfg,
    /// 帳票の置き場。空なら data/reports（この PC の中だけ）。共有フォルダを入れると全 PC で同じ帳票を使える
    pub reports: DirCfg,
    /// 空なら data/presence_docmaker（この PC の中だけ）。共有フォルダを入れると、ほかの PC の版も見える
    pub presence: DirCfg,
}

impl Default for ServerCfg {
    fn default() -> Self {
        Self { host: "127.0.0.1".into(), port: 57830, open_browser: true }
    }
}

impl Default for LotListCfg {
    fn default() -> Self {
        Self { source: String::new(), table: String::new(), page_size: 200, interval_sec: 60, stale_hours: 36.0 }
    }
}

/// ロット一覧の写しの係へ渡す値（元ファイル・見に行く間隔(秒)・古いとみなす時間）。
#[derive(Debug, Clone, PartialEq)]
pub struct MirrorParams {
    pub source: String,
    pub interval_sec: u64,
    pub stale_hours: f64,
}

impl Settings {
    pub fn mirror_params(&self) -> MirrorParams {
        let ll = &self.lot_list;
        MirrorParams {
            source: ll.source.clone(),
            interval_sec: if ll.interval_sec == 0 { 60 } else { ll.interval_sec },
            stale_hours: ll.stale_hours,
        }
    }
}

/// 辞書は1段だけ重ねる（`{**元, **上}`）。辞書でないものは置き換える。
pub fn overlay(base: &mut Value, top: &Value) {
    let (Some(b), Some(t)) = (base.as_object_mut(), top.as_object()) else { return };
    for (k, v) in t {
        match (b.get_mut(k), v) {
            (Some(Value::Object(bo)), Value::Object(vo)) => {
                for (kk, vv) in vo {
                    bo.insert(kk.clone(), vv.clone());
                }
            }
            _ => {
                b.insert(k.clone(), v.clone());
            }
        }
    }
}

fn read_value(path: &Path) -> Option<Value> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    v.is_object().then_some(v)
}

fn to_settings(v: Value) -> Settings {
    serde_json::from_value(v).unwrap_or_default()
}

/// 初期値に config/settings.json を重ねたもの（読めなければ初期値）。
pub fn load_settings(base: &Path) -> Settings {
    let mut v = serde_json::to_value(Settings::default()).unwrap_or_else(|_| json!({}));
    if let Some(file) = read_value(&base.join("config").join("settings.json")) {
        overlay(&mut v, &file);
    }
    to_settings(v)
}

/// 画面から変えた設定の置き場（data/ に置く。config/ に書くと配る物の要約が変わるため）。
pub fn user_settings_path(base: &Path) -> PathBuf {
    base.join("data").join(USER_SETTINGS)
}

/// 設定の初期値に、画面から変えた設定を重ねたもの。
pub fn effective_settings(base: &Path, settings: &Settings) -> Settings {
    let mut v = serde_json::to_value(settings).unwrap_or_else(|_| json!({}));
    if let Some(user) = read_value(&user_settings_path(base)) {
        overlay(&mut v, &user);
    }
    to_settings(v)
}

/// JSON の辞書を取り出す小さな部品。
pub fn obj(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
}

/// 実行ファイルや作業フォルダから、`web/index.html` のある本体のフォルダを探す。
/// 順: 環境変数 DOCMAKER_HOME → 作業フォルダ → 実行ファイルのある場所から上へ（target/release/ から開発中の本体へ戻れる）。
pub fn find_base_dir() -> PathBuf {
    let has_web = |p: &Path| p.join("web").join("index.html").is_file();
    if let Ok(h) = std::env::var("DOCMAKER_HOME") {
        if !h.is_empty() {
            return PathBuf::from(h);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if has_web(&cwd) {
            return cwd;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        for a in exe.ancestors().skip(1).take(4) {
            if has_web(a) {
                return a.to_path_buf();
            }
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}
