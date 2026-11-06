//! サーバーが覚えておく物（設定・指紋・写しの係・利用状況）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::build_info;
use crate::config::{self, effective_settings, load_settings, LotListCfg, MirrorParams, Settings};
use crate::db_mirror::DbMirror;
use crate::presence::Presence;

/// いまのディスクの指紋を覚えておく時間（何度も尋ねられるため）。
pub const DISK_BUILD_TTL: Duration = Duration::from_secs(2);

pub struct AppState {
    pub base_dir: PathBuf,
    pub web_dir: PathBuf,
    /// 設定の初期値（config/settings.json まで）。画面から変えた分は effective() で重ねる
    pub settings: Settings,
    /// 起動したときの指紋（いまのディスクと違えば stale）
    pub build: String,
    pub lot_mirror: Arc<DbMirror>,
    lot_applied: Mutex<MirrorParams>,
    pub presence: Arc<Presence>,
    pub disk_build_ttl: Duration,
    disk_build: Mutex<Option<(Instant, String)>>,
}

impl AppState {
    /// settings が None なら config/settings.json を読む。
    pub fn new(base: &Path, settings: Option<Settings>) -> Arc<Self> {
        let settings = settings.unwrap_or_else(|| load_settings(base));
        let data = base.join("data");
        let _ = std::fs::create_dir_all(&data); // この PC の中だけの既定の置き場は作る（共有フォルダの置き場そのものは作らない）
        let pdir = if settings.presence.dir.is_empty() { data.join("presence_docmaker") } else { PathBuf::from(&settings.presence.dir) };
        let want = effective_settings(base, &settings).mirror_params();
        Arc::new(Self {
            base_dir: base.to_path_buf(),
            web_dir: base.join("web"),
            build: build_info::fingerprint(base),
            lot_mirror: DbMirror::new("lot", &want.source, &data.join("mirror"), want.interval_sec, want.stale_hours),
            lot_applied: Mutex::new(want),
            presence: Presence::new(Some(pdir)),
            settings,
            disk_build_ttl: DISK_BUILD_TTL,
            disk_build: Mutex::new(None),
        })
    }

    /// 設定の初期値に、画面から変えた設定を重ねたもの（問い合わせのたびに読む）。
    pub fn effective(&self) -> Settings {
        effective_settings(&self.base_dir, &self.settings)
    }

    /// 設定の今の値に合わせてから写しの係を返す（画面で参照先を直したら、次の問い合わせで切り替わる）。
    /// 設定は1回の問い合わせで1回だけ読む。
    pub fn lot_mirror(&self) -> (Arc<DbMirror>, LotListCfg) {
        let s = self.effective();
        let want = s.mirror_params();
        {
            let mut applied = self.lot_applied.lock().unwrap_or_else(|e| e.into_inner());
            if *applied != want {
                // 前に当てた値から変わったときだけ切り替える
                self.lot_mirror.reconfigure(Some(&want.source), Some(want.interval_sec), Some(want.stale_hours));
                *applied = want;
            }
        }
        self.lot_mirror.start(); // 始まっていなければここで始める（何度呼んでもよい）。元が空なら何もしない
        (Arc::clone(&self.lot_mirror), s.lot_list)
    }

    /// いまのディスクの指紋（ttl だけ覚える）。
    pub fn disk_build(&self) -> String {
        let mut g = self.disk_build.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, v)) = g.as_ref() {
            if at.elapsed() <= self.disk_build_ttl {
                return v.clone();
            }
        }
        let v = build_info::fingerprint(&self.base_dir);
        *g = Some((Instant::now(), v.clone()));
        v
    }

    /// 帳票の置き場（設定の今の値。空なら data/reports）。
    pub fn reports_root(&self) -> PathBuf {
        let d = self.effective().reports.dir;
        if d.is_empty() { self.base_dir.join("data").join("reports") } else { PathBuf::from(d) }
    }

    pub fn user_settings_path(&self) -> PathBuf {
        config::user_settings_path(&self.base_dir)
    }
}

/// この PC・このログインの識別（サーバーは利用者の PC で動くので、サーバーが見た名前を使う）。
pub fn me() -> (String, String) {
    let login = ["LOGNAME", "USER", "LNAME", "USERNAME"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "?".into());
    let pc = gethostname::gethostname().to_string_lossy().into_owned();
    (login, if pc.is_empty() { "?".into() } else { pc })
}
