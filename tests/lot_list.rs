//! ロット一覧（SQLite の読み取り・写し・API）のテスト。  cargo test

mod common;

use std::path::PathBuf;
use std::time::Duration;

use axum::http::Method;
use chrono::NaiveDate;
use common::{sample_db, settings, Env};
use docmaker::lot_list::{query, QueryOpts};
use serde_json::{json, Value};

fn f(items: &[(&str, &str, &str)]) -> String {
    json!(items.iter().map(|(c, o, v)| json!({"column": c, "op": o, "value": v})).collect::<Vec<_>>()).to_string()
}

struct Db {
    _t: tempfile::TempDir,
    path: PathBuf,
}

fn db(rows: usize) -> Db {
    let t = tempfile::tempdir().unwrap();
    let path = t.path().join("q.sqlite3");
    sample_db(&path, rows);
    Db { _t: t, path }
}

fn q(d: &Db, o: QueryOpts<'_>) -> Value {
    query(&d.path, &o).unwrap_or_else(|e| panic!("{e}"))
}

fn count(d: &Db, o: QueryOpts<'_>) -> i64 {
    q(d, o)["count"].as_i64().unwrap()
}

fn day(y: i32, m: u32, d: u32) -> Option<NaiveDate> {
    NaiveDate::from_ymd_opt(y, m, d)
}

#[test]
fn columns_and_defaults() {
    let d = db(400);
    let r = q(&d, QueryOpts::default());
    assert_eq!(r["table"], json!("仕掛"));
    assert_eq!(r["columns"].as_array().unwrap()[..3], [json!("ロット番号"), json!("品名"), json!("品番")]);
    assert_eq!(r["lotColumn"], json!("ロット番号"));
    assert!(r["dateColumns"].as_array().unwrap().contains(&json!("製造日")));
    assert!(r["count"].as_i64().unwrap() > 400); // 一部のロットは複数行
}

#[test]
fn search_ignores_width_case_and_kana() {
    let d = db(400);
    let base = count(&d, QueryOpts { search: "SHF", ..Default::default() });
    assert!(base > 0);
    assert_eq!(count(&d, QueryOpts { search: "ｓｈｆ", ..Default::default() }), base); // 全角・小文字
    let hira = count(&d, QueryOpts { search: "しゃふと", ..Default::default() });
    assert_eq!(hira, count(&d, QueryOpts { search: "シャフト", ..Default::default() })); // ひらがな・カタカナ
    assert!(hira > 0);
}

#[test]
fn wildcards_are_plain_characters() {
    let d = db(400);
    let n = count(&d, QueryOpts { search: "100%", ..Default::default() });
    assert_eq!(count(&d, QueryOpts { search: "%", ..Default::default() }), n); // 「%」を含むのは「100%検査」の行だけ
    assert!(n > 0);
    let all = count(&d, QueryOpts::default());
    assert!(count(&d, QueryOpts { search: "A_1", ..Default::default() }) < all); // _ も1文字の何でもではない
}

#[test]
fn filter_ops() {
    let d = db(400);
    let total = count(&d, QueryOpts::default());
    let c = |items: &[(&str, &str, &str)]| count(&d, QueryOpts { filters: &f(items), ..Default::default() });
    assert_eq!(c(&[("状態", "eq", "完了")]) + c(&[("状態", "neq", "完了")]), total);
    assert_eq!(c(&[("状態", "eq", "完了"), ("顧客", "contains", "東洋")]), c(&[("顧客", "contains", "東洋"), ("状態", "eq", "完了")]));
    assert_eq!(c(&[("担当者", "empty", "")]) + c(&[("担当者", "not_empty", "")]), total);
    assert!(c(&[("数量", "gte", "1000")]) > 0);
    assert_eq!(c(&[("ロット番号", "starts", "l26")]), c(&[("ロット番号", "starts", "Ｌ26")]));
    assert!(c(&[("品番", "starts_any", "SHF,BRK")]) > c(&[("品番", "starts", "SHF")]));
    assert!(c(&[("品番", "ends", "1001")]) > 0);
}

#[test]
fn relative_date_filter() {
    let d = db(400);
    let o = |v: &'static str| QueryOpts { filters: Box::leak(f(&[("製造日", "within_days", v)]).into_boxed_str()), today: day(2026, 11, 5), ..Default::default() };
    let n = count(&d, o("30"));
    assert!(n > 0);
    assert!(n < count(&d, QueryOpts::default()));
    assert_eq!(count(&d, o("9999")), count(&d, QueryOpts { filters: &f(&[("製造日", "not_empty", "")]), ..Default::default() }));
}

