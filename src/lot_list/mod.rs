//! ロット一覧（品質データ SQLite の写し）を引く。
//!
//! 絞り込み・並べ替え・ページの組み立ては WaveLog の /api/table と同じ:
//!   search  … どの列の字でも LIKE（列ごとに OR）
//!   filters … [{column, op, value}] を AND（最大 20 件）。op は WaveLog と同じ 12 種＋starts_any
//!   sorts   … [{column, dir}]（最大 4 キー）。実在する列だけを通す
//!   page / page_size … LIMIT / OFFSET
//!   group   … ロット番号でまとめる（group.rs）。並べ替えは効いたまま、ページの境目でロットを切らない

mod filter;
mod group;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use chrono::{Local, NaiveDate};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Map, Value};

use crate::sqlite_ro::{connect_ro, like_escape, norm_text, qi, to_date};
pub use filter::{build_filter_where, cutoff_date, safe_filters, safe_sorts, Filter, ALLOWED_OPS, MAX_FILTERS, MAX_SORTS};

pub const DATE_SAMPLE: usize = 60; // 日付の列か見分けるときに読む値の数
pub const DATE_RATIO: f64 = 0.8; // そのうち日付と読める割合がこれ以上なら日付の列
pub const PAGE_SIZE_MAX: i64 = 5000;
pub const PAGE_SIZE_DEFAULT: i64 = 500;
/// 表の既定（WaveLog の品質データの「既定テーブル」＝仕掛、品質情報の読み方の候補）
pub const TABLE_CANDIDATES: &[&str] = &["仕掛", "品質情報", "品質", "保留"];
pub const LOT_COLUMN_CANDIDATES: &[&str] = &["ロット番号", "ﾛｯﾄ番号", "ロット№", "LTNO"];
pub const MAX_LOTS: usize = 500; // 帳票に一度に出すロットの数の上限
pub const MAX_LOT_ROWS: usize = 20000; // そのロットの全行の上限（帳票の板の表に入れる行）

/// 呼び出し側の誤り（400）と、DB を読めない（503）を分ける。
#[derive(Debug)]
pub enum LotError {
    Invalid(String),
    Failed(String),
}

impl std::fmt::Display for LotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LotError::Invalid(s) | LotError::Failed(s) => f.write_str(s),
        }
    }
}

impl From<rusqlite::Error> for LotError {
    fn from(e: rusqlite::Error) -> Self {
        LotError::Failed(e.to_string())
    }
}

impl From<String> for LotError {
    fn from(s: String) -> Self {
        LotError::Failed(s)
    }
}

/// SQLite の値を JSON の値にする。
pub(crate) fn read_value(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::String(format!("（バイナリ {} バイト）", b.len())),
    }
}

/// 行を {列名: 値} にする。同じ名前の列が2つあれば後ろの値が残る（位置は前のまま）。
fn to_objects(raw_cs: &[String], rows: Vec<Vec<Value>>) -> Vec<Value> {
    rows.into_iter()
        .map(|r| Value::Object(raw_cs.iter().cloned().zip(r).collect::<Map<String, Value>>()))
        .collect()
}

fn fetch_rows(c: &Connection, sql: &str, params: &[SqlValue], ncols: usize) -> Result<Vec<Vec<Value>>, LotError> {
    let mut stmt = c.prepare(sql)?;
    let mut q = stmt.query(params_from_iter(params.iter()))?;
    let mut out = Vec::new();
    while let Some(r) = q.next()? {
        out.push((0..ncols).map(|i| read_value(r.get_ref_unwrap(i))).collect());
    }
    Ok(out)
}

pub fn tables(c: &Connection) -> Result<Vec<String>, LotError> {
    let mut stmt = c.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
    let names = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
    Ok(names)
}

/// 設定の表 → 候補の完全一致 → 候補を含む名前 → 最初の表。
pub fn pick_table(names: &[String], preferred: &str) -> String {
    if !preferred.is_empty() && names.iter().any(|n| n == preferred) {
        return preferred.to_string();
    }
    for c in TABLE_CANDIDATES {
        if let Some(n) = names.iter().find(|n| n == c) {
            return n.clone();
        }
    }
    for c in TABLE_CANDIDATES {
        if let Some(n) = names.iter().find(|n| n.contains(c)) {
            return n.clone();
        }
    }
    names.first().cloned().unwrap_or_default()
}

