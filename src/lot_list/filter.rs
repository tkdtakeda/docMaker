//! 絞り込み・並べ替えの条件の読み取りと、WHERE の組み立て（WaveLog の /api/table と同じ規則）。
//!
//! 列名は実在するものだけを SQL へ入れ（qi で括る）、値はすべてパラメータで渡す。

use chrono::{Datelike, Duration, NaiveDate};
use rusqlite::types::Value as SqlValue;
use serde_json::Value;

use crate::sqlite_ro::{json_text, like_escape, norm_text, numeric_value, qi};

pub const ALLOWED_OPS: &[&str] = &[
    "contains", "not_contains", "eq", "neq", "starts", "starts_any", "ends", "gt", "gte", "lt", "lte", "empty", "not_empty",
    // 今日から数えて N 日（週・か月・年）以内。日付と読める値だけが当たる（ToDate(列) >= 今日−N）
    "within_days", "within_weeks", "within_months", "within_years",
];
pub const MAX_FILTERS: usize = 20;
pub const MAX_SORTS: usize = 4;

#[derive(Debug, Clone, PartialEq)]
pub struct Filter {
    pub column: String,
    pub op: String,
    pub value: String,
}

/// 「以内」の条件か。
pub fn is_relative(op: &str) -> bool {
    matches!(op, "within_days" | "within_weeks" | "within_months" | "within_years")
}

/// 画面から来た条件（JSON の文字）。壊れた・知らない列や演算子は黙って捨てる。
pub fn safe_filters(text: &str, cs: &[String]) -> Vec<Filter> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let mut out = Vec::new();
    for it in items.iter().take(MAX_FILTERS) {
        let Some(o) = it.as_object() else { continue };
        let column = json_text(o.get("column")).trim().to_string();
        let op = match json_text(o.get("op")).trim() {
            "" => "contains".to_string(),
            s => s.to_string(),
        };
        let value = json_text(o.get("value")).trim().to_string();
        if cs.contains(&column) && ALLOWED_OPS.contains(&op.as_str()) {
            out.push(Filter { column, op, value });
        }
    }
    out
}

/// 「今日から N 単位前」の日付（'YYYY-MM-DD'）。N は 0 以上の整数（0＝今日から）。
pub fn cutoff_date(op: &str, value: &str, today: NaiveDate) -> String {
    const FLOOR: &str = "0001-01-01";
    let n = value.trim().parse::<f64>().ok().filter(|f| f.is_finite()).map_or(0.0, |f| f.trunc().max(0.0)).min(100_000_000.0) as i64;
    let fmt = |d: NaiveDate| d.format("%Y-%m-%d").to_string();
    let by_days = |days: i64| Duration::try_days(days).and_then(|d| today.checked_sub_signed(d)).map_or_else(|| FLOOR.to_string(), fmt);
    match op {
        "within_days" => by_days(n),
        "within_weeks" => by_days(n * 7),
        _ => {
            let months = n * if op == "within_years" { 12 } else { 1 };
            let total = i64::from(today.year()) * 12 + i64::from(today.month()) - 1 - months;
            let (y, m) = (total.div_euclid(12), total.rem_euclid(12) as u32 + 1);
            let Ok(y) = i32::try_from(y) else { return FLOOR.to_string() };
            // その月の末日までに丸める（3/31 の 1 か月前は 2/28 か 2/29）
            let last = (1..=31).rev().find(|&d| NaiveDate::from_ymd_opt(y, m, d).is_some()).unwrap_or(28);
            NaiveDate::from_ymd_opt(y, m, today.day().min(last)).map_or_else(|| FLOOR.to_string(), fmt)
        }
    }
}

/// 列の値を「全角半角・大文字小文字・かなカナを同じとみなす形」にして LIKE で比べる（画面側の検索と同じ規則）。
pub fn norm_like(col: &str) -> String {
    format!("Norm(CStr({col})) LIKE ? ESCAPE '\\'")
}

fn text(s: String) -> SqlValue {
    SqlValue::Text(s)
}

