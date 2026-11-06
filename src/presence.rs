//! 利用状況（だれが・どの PC で・どの版を使っているか）。WaveLog backend/presence.py を移したもの。
//!
//! 置き場: 設定 presence.dir（共有フォルダ）の下。空なら data/presence_docmaker（この PC の中だけ）。
//!   <key>.json          … いま使っている（心拍で at を更新。TTL を過ぎたら使っていない）
//!   history/<key>.json  … 使った記録（初めて・最後・回数・使った時間・版の移り変わり）
//!   key = 「PC名@ログインID」（ファイル名に使えない字は _、変えたら sha1 の頭を付ける）
//! **1つのファイルを書くのはその PC だけ**（ほかの PC とぶつからない）。書くときは一時ファイル → 置き換え。
//! 読めないファイルは「無い」ではなく「読めない」（消さない）。
//!
//! 「最新版」は、使っている人たちの版のうちいちばん新しいもの（version::version_key で数で比べる）。
//! 権限（役割）の仕組みができるまでは、全員を数える。切断・記録の削除は、権限の判定ができてから足す（いまは作らない）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};

use crate::fsio::{age_secs, now_iso, parse_iso, write_json_atomic};
use crate::version::{version_key, APP_VERSION};

pub const TTL_SEC: f64 = 75.0; // 心拍がこれより古ければ「使っていない」
pub const WRITE_INTERVAL_SEC: f64 = 20.0; // いまの状態を書く間隔（心拍はもっと頻繁でも、書くのはこの間隔）
pub const HISTORY_WRITE_SEC: f64 = 60.0;
pub const SWEEP_INTERVAL_SEC: f64 = 300.0;
pub const NEWEST_INTERVAL_SEC: f64 = 300.0;
pub const HISTORY_VERSIONS: usize = 10;

fn now_secs() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
}

/// 「PC名@ログインID」をファイル名にできる形にする。
pub fn terminal_key(login: &str, pc: &str) -> String {
    let raw = format!("{}@{}", if pc.is_empty() { "?" } else { pc }, if login.is_empty() { "?" } else { login });
    let safe: String = raw
        .chars()
        .map(|c| if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_whitespace() { '_' } else { c })
        .take(100)
        .collect();
    if safe != raw {
        let h = hex::encode(Sha1::digest(raw.as_bytes()));
        format!("{safe}-{}", &h[..6])
    } else {
        safe
    }
}

enum Read {
    Missing,
    Unreadable,
    Json(Map<String, Value>),
}

fn read_obj(path: &Path) -> Read {
    match std::fs::read_to_string(path) {
        Ok(t) => match serde_json::from_str::<Value>(&t) {
            Ok(Value::Object(m)) => Read::Json(m),
            _ => Read::Unreadable,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Read::Missing,
        Err(_) => Read::Unreadable,
    }
}

fn str_of<'a>(m: &'a Map<String, Value>, k: &str) -> &'a str {
    m.get(k).and_then(Value::as_str).unwrap_or("")
}

#[derive(Default)]
struct State {
    dir: Option<PathBuf>,
    last_write: f64,
    last_history: f64,
    last_sweep: f64,
    since: Option<String>,
    session_key: Option<String>,
    newest: Option<String>,
    newest_at: f64,
    busy: bool,
    left: bool,
}

#[derive(Default)]
pub struct Presence {
    state: Mutex<State>,
    /// 共有へ書く処理を1本ずつにする（状態の更新は短い別のロックで、心拍を待たせない）
    io: Mutex<()>,
}

impl Presence {
    pub fn new(dir: Option<PathBuf>) -> Arc<Self> {
        let p = Self::default();
        p.configure(dir);
        Arc::new(p)
    }