/// 表の列名を表の並びのまま（同じ名前が2つあってもそのまま。行の値と位置を合わせるため）。
pub fn raw_columns(c: &Connection, table: &str) -> Result<Vec<String>, LotError> {
    let mut stmt = c.prepare(&format!("PRAGMA table_info({})", qi(table)))?;
    let cols = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<Result<Vec<_>, _>>()?;
    Ok(cols)
}

/// 列名を1つずつ（行は辞書なので同名を2つ持てない）。
pub fn unique_columns(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in raw {
        if !out.contains(c) {
            out.push(c.clone());
        }
    }
    out
}

pub fn lot_column(cs: &[String]) -> String {
    for c in LOT_COLUMN_CANDIDATES {
        if cs.iter().any(|x| x == c) {
            return c.to_string();
        }
    }
    cs.iter().find(|c| c.contains("ロット") || c.contains("ﾛｯﾄ")).cloned().unwrap_or_default()
}

/// 値の大半（8 割以上）が日付と読める列。空欄は数えない。
fn date_columns(c: &Connection, table: &str, cs: &[String]) -> Result<Vec<String>, LotError> {
    let mut out = Vec::new();
    for col in cs {
        let q = qi(col);
        let sql = format!("SELECT {q} FROM {} WHERE {q} IS NOT NULL AND CStr({q})<>'' LIMIT {DATE_SAMPLE}", qi(table));
        let mut stmt = c.prepare(&sql)?;
        let vals: Vec<String> = stmt.query_map([], |r| Ok(crate::sqlite_ro::value_text(r.get_ref(0)?)))?.collect::<Result<_, _>>()?;
        if !vals.is_empty() && vals.iter().filter(|v| to_date(v).is_some()).count() as f64 / vals.len() as f64 >= DATE_RATIO {
            out.push(col.clone());
        }
    }
    Ok(out)
}

type DateKey = (String, u128, String, Vec<String>);
static DATE_CACHE: Mutex<Option<HashMap<DateKey, Vec<String>>>> = Mutex::new(None);

/// 写しは世代ごとに別のファイルなので、(ファイル, 更新時刻, 表, 列) が同じなら前の答えを使う。
fn date_columns_cached(path: &Path, c: &Connection, table: &str, cs: &[String]) -> Result<Vec<String>, LotError> {
    let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos());
    let Some(mtime) = mtime else { return date_columns(c, table, cs) };
    let key = (path.to_string_lossy().into_owned(), mtime, table.to_string(), cs.to_vec());
    if let Some(v) = DATE_CACHE.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(&key).cloned())) {
        return Ok(v);
    }
    let v = date_columns(c, table, cs)?;
    if let Ok(mut g) = DATE_CACHE.lock() {
        let m = g.get_or_insert_with(HashMap::new);
        if m.len() > 32 {
            m.clear();
        }
        m.insert(key, v.clone());
    }
    Ok(v)
}