/// 条件を AND でつなぐ WHERE の部品とパラメータ。
pub fn build_filter_where(filters: &[Filter], today: NaiveDate) -> (Vec<String>, Vec<SqlValue>) {
    let (mut parts, mut params) = (Vec::new(), Vec::new());
    for f in filters {
        let col = qi(&f.column);
        let nv = like_escape(&norm_text(&f.value));
        match f.op.as_str() {
            "contains" => {
                parts.push(norm_like(&col));
                params.push(text(format!("%{nv}%")));
            }
            "not_contains" => {
                parts.push(format!("({col} IS NULL OR Norm(CStr({col})) NOT LIKE ? ESCAPE '\\')"));
                params.push(text(format!("%{nv}%")));
            }
            "eq" => {
                parts.push(format!("Norm(CStr({col}))=?"));
                params.push(text(norm_text(&f.value)));
            }
            "neq" => {
                parts.push(format!("(Norm(CStr({col}))<>? OR {col} IS NULL)"));
                params.push(text(norm_text(&f.value)));
            }
            "starts" => {
                parts.push(norm_like(&col));
                params.push(text(format!("{nv}%")));
            }
            "starts_any" => {
                let vals: Vec<&str> = f.value.split(',').filter(|x| !x.is_empty()).take(60).collect();
                if vals.is_empty() {
                    parts.push("0=1".into());
                } else {
                    parts.push(format!("({})", vals.iter().map(|_| norm_like(&col)).collect::<Vec<_>>().join(" OR ")));
                    params.extend(vals.iter().map(|v| text(format!("{}%", like_escape(&norm_text(v))))));
                }
            }
            "ends" => {
                parts.push(norm_like(&col));
                params.push(text(format!("%{nv}")));
            }
            "empty" => parts.push(format!("({col} IS NULL OR CStr({col})='')")),
            "not_empty" => parts.push(format!("({col} IS NOT NULL AND CStr({col})<>'')")),
            op if is_relative(op) => {
                parts.push(format!("ToDate({col}) >= ?"));
                params.push(text(cutoff_date(op, &f.value, today)));
            }
            op @ ("gt" | "gte" | "lt" | "lte") => {
                let sign = match op {
                    "gt" => ">",
                    "gte" => ">=",
                    "lt" => "<",
                    _ => "<=",
                };
                parts.push(format!("Val(CStr({col})) {sign} ?"));
                params.push(SqlValue::Real(numeric_value(&f.value)));
            }
            _ => {}
        }
    }
    (parts, params)
}

/// 並べ替えの指定（実在する列だけ・同じ列は1度・最大 4 キー）。→ (列, "ASC"|"DESC")
pub fn safe_sorts(text: &str, cs: &[String]) -> Vec<(String, &'static str)> {
    let items = match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(a)) => a,
        _ => Vec::new(),
    };
    let mut out: Vec<(String, &'static str)> = Vec::new();
    for it in items {
        let (col, dir) = match &it {
            Value::String(s) => (s.trim().to_string(), String::new()),
            Value::Object(o) => (json_text(o.get("column")).trim().to_string(), json_text(o.get("dir")).to_lowercase()),
            _ => continue,
        };
        if !cs.contains(&col) || out.iter().any(|(c, _)| *c == col) {
            continue;
        }
        out.push((col, if dir == "desc" { "DESC" } else { "ASC" }));
        if out.len() >= MAX_SORTS {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn cutoff_days_weeks_months_years() {
        assert_eq!(cutoff_date("within_days", "30", d(2026, 11, 5)), "2026-10-06");
        assert_eq!(cutoff_date("within_weeks", "2", d(2026, 11, 5)), "2026-10-22");
        assert_eq!(cutoff_date("within_months", "1", d(2026, 3, 31)), "2026-02-28");
        assert_eq!(cutoff_date("within_months", "1", d(2024, 3, 31)), "2024-02-29");
        assert_eq!(cutoff_date("within_years", "1", d(2024, 2, 29)), "2023-02-28");
        assert_eq!(cutoff_date("within_months", "13", d(2026, 1, 15)), "2024-12-15");
        assert_eq!(cutoff_date("within_days", "abc", d(2026, 11, 5)), "2026-11-05");
        assert_eq!(cutoff_date("within_days", "99999999999", d(2026, 11, 5)), "0001-01-01");
    }

    #[test]
    fn unknown_columns_and_ops_are_dropped() {
        let cs = vec!["状態".to_string()];
        let t = r#"[{"column":"状態","op":"eq","value":"完了"},{"column":"無い","op":"eq","value":"x"},{"column":"状態","op":"ひどい","value":"x"}]"#;
        assert_eq!(safe_filters(t, &cs).len(), 1);
        assert!(safe_filters("{壊れた", &cs).is_empty());
    }

    #[test]
    fn sorts_are_unique_and_capped() {
        let cs: Vec<String> = ["a", "b", "c", "d", "e"].iter().map(|s| s.to_string()).collect();
        let s = safe_sorts(r#"["a",{"column":"a"},{"column":"b","dir":"DESC"},"c","d","e"]"#, &cs);
        assert_eq!(s.len(), MAX_SORTS);
        assert_eq!(s[1], ("b".to_string(), "DESC"));
    }
}
