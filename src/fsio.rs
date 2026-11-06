//! ファイル入出力の小さな部品（共有フォルダ越しでも壊さない書き方）。

use std::io;
use std::path::Path;
use std::thread::sleep;
use std::time::{Duration, Instant};

use chrono::{Local, NaiveDateTime};
use serde::Serialize;

/// いまの時刻を `2026-11-06T12:34:56` の形で（ローカル時刻・秒まで）。
pub fn now_iso() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// `now_iso` で書いた時刻（小数秒つきも可）を読む。読めなければ None。
pub fn parse_iso(s: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(s.trim(), "%Y-%m-%dT%H:%M:%S%.f").ok()
}

/// いまから `s` までの秒数（未来なら負）。
pub fn age_secs(s: &str) -> Option<f64> {
    let t = parse_iso(s)?;
    Some((Local::now().naive_local() - t).num_milliseconds() as f64 / 1000.0)
}

const WAITS: [f64; 5] = [0.05, 0.1, 0.2, 0.4, 0.8];

/// Windows では開かれている間、置き換え・削除が拒まれる。少し待ってやり直す（budget 秒まで）。
pub fn retrying<T>(mut f: impl FnMut() -> io::Result<T>, budget: f64) -> io::Result<T> {
    let start = Instant::now();
    let mut last = None;
    for w in std::iter::once(0.0).chain(WAITS) {
        if w > 0.0 {
            sleep(Duration::from_secs_f64(w));
        }
        match f() {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = Some(e);
                if start.elapsed().as_secs_f64() > budget {
                    break;
                }
            }
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("retrying: no attempt")))
}

/// JSON を一時ファイルへ書いてから置き換える（読む側が書きかけを見ない）。`pretty` が偽なら詰めて書く。
pub fn write_json_atomic<T: Serialize>(path: &Path, data: &T, pretty: bool, retry_budget: f64) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = if pretty { serde_json::to_string_pretty(data) } else { serde_json::to_string(data) }.map_err(io::Error::other)?;
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(format!(".{}.tmp", std::process::id()));
    let tmp = path.with_file_name(name);
    std::fs::write(&tmp, text)?;
    if let Err(e) = retrying(|| std::fs::rename(&tmp, path), retry_budget) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// JSON ファイルを読む。無ければ Ok(None)、読めない・壊れていれば Err。
pub fn read_json(path: &Path) -> io::Result<Option<serde_json::Value>> {
    match std::fs::read_to_string(path) {
        Ok(t) => serde_json::from_str(&t).map(Some).map_err(io::Error::other),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