/// 0件のとき、「以内」の条件ごとに、なぜ当たらないかを言うための材料（表全体・ほかの条件は外して数える）。
///
/// dated … その列で日付と読めた行の数 / newest・newestRaw … いちばん新しい日付（読んだ日付と元の値）/ oldest … いちばん古い日付
/// cutoff … この日付から後ろを探した（今日−N）/ alone … この条件だけなら何件当たるか（0 でなければ、ほかの条件と重なって 0 件）
fn date_hints(c: &Connection, table: &str, filters: &[Filter], today: NaiveDate) -> Result<Vec<Value>, LotError> {
    let mut out = Vec::new();
    for f in filters.iter().filter(|f| filter::is_relative(&f.op)) {
        let (col, t) = (qi(&f.column), qi(table));
        let cut = cutoff_date(&f.op, &f.value, today);
        let (dated, newest, oldest): (i64, Option<String>, Option<String>) = c.query_row(
            &format!("SELECT COUNT(*), MAX(ToDate({col})), MIN(ToDate({col})) FROM {t} WHERE ToDate({col}) IS NOT NULL"),
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let raw = match &newest {
            Some(n) => c
                .query_row(&format!("SELECT {col} FROM {t} WHERE ToDate({col}) = ? LIMIT 1"), [n], |r| Ok(read_value(r.get_ref(0)?)))
                .ok(),
            None => None,
        };
        let alone: i64 = c.query_row(&format!("SELECT COUNT(*) FROM {t} WHERE ToDate({col}) >= ?"), [&cut], |r| r.get(0))?;
        let filled: i64 = c.query_row(&format!("SELECT COUNT(*) FROM {t} WHERE {col} IS NOT NULL AND CStr({col})<>''"), [], |r| r.get(0))?;
        out.push(json!({"column": f.column, "op": f.op, "value": f.value, "cutoff": cut, "dated": dated, "filled": filled,
                        "newest": newest, "newestRaw": raw, "oldest": oldest, "alone": alone}));
    }
    Ok(out)
}

/// 開いた DB と、使う表。
struct Opened {
    conn: Connection,
    table: String,
    /// 表の列名を表の並びのまま（同名を含む）
    raw: Vec<String>,
    /// 重複を除いた列名
    cols: Vec<String>,
    /// DB にある表の名前
    names: Vec<String>,
}

/// 開いて、使う表を決める。
fn open_table(path: &Path, table: &str, preferred: &str) -> Result<Opened, LotError> {
    let c = connect_ro(path)?;
    let names = tables(&c)?;
    let t = if names.iter().any(|n| n == table) { table.to_string() } else { pick_table(&names, preferred) };
    if t.is_empty() {
        return Err(LotError::Failed("品質データにテーブルが1つもありません。".into()));
    }
    let raw = raw_columns(&c, &t)?;
    let cs = unique_columns(&raw);
    Ok(Opened { conn: c, table: t, raw, cols: cs, names })
}

/// 選んだロット番号の「全行」（帳票の 1 枚＝同じロット番号の行のまとまり）。
/// ロット番号は大小・前後の空白・全角半角・かなカナを同じとみなす（表の検索と同じ規則）。並びは表の順。
pub fn rows_of_lots(path: &Path, lots: &[String], table: &str, preferred: &str) -> Result<Value, LotError> {
    let mut want: Vec<String> = Vec::new();
    for v in lots {
        let k = norm_text(v).trim().to_string();
        if !k.is_empty() && !want.contains(&k) {
            want.push(k);
        }
    }
    if want.len() > MAX_LOTS {
        return Err(LotError::Invalid(format!("一度に出せるロットは {MAX_LOTS} 件までです（選んだのは {} 件）。", want.len())));
    }
    let Opened { conn: c, table: t, raw, cols: cs, .. } = open_table(path, table, preferred)?;
    let lot = lot_column(&cs);
    if lot.is_empty() {
        return Err(LotError::Failed("ロット番号の列が見つかりません（帳票を 1 ロットずつにまとめられません）。".into()));
    }
    let mut rows = Vec::new();
    for part in want.chunks(400) {
        // SQLite の引数の数の上限を超えないよう分ける
        let ph = vec!["?"; part.len()].join(",");
        let sql = format!("SELECT * FROM {} WHERE TRIM(Norm(CStr({}))) IN ({ph}) LIMIT {}", qi(&t), qi(&lot), MAX_LOT_ROWS + 1);
        let params: Vec<SqlValue> = part.iter().cloned().map(SqlValue::Text).collect();
        rows.extend(fetch_rows(&c, &sql, &params, raw.len())?);
        if rows.len() > MAX_LOT_ROWS {
            return Err(LotError::Invalid(format!("選んだロットの行が多すぎます（{MAX_LOT_ROWS} 行まで）。ロットを分けて出してください。")));
        }
    }
    Ok(json!({"table": t, "columns": cs, "lotColumn": lot, "rows": to_objects(&raw, rows)}))
}

/// 問い合わせの条件（画面から来た値をそのまま）。
#[derive(Debug, Clone)]
pub struct QueryOpts<'a> {
    pub table: &'a str,
    pub preferred_table: &'a str,
    pub page: i64,
    pub page_size: i64,
    pub search: &'a str,
    pub filters: &'a str,
    pub sorts: &'a str,
    pub today: Option<NaiveDate>,
    pub group: bool,
}

