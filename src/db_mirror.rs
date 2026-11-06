//! 共有上の読み取り専用 SQLite を、手元へ写してから読む（WaveLog backend/db_mirror.py と同じ方式）。
//!
//! なぜ写すか
//!   品質データ（SIKADEF.sqlite3）は別の PC の別のアプリが更新している。SMB 越しの SQLite のロックは当てにならず、
//!   書き手がファイルごと置き換えることもあるので、共有を直接読むと更新中の中途半端な状態を読むことがある。
//!   共有を手元の一時ファイルへ写し、写しが正しいと確かめてから切り替え、画面はいつも手元の写しだけを読む。
//!
//! 写し方（この順）
//!   1. SQLite のバックアップ API（書き手が動いていても一貫したスナップショット）
//!   2. 失敗したらバイト単位のコピー
//!
//!   どちらも採用前に PRAGMA quick_check で検査し、壊れていれば捨てて前の写しを使い続ける。
//!
//! 世代名
//!   写しは毎回新しい名前 <キー>.g<世代>.sqlite3 で作り、台帳 _mirror.json が今の世代を指す。
//!   Windows では開いているファイルを置き換えられないため、上書きしない（読み手とぶつからない）。
//!   古い世代は消せたときに消す（読んでいる間は消えないので、次の周回でまた試す）。
//!
//! いつ写すか
//!   背景スレッドが一定間隔で元ファイルの (パス, サイズ, 更新時刻) を見て、変わっていれば写す。
//!   共有へ触るのは背景スレッド（と利用者が押した「再読込」）だけで、一覧を出す要求の中では共有を stat しない。
//!   写しがまだ無いときだけ元を直接読む（fail-open）。起動して最初の周回が済むまでは、読む側が待つ。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::fsio::{read_json, retrying, write_json_atomic};
use crate::sqlite_ro::ro_uri;

pub const LEDGER: &str = "_mirror.json";
pub const DEFAULT_INTERVAL_SEC: u64 = 60;
pub const MIN_INTERVAL_SEC: u64 = 10;
pub const FIRST_WAIT_SEC: u64 = 30;
const STAT_RETRY_SEC: [f64; 3] = [0.3, 0.7, 1.5]; // 書き直しの最中の一瞬の不在は待って取り直す
const RETRY_AFTER_UNREACHABLE_SEC: u64 = 10; // 届かなくなった最初の1回は早めに取り直す
const REPLACE_BUDGET_SEC: f64 = 2.0;

fn now_secs() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
}

/// OS のエラーを「Errno 2 No such file…」の形の文にする。
fn os_error_text(e: &std::io::Error) -> String {
    let msg = e.to_string();
    match e.raw_os_error() {
        Some(n) => {
            let base = msg.split(" (os error").next().unwrap_or(&msg);
            let code = if cfg!(windows) { format!("WinError {n}") } else { format!("Errno {n}") };
            format!("{code} {base}")
        }
        None => msg,
    }
}

/// 1回ぶんの写し直しの結果（画面の診断用）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct RefreshResult {
    pub updated: bool,
    pub reason: String,
    pub at: f64,
    pub remote: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unreachable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fails: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub how: Option<&'static str>,
}

#[derive(Debug)]
struct Config {
    remote: String,
    interval: u64,
    stale_hours: f64, // 元データは毎日更新される前提。最後の更新からこれより経っていたら「古い」と言う（0 以下なら言わない）
    state: Option<RefreshResult>,
}

/// 「一度立てたら、待つ側が起きる」旗。
#[derive(Default)]
struct Flag {
    set: Mutex<bool>,
    cv: Condvar,
}

impl Flag {
    fn raise(&self) {
        if let Ok(mut g) = self.set.lock() {
            *g = true;
            self.cv.notify_all();
        }
    }
    fn is_set(&self) -> bool {
        self.set.lock().map(|g| *g).unwrap_or(false)
    }
    /// 立つか timeout を過ぎるまで待ち、立っていたら下ろして true。
    fn wait_and_clear(&self, timeout: Duration) -> bool {
        let Ok(g) = self.set.lock() else { return false };
        let Ok((mut g, _)) = self.cv.wait_timeout_while(g, timeout, |s| !*s) else { return false };
        std::mem::take(&mut *g)
    }
    /// 立つか timeout を過ぎるまで待つ（下ろさない）。
    fn wait(&self, timeout: Duration) {
        if let Ok(g) = self.set.lock() {
            let _ = self.cv.wait_timeout_while(g, timeout, |s| !*s);
        }
    }
}

pub struct DbMirror {
    key: String,
    cache_dir: PathBuf,
    cfg: Mutex<Config>,
    refresh_lock: Mutex<()>, // 背景の周回と「再読込」を1本ずつ
    first: Flag,
    wake: Flag,
    running: AtomicBool,
}

