//! 「ロット番号でまとめる」表示の 1 ページ分（窓関数）。

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde_json::Value;

use super::{read_value, LotError};
use crate::sqlite_ro::qi;

/// まとめるときのロットの見分け方（大小・前後の空白は同じロット）。
fn lot_key(col: &str) -> String {
    format!("UPPER(TRIM(CStr({})))", qi(col))
}

/// まとめる対象（どの表の・どの条件の・何ページ目か）。
pub struct GroupQuery<'a> {
    pub table: &'a str,
    pub raw_cs: &'a [String],
    pub lot: &'a str,
    pub where_sql: &'a str,
    pub params: &'a [SqlValue],
    pub order: &'a [(String, &'static str)],
    pub page: i64,
    pub size: i64,
}

pub struct GroupedPage {
    pub rows: Vec<Vec<Value>>,
    /// [そのロットの行数, ロットの中の何行目]
    pub groups: Vec<[i64; 2]>,
    pub first: i64,
    pub last: i64,
}

/// ロット番号でまとめた並びの1ページ分。
///
/// - ロットの順は、並べ替え（無ければ表の順）で「そのロットでいちばん上に来る行」の順。ロットの中も同じ並べ替えの順。
///   こうすると並べ替えは、ロットの間でも中でも効いたままになる。
/// - ロットは、その先頭の行が入るページに丸ごと入る（ページの境目で切らない。そのぶん1ページが size を少し超える）。
///   大きいロットが次の区切りをまたいで、先頭の行が1つも入らない区切りができたら、その区切りは飛ばす（空のページを作らない）。
/// - ロット番号が空の行はまとめない（1行ずつ）。
pub fn grouped_rows(c: &Connection, g: &GroupQuery<'_>) -> Result<GroupedPage, LotError> {
    let GroupQuery { table, raw_cs, lot, where_sql, params, order, page, size } = *g;
    let over = if order.is_empty() {
        String::new()
    } else {
        format!("ORDER BY {}", order.iter().map(|(col, d)| format!("{} {d}", qi(col))).collect::<Vec<_>>().join(","))
    };
    let cols = raw_cs.iter().map(|x| qi(x)).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "WITH b AS (SELECT *, ROW_NUMBER() OVER ({over}) AS _tpa_rn, {key} AS _tpa_k0 FROM {t}{where_sql}),
         k AS (SELECT *, CASE WHEN _tpa_k0 = '' THEN '#' || _tpa_rn ELSE _tpa_k0 END AS _tpa_k FROM b),
         g AS (SELECT *, MIN(_tpa_rn) OVER (PARTITION BY _tpa_k) AS _tpa_first, COUNT(*) OVER (PARTITION BY _tpa_k) AS _tpa_n FROM k),
         p AS (SELECT *, ROW_NUMBER() OVER (ORDER BY _tpa_first, _tpa_rn) AS _tpa_pos FROM g),
         q AS (SELECT *, MIN(_tpa_pos) OVER (PARTITION BY _tpa_k) AS _tpa_head FROM p),
         r AS (SELECT *, DENSE_RANK() OVER (ORDER BY (_tpa_head - 1) / {size}) AS _tpa_page FROM q)
         SELECT {cols}, _tpa_n, _tpa_pos - _tpa_head + 1, _tpa_pos FROM r
         WHERE _tpa_page = ? ORDER BY _tpa_pos",
        key = lot_key(lot),
        t = qi(table),
    );
    let mut all: Vec<SqlValue> = params.to_vec();
    all.push(SqlValue::Integer(page));
    let mut stmt = c.prepare(&sql)?;
    let n = raw_cs.len();
    let mut rows = Vec::new();
    let (mut groups, mut first, mut last) = (Vec::new(), 0, 0);
    let mut q = stmt.query(params_from_iter(all.iter()))?;
    while let Some(r) = q.next()? {
        rows.push((0..n).map(|i| read_value(r.get_ref_unwrap(i))).collect());
        groups.push([r.get::<_, i64>(n)?, r.get::<_, i64>(n + 1)?]);
        let pos: i64 = r.get(n + 2)?;
        if first == 0 {
            first = pos;
        }
        last = pos;
    }
    Ok(GroupedPage { rows, groups, first, last })
}

/// まとめたときのロットの数（ロット番号が空の行は1行ずつ数える）。
pub fn group_count(c: &Connection, table: &str, lot: &str, where_sql: &str, params: &[SqlValue]) -> Result<i64, LotError> {
    let sql = format!(
        "SELECT COUNT(DISTINCT NULLIF(k, '')) + COALESCE(SUM(k = ''), 0) FROM (SELECT {} AS k FROM {}{where_sql})",
        lot_key(lot),
        qi(table)
    );
    Ok(c.query_row(&sql, params_from_iter(params.iter()), |r| r.get(0))?)
}