impl Default for QueryOpts<'_> {
    fn default() -> Self {
        Self { table: "", preferred_table: "", page: 1, page_size: PAGE_SIZE_DEFAULT, search: "", filters: "", sorts: "", today: None, group: false }
    }
}

pub fn query(path: &Path, o: &QueryOpts<'_>) -> Result<Value, LotError> {
    let t0 = Instant::now();
    let today = o.today.unwrap_or_else(|| Local::now().date_naive());
    let page = o.page.max(1);
    let size = if o.page_size <= 0 { PAGE_SIZE_DEFAULT } else { o.page_size.min(PAGE_SIZE_MAX) };
    let q = o.search.trim();
    let Opened { conn: c, table: t, raw: raw_cs, cols: cs, names } = open_table(path, o.table, o.preferred_table)?;

    let (mut where_parts, mut params): (Vec<String>, Vec<SqlValue>) = (Vec::new(), Vec::new());
    if !q.is_empty() {
        where_parts.push(format!("({})", cs.iter().map(|x| filter::norm_like(&qi(x))).collect::<Vec<_>>().join(" OR ")));
        params.extend(cs.iter().map(|_| SqlValue::Text(format!("%{}%", like_escape(&norm_text(q))))));
    }
    let fl = safe_filters(o.filters, &cs);
    let (fp, fpp) = build_filter_where(&fl, today);
    where_parts.extend(fp);
    params.extend(fpp);
    let where_sql = if where_parts.is_empty() { String::new() } else { format!(" WHERE {}", where_parts.join(" AND ")) };
    let order_parts = safe_sorts(o.sorts, &cs);
    let order_sql = if order_parts.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", order_parts.iter().map(|(col, d)| format!("{} {d}", qi(col))).collect::<Vec<_>>().join(","))
    };
    let count: i64 = c.query_row(&format!("SELECT COUNT(*) FROM {}{where_sql}", qi(&t)), params_from_iter(params.iter()), |r| r.get(0))?;
    let start = (page - 1) * size;
    let lot = lot_column(&cs);

    let mut extra = Map::new();
    let (rows, first, last) = if o.group && !lot.is_empty() {
        let gq = group::GroupQuery { table: &t, raw_cs: &raw_cs, lot: &lot, where_sql: &where_sql, params: &params, order: &order_parts, page, size };
        let g = group::grouped_rows(&c, &gq)?;
        extra.insert("groups".into(), json!(g.groups));
        extra.insert("groupCount".into(), json!(group::group_count(&c, &t, &lot, &where_sql, &params)?));
        (g.rows, g.first, g.last)
    } else {
        let sql = format!("SELECT * FROM {}{where_sql}{order_sql} LIMIT {size} OFFSET {start}", qi(&t));
        let rows = fetch_rows(&c, &sql, &params, raw_cs.len())?;
        let n = rows.len() as i64;
        (rows, if n > 0 { start + 1 } else { 0 }, if n > 0 { start + n } else { 0 })
    };
    let dcols = date_columns_cached(path, &c, &t, &cs)?;
    let hints = if count == 0 { date_hints(&c, &t, &fl, today)? } else { Vec::new() };

    let mut out = json!({
        "table": t, "tables": names, "columns": cs, "lotColumn": lot, "dateColumns": dcols,
        "today": today.format("%Y-%m-%d").to_string(), "dateHints": hints,
        "rows": to_objects(&raw_cs, rows),
        "count": count, "page": page, "page_size": size, "range": [first, last],
        "filters_applied": fl.len(),
        "sorts": order_parts.iter().map(|(col, d)| json!({"column": col, "dir": d.to_lowercase()})).collect::<Vec<_>>(),
        "timing": {"server": t0.elapsed().as_millis() as u64},
    });
    if let Some(m) = out.as_object_mut() {
        m.extend(extra);
    }
    Ok(out)
}