impl DbMirror {
    pub fn new(key: &str, remote: &str, cache_dir: &Path, interval_sec: u64, stale_hours: f64) -> Arc<Self> {
        let key: String = key.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
        Arc::new(Self {
            key: if key.is_empty() { "db".into() } else { key },
            cache_dir: cache_dir.to_path_buf(),
            cfg: Mutex::new(Config { remote: remote.to_string(), interval: interval_sec.max(MIN_INTERVAL_SEC), stale_hours, state: None }),
            refresh_lock: Mutex::new(()),
            first: Flag::default(),
            wake: Flag::default(),
            running: AtomicBool::new(false),
        })
    }

    fn cfg(&self) -> std::sync::MutexGuard<'_, Config> {
        self.cfg.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn remote(&self) -> String {
        self.cfg().remote.clone()
    }

    pub fn enabled(&self) -> bool {
        !self.cfg().remote.is_empty()
    }

    /// 元ファイル・間隔・古さのしきいが変わったとき、起動し直さずに切り替える。
    /// 元のパスは写しの印に入っているので、前の元の写しは使われない（新しい元を写すまでは元を直接読む）。変わった物があれば true。
    pub fn reconfigure(self: &Arc<Self>, remote: Option<&str>, interval_sec: Option<u64>, stale_hours: Option<f64>) -> bool {
        let mut changed = false;
        {
            let mut c = self.cfg();
            if let Some(r) = remote.filter(|r| *r != c.remote) {
                c.remote = r.to_string();
                c.state = None;
                changed = true;
            }
            if let Some(iv) = interval_sec.map(|i| i.max(MIN_INTERVAL_SEC)).filter(|i| *i != c.interval) {
                c.interval = iv;
                changed = true;
            }
            if let Some(h) = stale_hours.filter(|h| *h != c.stale_hours) {
                c.stale_hours = h;
                changed = true;
            }
        }
        if changed {
            self.start();
            self.wake();
        }
        changed
    }

    // ------------------------------------------------------------ 台帳
    fn ledger_path(&self) -> PathBuf {
        self.cache_dir.join(LEDGER)
    }

    /// 台帳（元ファイルごとの「どの写しが・どの元から」）。読めない・壊れていれば空。
    fn ledger(&self) -> Map<String, Value> {
        match read_json(&self.ledger_path()) {
            Ok(Some(Value::Object(m))) => m,
            _ => Map::new(),
        }
    }

    fn entry(&self) -> Map<String, Value> {
        match self.ledger().get(&self.key) {
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        }
    }

    fn save_entry(&self, signature: &Value, filename: &str) -> std::io::Result<()> {
        let mut data = self.ledger();
        data.insert(self.key.clone(), json!({"signature": signature, "file": filename}));
        write_json_atomic(&self.ledger_path(), &data, true, REPLACE_BUDGET_SEC)
    }

    fn generation_path(&self, gen: u64) -> PathBuf {
        self.cache_dir.join(format!("{}.g{gen}.sqlite3", self.key))
    }