    fn st(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn configure(&self, dir: Option<PathBuf>) {
        *self.st() = State { dir, ..State::default() };
    }

    pub fn dir(&self) -> Option<PathBuf> {
        self.st().dir.clone()
    }

    fn hist_path(dir: &Path, key: &str) -> PathBuf {
        dir.join("history").join(format!("{key}.json"))
    }

    /// 置き場の親（共有フォルダ・この PC の作業フォルダ）が無ければ書かない（共有の置き場そのものは作らない）。
    fn write(dir: &Path, path: &Path, data: &Value) -> bool {
        dir.parent().is_some_and(|p| p.exists()) && write_json_atomic(path, data, true, 1.0).is_ok()
    }

    // ------------------------------------------------------------ 書く（この PC の分だけ）
    /// 使った記録を足す。新しい使い始めは、key が変わった・前から TTL より空いたとき。
    fn record(&self, dir: &Path, key: &str, login: &str, pc: &str, now: &str, final_write: bool) {
        let path = Self::hist_path(dir, key);
        let mut h = match read_obj(&path) {
            Read::Json(m) => m,
            _ => json!({"key": key, "login": login, "pc": pc, "firstAt": now, "sessions": 0, "totalSec": 0, "versions": {}})
                .as_object()
                .cloned()
                .unwrap_or_default(),
        };
        let gap = match (parse_iso(now), h.get("lastAt").and_then(Value::as_str).and_then(parse_iso)) {
            (Some(n), Some(l)) => Some((n - l).num_milliseconds() as f64 / 1000.0),
            _ => None,
        };
        let new_session = {
            let mut s = self.st();
            let new_session = s.session_key.as_deref() != Some(key) || gap.is_none_or(|g| g > TTL_SEC);
            if new_session {
                s.session_key = Some(key.to_string());
            }
            new_session
        };
        let num = |h: &Map<String, Value>, k: &str| h.get(k).and_then(Value::as_i64).unwrap_or(0);
        if new_session {
            h.insert("sessions".into(), json!(num(&h, "sessions") + 1));
            h.insert("sessionAt".into(), json!(now));
        } else if let Some(g) = gap.filter(|g| *g != 0.0) {
            h.insert("totalSec".into(), json!(num(&h, "totalSec") + g.min(TTL_SEC) as i64));
        }
        h.insert("login".into(), json!(login));
        h.insert("pc".into(), json!(pc));
        h.insert("lastAt".into(), json!(now));
        h.insert("version".into(), json!(APP_VERSION));
        let mut vers: Vec<(String, String)> = h
            .get("versions")
            .and_then(Value::as_object)
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect())
            .unwrap_or_default();
        vers.retain(|(k, _)| k != APP_VERSION);
        vers.push((APP_VERSION.to_string(), now.to_string()));
        vers.sort_by(|a, b| a.1.cmp(&b.1));
        let skip = vers.len().saturating_sub(HISTORY_VERSIONS);
        h.insert("versions".into(), Value::Object(vers.into_iter().skip(skip).map(|(k, v)| (k, json!(v))).collect()));
        let due = now_secs() - self.st().last_history >= HISTORY_WRITE_SEC;
        if final_write || new_session || due {
            Self::write(dir, &path, &Value::Object(h));
            self.st().last_history = now_secs();
        }
    }

    /// いま使っていることを書く（WRITE_INTERVAL ごと）。記録・掃除・最新版の数え直しもここで。
    pub fn touch(&self, login: &str, pc: &str, force: bool) -> bool {
        let Some(dir) = self.dir() else { return false };
        let t = now_secs();
        if !force && t - self.st().last_write < WRITE_INTERVAL_SEC {
            return false;
        }
        let _io = self.io.lock().unwrap_or_else(|e| e.into_inner());
        let key = terminal_key(login, pc);
        let now = now_iso();
        let since = {
            let mut s = self.st();
            if s.since.is_none() || s.session_key.as_deref() != Some(key.as_str()) {
                s.since = Some(now.clone());
            }
            s.since.clone().unwrap_or_else(|| now.clone())
        };
        let ok = Self::write(
            &dir,
            &dir.join(format!("{key}.json")),
            &json!({"key": key, "login": login, "pc": pc, "version": APP_VERSION, "since": since, "at": now}),
        );
        {
            let mut s = self.st();
            s.last_write = t;
            s.left = false;
        }
        self.record(&dir, &key, login, pc, &now, false);
        if t - self.st().last_sweep >= SWEEP_INTERVAL_SEC {
            Self::sweep(&dir);
            self.st().last_sweep = t;
        }
        ok
    }

    /// 心拍から呼ぶ。書くのは裏の1本の糸（共有が遅くても心拍を待たせない）。書いている最中の頼みは捨てる。
    pub fn touch_async(self: &Arc<Self>, login: &str, pc: &str) {
        {
            let mut s = self.st();
            if s.dir.is_none() || now_secs() - s.last_write < WRITE_INTERVAL_SEC || s.busy {
                return;
            }
            s.busy = true;
        }
        let me = Arc::clone(self);
        let (login, pc) = (login.to_string(), pc.to_string());
        let spawned = std::thread::Builder::new().name("presence".into()).spawn(move || {
            me.touch(&login, &pc, false);
            if now_secs() - me.st().newest_at >= NEWEST_INTERVAL_SEC {
                me.refresh_newest();
            }
            me.st().busy = false;
        });
        if spawned.is_err() {
            self.st().busy = false;
        }
    }

    /// 使い終わり（アプリの終了）。いまのファイルを消し、記録を最後まで書く。
    pub fn leave(&self, login: &str, pc: &str) {
        let Some(dir) = self.dir() else { return };
        if self.st().left {
            return;
        }
        let _io = self.io.lock().unwrap_or_else(|e| e.into_inner());
        let key = terminal_key(login, pc);
        self.record(&dir, &key, login, pc, &now_iso(), true);
        let _ = std::fs::remove_file(dir.join(format!("{key}.json")));
        self.st().left = true;
    }

