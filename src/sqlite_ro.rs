//! SQLite を読み取り専用で開く（WaveLog の backend/sqlite_io.py と同じ作法）。
//!
//! - 開く前に stat しない。共有越しでは「開けるのに stat だけ失敗する」ことがあり、確認のつもりの1行が
//!   唯一の失敗原因になる。開けなかったときだけ理由を切り分ける。
//! - UNC（\\server\share\…）は 4 スラッシュの file:////server/share/… にする
//!   （2 スラッシュだと server を URI の authority と読まれ、SQLite は拒否する）。
//! - WaveLog の SQL と同じ方言で書けるよう、Access 風の CStr / Val / Nz と、画面の検索と同じ規則の
//!   Norm / ToDate を登録する。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use chrono::NaiveDate;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use regex::Regex;
use rusqlite::functions::{Context, FunctionFlags};
use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, OpenFlags};
use unicode_normalization::UnicodeNormalization;

/// 識別子を [ ] で括る（WaveLog と同じ）。
pub fn qi(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

/// 全角半角・大文字小文字・ひらがなカタカナを同じとみなす形（画面の DM.norm と同じ規則）。
pub fn norm_text(v: &str) -> String {
    v.nfkc()
        .collect::<String>()
        .to_lowercase()
        .chars()
        .map(|c| if ('\u{30a1}'..='\u{30f6}').contains(&c) { char::from_u32(c as u32 - 0x60).unwrap_or(c) } else { c })
        .collect()
}

/// LIKE の % と _ をただの文字として扱う（ESCAPE '\' と組で使う）。
pub fn like_escape(v: &str) -> String {
    v.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Python の str(float) と同じ書き方（整数の値は「5.0」）。
fn float_text(f: f64) -> String {
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e16 {
        format!("{f:.1}")
    } else {
        format!("{f}")
    }
}

/// CStr(v): 値を文字にする（NULL は空）。
pub fn value_text(v: ValueRef<'_>) -> String {
    match v {
        ValueRef::Null => String::new(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => float_text(f),
        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        ValueRef::Blob(b) => String::from_utf8_lossy(b).into_owned(),
    }
}

/// Val(v): 先頭の数（符号つき・小数可）だけを読む。読めなければ 0。
pub fn leading_number(s: &str) -> f64 {
    let t = s.trim_start();
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let d0 = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == d0 {
        return 0.0;
    }
    if i + 1 < b.len() && b[i] == b'.' && b[i + 1].is_ascii_digit() {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
    }
    t[..i].parse().unwrap_or(0.0)
}

/// Val(?) 相当。SQLite は型優先で比べるので、パラメータ側も数にして渡す。
pub fn numeric_value(v: &str) -> f64 {
    leading_number(v)
}

fn date_patterns() -> &'static [Regex; 4] {
    static P: OnceLock<[Regex; 4]> = OnceLock::new();
    P.get_or_init(|| {
        let r = |s: &str| Regex::new(s).expect("date pattern");
        [
            // 2026/09/28 10:00・2026-9-5・2026.09.28・2026-09-28T10:00
            r(r"^\s*([0-9]{4})[/\-.]([0-9]{1,2})[/\-.]([0-9]{1,2})(?:[ T].*)?$"),
            // 2026年9月28日
            r(r"^\s*([0-9]{4})年\s*([0-9]{1,2})月\s*([0-9]{1,2})日.*$"),
            // 20260928（8桁）
            r(r"^\s*([0-9]{4})([0-9]{2})([0-9]{2})(?:\s.*)?$"),
            // 26/09/28 23:48:54（LotDsp などの2桁の年＝2000年代）
            r(r"^\s*([0-9]{2})[/\-.]([0-9]{1,2})[/\-.]([0-9]{1,2})(?:[ T].*)?$"),
        ]
    })
}

/// 値を日付として読めれば 'YYYY-MM-DD'、読めなければ None（SQL では ToDate(列)）。
pub fn to_date(v: &str) -> Option<String> {
    let s = v.trim();
    if s.is_empty() {
        return None;
    }
    for rx in date_patterns() {
        if let Some(m) = rx.captures(s) {
            let n = |i: usize| m[i].parse::<i32>().ok();
            let (mut y, mo, d) = (n(1)?, n(2)?, n(3)?);
            if y < 100 {
                y += 2000;
            }
            return NaiveDate::from_ymd_opt(y, u32::try_from(mo).ok()?, u32::try_from(d).ok()?).map(|x| x.format("%Y-%m-%d").to_string());
        }
    }
    None
}

// ---------------------------------------------------------------- 接続
/// Python の quote(safe="/") と同じ（英数字と _ . - ~ と / 以外を %XX に）。
const URI_SET: &AsciiSet = &NON_ALPHANUMERIC.remove(b'/').remove(b'_').remove(b'.').remove(b'-').remove(b'~');

/// 読み取り専用の URI（`file:…?mode=ro`）。
pub fn ro_uri(path: &Path) -> String {
    let abs: PathBuf = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let posix = abs.to_string_lossy().replace('\\', "/");
    if posix.starts_with("//") {
        return format!("file://{}?mode=ro", utf8_percent_encode(&posix, URI_SET));
    }
    // Windows のドライブ（C:/…）は先頭に / を付け、: は残す
    let bytes = posix.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return format!("file:///{}:{}?mode=ro", &posix[..1], utf8_percent_encode(&posix[2..], URI_SET));
    }
    format!("file://{}?mode=ro", utf8_percent_encode(&posix, URI_SET))
}

/// 引数をそのままの型で返す（Nz 用）。
fn opaque(ctx: &Context<'_>, i: usize) -> Value {
    match ctx.get_raw(i) {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(n) => Value::Integer(n),
        ValueRef::Real(f) => Value::Real(f),
        ValueRef::Text(t) => Value::Text(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::Blob(b.to_vec()),
    }
}

/// WaveLog の SQL と同じ方言の関数を登録する。
fn register_functions(c: &Connection) -> rusqlite::Result<()> {
    let det = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    c.create_scalar_function("CStr", 1, det, |ctx| Ok(value_text(ctx.get_raw(0))))?;
    c.create_scalar_function("Val", 1, det, |ctx| Ok(leading_number(&value_text(ctx.get_raw(0)))))?;
    c.create_scalar_function("Nz", 2, det, |ctx| {
        Ok(if matches!(ctx.get_raw(0), ValueRef::Null) { opaque(ctx, 1) } else { opaque(ctx, 0) })
    })?;
    c.create_scalar_function("Norm", 1, det, |ctx| Ok(norm_text(&value_text(ctx.get_raw(0)))))?;
    c.create_scalar_function("ToDate", 1, det, |ctx| {
        Ok(match ctx.get_raw(0) {
            ValueRef::Null => None,
            v => to_date(&value_text(v)),
        })
    })?;
    Ok(())
}

/// 読み取り専用で開く。開けなければ理由を切り分けた文を返す。
pub fn connect_ro(path: &Path) -> Result<Connection, String> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let c = match Connection::open_with_flags(ro_uri(path), flags) {
        Ok(c) => c,
        Err(e) => {
            return Err(match path.try_exists() {
                Ok(false) => format!("データベースが見つかりません: {}", path.display()),
                _ => format!("データベースを開けませんでした: {}（SQLite: {e}）", path.display()),
            })
        }
    };
    let _ = c.busy_timeout(std::time::Duration::from_secs(10));
    register_functions(&c).map_err(|e| format!("SQL 関数を登録できませんでした: {e}"))?;
    Ok(c)
}

/// Python の `str(v)` に近い、JSON の値の文字化（`v or ""` の形で使う: 空・0・false・null は空）。
pub fn json_text(v: Option<&serde_json::Value>) -> String {
    use serde_json::Value as J;
    match v {
        None | Some(J::Null) | Some(J::Bool(false)) => String::new(),
        Some(J::Bool(true)) => "True".into(),
        Some(J::String(s)) => s.clone(),
        Some(J::Number(n)) => match n.as_f64() {
            Some(0.0) => String::new(),
            _ if n.is_f64() => float_text(n.as_f64().unwrap_or(0.0)),
            _ => n.to_string(),
        },
        Some(other) => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_folds_width_case_and_kana() {
        assert_eq!(norm_text("ＳＨＦ"), "shf");
        assert_eq!(norm_text("シャフト"), norm_text("しゃふと"));
        assert_eq!(norm_text("ﾛｯﾄ"), norm_text("ろっと"));
    }

    #[test]
    fn val_reads_leading_number_only() {
        assert_eq!(leading_number("  -12.5kg"), -12.5);
        assert_eq!(leading_number("7."), 7.0);
        assert_eq!(leading_number("abc"), 0.0);
        assert_eq!(leading_number("+3"), 3.0);
    }

    #[test]
    fn dates_in_mixed_notations() {
        for s in ["2026/09/28 10:00", "2026-9-5", "2026.09.28", "2026年9月28日", "20260928", "26/09/28 23:48:54"] {
            assert!(to_date(s).is_some(), "{s}");
        }
        assert_eq!(to_date("26/09/28").as_deref(), Some("2026-09-28"));
        assert_eq!(to_date("2026/13/40"), None);
        assert_eq!(to_date("abc"), None);
        assert_eq!(to_date(""), None);
    }

    #[test]
    fn uri_for_unc_and_plain_paths() {
        assert!(ro_uri(Path::new("//server/share/a b.sqlite3")).starts_with("file:////server/share/a%20b.sqlite3"));
        assert!(ro_uri(Path::new("/tmp/日本.db")).ends_with("?mode=ro"));
    }

    #[test]
    fn sql_functions_work() {
        let c = Connection::open_in_memory().unwrap();
        register_functions(&c).unwrap();
        let s: String = c.query_row("SELECT Norm(CStr('ＡＢＣ'))", [], |r| r.get(0)).unwrap();
        assert_eq!(s, "abc");
        let n: i64 = c.query_row("SELECT Nz(NULL, 5)", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 5);
        let d: Option<String> = c.query_row("SELECT ToDate('2026/9/1')", [], |r| r.get(0)).unwrap();
        assert_eq!(d.as_deref(), Some("2026-09-01"));
        let e: String = c.query_row("SELECT CStr(5.0)", [], |r| r.get(0)).unwrap();
        assert_eq!(e, "5.0");
    }
}