    fn generations(&self) -> Vec<(u64, PathBuf)> {
        let prefix = format!("{}.g", self.key);
        let Ok(rd) = std::fs::read_dir(&self.cache_dir) else { return Vec::new() };
        rd.flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let n = name.strip_prefix(&prefix)?.strip_suffix(".sqlite3")?.parse::<u64>().ok()?;
                Some((n, e.path()))
            })
            .collect()
    }

    fn next_generation(&self) -> u64 {
        self.generations().iter().map(|(n, _)| *n).max().unwrap_or(0) + 1
    }

    pub fn mirror_path(&self) -> Option<PathBuf> {
        let e = self.entry();
        let name = e.get("file")?.as_str().filter(|s| !s.is_empty())?;
        Some(self.cache_dir.join(name))
    }

    /// いまの世代以外の古い写しを消す。読んでいる間は消せないので、次の周回でまた試す。
    fn sweep(&self, keep: &Path) {
        let keep = keep.file_name().map(|n| n.to_owned());
        for (_, p) in self.generations() {
            if p.file_name().map(|n| n.to_owned()) != keep {
                let _ = retrying(|| std::fs::remove_file(&p), 0.2);
            }
        }
    }

    // ------------------------------------------------------------ 共有へ触る（背景・再読込のみ）
    /// 元の (パス, サイズ, 更新時刻)。書き直しの最中の一瞬の不在は待って取り直す。
    fn remote_stat(remote: &str, retry: bool) -> Result<Value, String> {
        let waits: Vec<f64> = if retry { std::iter::once(0.0).chain(STAT_RETRY_SEC).collect() } else { vec![0.0] };
        let mut err = None;
        for w in waits {
            if w > 0.0 {
                std::thread::sleep(Duration::from_secs_f64(w));
            }
            match std::fs::metadata(remote) {
                Ok(m) => {
                    let ns = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
                    // 元のパスも印に含める（パスを差し替えたら前の写しを使わない）
                    return Ok(json!({"source": remote, "size": m.len(), "mtime_ns": u64::try_from(ns).unwrap_or(0)}));
                }
                Err(e) => err = Some(e),
            }
        }
        Err(err.as_ref().map(os_error_text).unwrap_or_default())
    }

    fn snapshot_backup(remote: &str, tmp: &Path) -> Result<(), String> {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let src = Connection::open_with_flags(ro_uri(Path::new(remote)), flags).map_err(|e| e.to_string())?;
        let _ = src.busy_timeout(Duration::from_secs(15));
        let mut dst = Connection::open(tmp).map_err(|e| e.to_string())?;
        let b = Backup::new(&src, &mut dst).map_err(|e| e.to_string())?;
        b.run_to_completion(256, Duration::from_millis(50), None).map_err(|e| e.to_string())
    }

    /// 写しが正しいか。正しければ None、だめなら理由。
    pub fn verify(tmp: &Path) -> Option<String> {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let c = match Connection::open_with_flags(ro_uri(tmp), flags) {
            Ok(c) => c,
            Err(e) => return Some(format!("開けません: {e}")),
        };
        let _ = c.busy_timeout(Duration::from_secs(10));
        let check = c.query_row("PRAGMA quick_check(1)", [], |r| r.get::<_, String>(0));
        match check {
            Ok(s) if s.eq_ignore_ascii_case("ok") => {}
            Ok(s) => return Some(format!("整合性検査に通りません: {s}")),
            Err(e) => return Some(format!("読めません: {e}")),
        }
        match c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table'", [], |r| r.get::<_, i64>(0)) {
            Ok(0) => Some("テーブルが1つもありません（まだ書き込み中の可能性）".into()),
            Ok(_) => None,
            Err(e) => Some(format!("読めません: {e}")),
        }
    }

    /// 1回ぶん写し直す。結果（画面の診断用）を返す。force なら変わっていなくても写す。
    pub fn refresh(&self, force: bool) -> RefreshResult {
        let _one_at_a_time = self.refresh_lock.lock().unwrap_or_else(|e| e.into_inner());
        let res = self.refresh_inner(force);
        self.cfg().state = Some(res.clone());
        res
    }

    fn refresh_inner(&self, force: bool) -> RefreshResult {
        let remote = self.remote();
        let mut res = RefreshResult { at: now_secs(), remote: remote.clone(), ..Default::default() };
        if remote.is_empty() {
            res.reason = "元ファイルが設定されていません".into();
            return res;
        }
        let entry = self.entry();
        let local = self.mirror_path();
        let has_local = local.as_ref().is_some_and(|p| p.exists());
        let prev = self.cfg().state.clone().unwrap_or_default();
        let known_good = prev.remote == remote && prev.unreachable != Some(true) && prev.at > 0.0;
        let sig = match Self::remote_stat(&remote, known_good) {
            Ok(s) => s,
            Err(err) => {
                let same = prev.unreachable == Some(true) && prev.remote == remote;
                res.unreachable = Some(true);
                res.fails = Some(if same { prev.fails.unwrap_or(1) + 1 } else { 1 });
                let name = Path::new(&remote).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                res.reason = format!(
                    "{}（{name}: {err}）",
                    if has_local { "共有の元ファイルへ届かないため、前の写しを使い続けます" } else { "共有の元ファイルへ届かず、写しもまだありません" }
                );
                res.error = Some(err);
                return res;
            }
        };
        if let (false, true, Some(l)) = (force, has_local, local.as_ref()) {
            if entry.get("signature") == Some(&sig) {
                res.skipped = Some(true);
                res.reason = "元ファイルは変わっていません".into();
                self.sweep(l);
                return res;
            }
        }
        if let Err(e) = std::fs::create_dir_all(&self.cache_dir) {
            res.reason = format!("写せませんでした: {e}");
            return res;
        }
        let target = self.generation_path(self.next_generation());
        let tmp = PathBuf::from(format!("{}.tmp", target.display()));
        let _ = std::fs::remove_file(&tmp);
        let how = match Self::snapshot_backup(&remote, &tmp) {
            Ok(()) => "backup",
            Err(_) => match std::fs::copy(&remote, &tmp) {
                Ok(_) => "copy", // バックアップ API で写せなかったのでコピーした
                Err(e) => {
                    res.reason = format!("写せませんでした: {e}");
                    Self::cleanup(&tmp);
                    return res;
                }
            },
        };
        if let Some(bad) = Self::verify(&tmp) {
            res.reason = format!("写しが正しくないため見送りました（{bad}）");
            Self::cleanup(&tmp);
            return res;
        }
        let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let placed = retrying(|| std::fs::rename(&tmp, &target), REPLACE_BUDGET_SEC).and_then(|()| self.save_entry(&sig, &name));
        if let Err(e) = placed {
            res.reason = format!("写しを置き換えられませんでした: {e}");
            Self::cleanup(&tmp);
            return res;
        }
        res.updated = true;
        res.how = Some(how);
        res.reason = format!("写しを更新しました（{}）", if how == "backup" { "バックアップAPI" } else { "コピー" });
        self.sweep(&target);
        res
    }

    fn cleanup(tmp: &Path) {
        let _ = retrying(|| std::fs::remove_file(tmp), 1.0);
    }

    // ------------------------------------------------------------ 読む側
    /// 実際に読む場所。その元から作った写しがあればそれ、無ければ元（fail-open）。元が決まっていなければ None。
    pub fn read_path(&self) -> Option<PathBuf> {
        let remote = self.remote();
        if remote.is_empty() {
            return None;
        }
        if !self.first.is_set() && self.running.load(Ordering::SeqCst) {
            self.first.wait(Duration::from_secs(FIRST_WAIT_SEC));
        }
        let entry = self.entry();
        let sig_source = entry.get("signature").and_then(|s| s.get("source")).and_then(Value::as_str).unwrap_or("");
        if !sig_source.is_empty() && sig_source != remote {
            return Some(PathBuf::from(remote));
        }
        match self.mirror_path() {
            Some(l) if l.exists() => Some(l),
            _ => Some(PathBuf::from(remote)),
        }
    }

    /// いま読んでいるデータは「いつのものか」。共有は stat しない（台帳の印から読む）。
    /// 取れないものは null（「分からない」を 0 や「たった今」にしない）。
    pub fn source_info(&self) -> Value {
        let (remote, interval, stale_hours, state) = {
            let c = self.cfg();
            (c.remote.clone(), c.interval, c.stale_hours, c.state.clone())
        };
        let entry = self.entry();
        let sig = entry.get("signature").cloned().unwrap_or(Value::Null);
        let local = self.mirror_path();
        let mirrored = local.as_ref().is_some_and(|l| sig.get("source").and_then(Value::as_str) == Some(remote.as_str()) && l.exists());
        let mut at = None;
        let mut copied_at = None;
        if mirrored {
            at = sig.get("mtime_ns").and_then(Value::as_f64).map(|n| n / 1e9);
            copied_at = local
                .as_ref()
                .and_then(|l| std::fs::metadata(l).ok())
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64());
        }
        let st = state.unwrap_or_default();
        // 元データの古さ: 元ファイルが最後に書き換えられた時刻（写しの台帳の印）から、いまで何時間か
        let age = at.map(|a| (now_secs() - a) / 3600.0);
        json!({
            "remote": remote, "at": at, "mirrored": mirrored, "copiedAt": copied_at,
            "checkedAt": (st.at > 0.0).then_some(st.at), "unreachable": st.unreachable == Some(true), "reason": st.reason,
            "interval_sec": interval, "staleHours": stale_hours,
            "ageHours": age.map(|a| (a * 10.0).round() / 10.0),
            "stale": age.map(|a| stale_hours > 0.0 && a > stale_hours),
        })
    }

    // ------------------------------------------------------------ 背景スレッド
    fn next_wait(&self) -> Duration {
        let c = self.cfg();
        let st = c.state.clone().unwrap_or_default();
        let secs = if st.unreachable == Some(true) && st.fails.unwrap_or(1) == 1 { c.interval.min(RETRY_AFTER_UNREACHABLE_SEC) } else { c.interval };
        Duration::from_secs(secs)
    }

    /// 背景の周回を始める（何度呼んでもよい）。元が空・すでに動いているときは何もしない。
    pub fn start(self: &Arc<Self>) -> bool {
        if !self.enabled() || self.running.swap(true, Ordering::SeqCst) {
            return false;
        }
        let me = Arc::clone(self);
        let spawned = std::thread::Builder::new().name(format!("db-mirror-{}", self.key)).spawn(move || {
            me.refresh(false);
            me.first.raise();
            loop {
                me.wake.wait_and_clear(me.next_wait());
                me.refresh(false);
            }
        });
        if spawned.is_err() {
            self.running.store(false, Ordering::SeqCst);
        }
        spawned.is_ok()
    }

    pub fn wake(&self) {
        self.wake.raise();
    }
}