    /// 古い「いま使っている」（TTL の4倍）を消す。読めないものは消さない。記録は消さない。
    fn sweep(dir: &Path) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().is_none_or(|x| x != "json") || !p.is_file() {
                continue;
            }
            if let Read::Json(m) = read_obj(&p) {
                if age_secs(str_of(&m, "at")).is_some_and(|a| a > TTL_SEC * 4.0) {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }

    // ------------------------------------------------------------ 読む
    fn json_files(dir: &Path) -> Vec<PathBuf> {
        let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
        let mut v: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "json")).collect();
        v.sort();
        v
    }

    /// いま使っているもの（TTL 内）。idleSec を足して返す。
    fn online(dir: &Path) -> Vec<Map<String, Value>> {
        Self::json_files(dir)
            .iter()
            .filter_map(|p| match read_obj(p) {
                Read::Json(mut m) => {
                    let age = age_secs(str_of(&m, "at"))?;
                    (age <= TTL_SEC).then(|| {
                        m.insert("idleSec".into(), json!(age as i64));
                        m
                    })
                }
                _ => None,
            })
            .collect()
    }

    fn history(dir: &Path) -> Vec<Map<String, Value>> {
        Self::json_files(&dir.join("history")).iter().filter_map(|p| if let Read::Json(m) = read_obj(p) { Some(m) } else { None }).collect()
    }

    /// 使っている人たちの版のうち、いちばん新しいもの。数えられなければ None。
    pub fn latest_version(&self) -> Option<String> {
        let dir = self.dir()?;
        Self::history(&dir)
            .iter()
            .chain(Self::online(&dir).iter())
            .map(|r| str_of(r, "version").to_string())
            .filter(|v| !v.is_empty())
            .max_by_key(|v| version_key(v))
    }

    pub fn refresh_newest(&self) {
        let v = self.latest_version(); // 読めなければ前の答えのまま
        let mut s = self.st();
        if v.is_some() {
            s.newest = v;
        }
        s.newest_at = now_secs();
    }

    /// {latestVersion, myVersion, outdated}（まだ数えていなければ None）。
    pub fn version_notice(&self) -> Option<Value> {
        let latest = self.st().newest.clone()?;
        Some(json!({"latestVersion": latest, "myVersion": APP_VERSION, "outdated": version_key(&latest) > version_key(APP_VERSION)}))
    }

    /// 利用状況の画面の中身: PC ごとの記録（いま使っているか・版・最新か）と数。
    pub fn fleet(&self) -> Value {
        let dir = self.dir();
        let (online, hist) = match &dir {
            Some(d) => (Self::online(d), Self::history(d)),
            None => (Vec::new(), Vec::new()),
        };
        let latest = self.latest_version();
        let by_key = |v: &[Map<String, Value>]| -> Vec<(String, Map<String, Value>)> {
            v.iter().filter(|m| !str_of(m, "key").is_empty()).map(|m| (str_of(m, "key").to_string(), m.clone())).collect()
        };
        let (online, hist) = (by_key(&online), by_key(&hist));
        let mut keys: Vec<String> = online.iter().chain(hist.iter()).map(|(k, _)| k.clone()).collect();
        keys.sort();
        keys.dedup();
        let empty = Map::new();
        let mut items: Vec<(bool, bool, String, String, Value)> = Vec::new();
        for k in keys {
            let o = online.iter().find(|(x, _)| *x == k).map(|(_, m)| m);
            let h = hist.iter().find(|(x, _)| *x == k).map(|(_, m)| m);
            let src = o.or(h).unwrap_or(&empty);
            let ver = {
                let a = o.map_or("", |m| str_of(m, "version"));
                if a.is_empty() { h.map_or("", |m| str_of(m, "version")) } else { a }
            };
            let outdated = latest.as_ref().is_some_and(|l| !ver.is_empty() && version_key(l) > version_key(ver));
            let hv = |key: &str| h.and_then(|m| m.get(key)).cloned();
            let last_at = o.map(|m| str_of(m, "at").to_string()).filter(|s| !s.is_empty()).map(Value::from).or_else(|| hv("lastAt"));
            let (login, pc) = (str_of(src, "login").to_string(), str_of(src, "pc").to_string());
            items.push((!outdated, o.is_none(), pc.clone(), login.clone(), json!({
                "key": k, "login": login, "pc": pc, "version": ver, "online": o.is_some(),
                "idleSec": o.and_then(|m| m.get("idleSec")).cloned(), "since": o.and_then(|m| m.get("since")).cloned(),
                "firstAt": hv("firstAt"), "lastAt": last_at,
                "sessions": hv("sessions").unwrap_or(json!(0)), "totalSec": hv("totalSec").unwrap_or(json!(0)),
                "versions": hv("versions").unwrap_or(json!({})), "outdated": outdated,
            })));
        }
        items.sort_by(|a, b| (a.0, a.1, &a.2, &a.3).cmp(&(b.0, b.1, &b.2, &b.3)));
        let items: Vec<Value> = items.into_iter().map(|t| t.4).collect();
        let flag = |name: &str| items.iter().filter(|x| x[name] == json!(true)).count();
        json!({"online": flag("online"), "outdated": flag("outdated"), "total": items.len(), "latest": latest,
               "dir": dir.map(|d| d.display().to_string()).unwrap_or_default(), "ttlSec": TTL_SEC, "items": items})
    }
}