#[test]
fn unknown_columns_and_ops_are_ignored() {
    let d = db(400);
    let total = count(&d, QueryOpts::default());
    assert_eq!(count(&d, QueryOpts { filters: &f(&[("存在しない列", "contains", "x"), ("状態", "ひどい演算", "x")]), ..Default::default() }), total);
    assert_eq!(count(&d, QueryOpts { sorts: r#"[{"column":"存在しない列"}]"#, ..Default::default() }), total);
    assert_eq!(count(&d, QueryOpts { filters: "{壊れた json", ..Default::default() }), total);
}

#[test]
fn sort_and_paging() {
    let d = db(400);
    let a = q(&d, QueryOpts { sorts: &json!([{"column": "数量", "dir": "desc"}]).to_string(), page_size: 10, ..Default::default() });
    let qs: Vec<i64> = a["rows"].as_array().unwrap().iter().map(|r| r["数量"].as_i64().unwrap()).collect();
    let mut sorted = qs.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(qs, sorted);
    let (p1, p2) = (q(&d, QueryOpts { page: 1, page_size: 50, ..Default::default() }), q(&d, QueryOpts { page: 2, page_size: 50, ..Default::default() }));
    assert_eq!(p1["range"], json!([1, 50]));
    assert_eq!(p2["range"], json!([51, 100]));
    assert_ne!(p1["rows"][0], p2["rows"][0]);
}

#[test]
fn group_never_splits_a_lot_across_pages() {
    let d = db(400);
    let n = count(&d, QueryOpts { group: true, page_size: 40, ..Default::default() }) as usize;
    let (mut pages, mut seen) = (Vec::<Vec<String>>::new(), Vec::<String>::new());
    for page in 1.. {
        let r = q(&d, QueryOpts { group: true, page_size: 40, page, ..Default::default() });
        let rows = r["rows"].as_array().unwrap();
        if rows.is_empty() {
            break;
        }
        let lots: Vec<String> = rows.iter().map(|x| x["ロット番号"].as_str().unwrap().to_string()).collect();
        assert_eq!(r["groups"].as_array().unwrap().len(), rows.len());
        seen.extend(lots.clone());
        pages.push(lots);
    }
    assert_eq!(seen.len(), n); // 取りこぼし・重複なし
    for w in pages.windows(2) {
        assert!(!w[0].iter().any(|l| w[1].contains(l)), "ロットがページの境目で切れている");
    }
}

#[test]
fn zero_hits_explains_relative_filter() {
    let d = db(400);
    let r = q(&d, QueryOpts { filters: &f(&[("製造日", "within_days", "1")]), today: day(2030, 1, 1), ..Default::default() });
    assert_eq!(r["count"], json!(0));
    assert_eq!(r["dateHints"][0]["column"], json!("製造日"));
    assert!(r["dateHints"][0]["newest"].is_string());
}

#[test]
fn one_lot_row_keeps_original_values_and_types() {
    let d = db(50);
    let r = q(&d, QueryOpts { page_size: 1, ..Default::default() });
    let row = &r["rows"][0];
    assert!(row["数量"].is_i64()); // 数は数のまま
    assert!(row["品名"].is_string());
}

// ---------------------------------------------------------------- API
fn api_env(page_size: u64) -> Env {
    Env::new(settings(|s| {
        s.lot_list.page_size = page_size;
        s.lot_list.interval_sec = 10;
    }))
}

async fn set_source(env: &Env, path: &str) -> (axum::http::StatusCode, Value) {
    env.json(Method::POST, "/api/settings", &json!({"lot_list": {"source": path, "table": ""}})).await
}

#[tokio::test]
async fn unset_source_says_so() {
    let env = api_env(50);
    let (s, j) = env.get("/api/lotlist").await;
    assert_eq!(s, 400);
    assert!(j["error"].as_str().unwrap().contains("元ファイル"));
}

#[tokio::test]
async fn settings_validation_and_storage() {
    let env = api_env(50);
    assert_eq!(env.json(Method::POST, "/api/settings", &json!({})).await.0, 400);
    assert_eq!(env.json(Method::POST, "/api/settings", &json!({"lot_list": {"source": 5}})).await.0, 400);
    assert_eq!(env.json(Method::POST, "/api/settings", &json!({"lot_list": {"source": "x".repeat(501)}})).await.0, 400);
    let (s, j) = set_source(&env, "  \"C:\\data\\q.sqlite3\"  ").await;
    assert_eq!(s, 200);
    assert_eq!(j["lot_list"]["source"], json!("C:\\data\\q.sqlite3")); // 引用符・空白を外す
    assert!(env.root.join("data/user_settings.json").exists());
    let cfg = std::fs::read_to_string(env.root.join("config/settings.json")).unwrap();
    assert!(!cfg.contains("lot_list")); // 設定ファイル（配る物）は変えない
    assert_eq!(env.get("/api/settings").await.1["lot_list"]["page_size"], json!(50));
}

#[tokio::test]
async fn reads_through_mirror_and_reports_source() {
    let env = api_env(50);
    let src = env.root.join("src.sqlite3");
    sample_db(&src, 120);
    set_source(&env, src.to_str().unwrap()).await;
    let (s, j) = env.get("/api/lotlist?page_size=20").await;
    assert_eq!(s, 200, "{j}");
    assert_eq!(j["rows"].as_array().unwrap().len(), 20);
    assert_eq!(j["source"]["mirrored"], json!(true));
    assert_eq!(j["source"]["unreachable"], json!(false));
    assert!(j["source"]["at"].is_number());
    let mirror = env.state.lot_mirror.mirror_path().unwrap();
    assert!(mirror.to_string_lossy().contains("mirror")); // 写しを読んでいる（元を直接読まない）
    assert_eq!(env.get("/api/lotlist").await.1["page_size"], json!(50)); // 設定の 1 ページの件数
}

#[tokio::test]
async fn unreachable_source_gives_reason() {
    let env = api_env(50);
    set_source(&env, env.root.join("nothing.sqlite3").to_str().unwrap()).await;
    let (s, j) = env.get("/api/lotlist").await;
    assert_eq!(s, 503);
    assert!(j["error"].is_string());
    assert!(j["source"]["unreachable"] == json!(true) || j["error"].as_str().unwrap().contains("見つかりません"), "{j}");
}

#[tokio::test]
async fn refresh_picks_up_a_replaced_source() {
    let env = api_env(50);
    let src = env.root.join("src.sqlite3");
    sample_db(&src, 120);
    set_source(&env, src.to_str().unwrap()).await;
    let n0 = env.get("/api/lotlist").await.1["count"].as_i64().unwrap();
    rusqlite::Connection::open(&src).unwrap().execute("INSERT INTO 仕掛 (ロット番号, 品名) VALUES ('NEW-1', '追加')", []).unwrap();
    let (_, r) = env.json(Method::POST, "/api/lotlist/refresh", &json!({})).await;
    assert_eq!(r["result"]["updated"], json!(true), "{r}");
    assert_eq!(env.get("/api/lotlist").await.1["count"].as_i64().unwrap(), n0 + 1);
    let (_, r2) = env.json(Method::POST, "/api/lotlist/refresh", &json!({})).await; // 変わっていなくても写し直す（再読込）
    assert_eq!(r2["result"]["updated"], json!(true));
}

#[tokio::test]
async fn refresh_without_source_is_refused() {
    let env = api_env(50);
    assert_eq!(env.json(Method::POST, "/api/lotlist/refresh", &json!({})).await.0, 400);
}

#[tokio::test]
async fn bad_file_is_rejected_not_adopted() {
    let env = api_env(50);
    let bad = env.root.join("bad.sqlite3");
    std::fs::write(&bad, "this is not a database".repeat(100)).unwrap();
    set_source(&env, bad.to_str().unwrap()).await;
    assert_eq!(env.get("/api/lotlist").await.0, 503); // 壊れた元は写しに採用しない
    assert!(env.state.lot_mirror.mirror_path().is_none());
}

#[tokio::test]
async fn stale_source_is_flagged() {
    let env = api_env(50);
    let src = env.root.join("src.sqlite3");
    sample_db(&src, 60);
    set_source(&env, src.to_str().unwrap()).await;
    env.get("/api/lotlist").await;
    assert_eq!(env.state.lot_mirror.source_info()["stale"], json!(false));
    env.state.lot_mirror.reconfigure(None, None, Some(0.000001));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(env.state.lot_mirror.source_info()["stale"], json!(true));
}

#[tokio::test]
async fn changing_the_source_switches_to_the_new_file() {
    let env = api_env(50);
    let (a, b) = (env.root.join("a.sqlite3"), env.root.join("b.sqlite3"));
    sample_db(&a, 40);
    sample_db(&b, 90);
    set_source(&env, a.to_str().unwrap()).await;
    let na = env.get("/api/lotlist").await.1["count"].as_i64().unwrap();
    set_source(&env, b.to_str().unwrap()).await;
    let nb = env.get("/api/lotlist").await.1["count"].as_i64().unwrap();
    assert!(nb > na, "{na} → {nb}");
}
