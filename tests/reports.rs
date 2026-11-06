//! 帳票（プリセット・ひな形）の保存 API と、選んだロットの全行 API のテスト。

mod common;

use axum::http::Method;
use common::{sample_db, settings, Env};
use docmaker::lot_list::{query, rows_of_lots, LotError, QueryOpts, MAX_LOTS};
use serde_json::{json, Value};

/// 帳票の置き場を、根の下の shared_reports（共有フォルダの代わり）にした環境。
fn store_env() -> Env {
    Env::build(|root| settings(|s| s.reports.dir = root.join("shared_reports").display().to_string()), |_| {})
}

#[tokio::test]
async fn put_get_list_delete() {
    let env = store_env();
    let rec = json!({"id": "rp_1", "name": "成績書", "items": [], "blocks": {"bands": []}});
    assert_eq!(env.json(Method::PUT, "/api/reports/reports/rp_1", &rec).await.0, 200);
    assert!(env.root.join("shared_reports/reports/rp_1.json").exists()); // 共有フォルダに置く
    assert_eq!(env.get("/api/reports/reports/rp_1").await.1["item"]["name"], json!("成績書"));
    let (_, list) = env.get("/api/reports/reports").await;
    assert_eq!(list["items"].as_array().unwrap().iter().map(|x| x["id"].clone()).collect::<Vec<_>>(), vec![json!("rp_1")]);
    let (_, del) = env.json(Method::POST, "/api/reports/reports/delete", &json!({"ids": ["rp_1", "nothing"]})).await;
    assert_eq!(del["deleted"], json!(1));
    assert_eq!(env.get("/api/reports/reports/rp_1").await.0, 404);
}

#[tokio::test]
async fn template_binary_roundtrip() {
    let env = store_env();
    // base64 は画面側で作った文字として、そのまま入って出る
    let b64 = "AAECAwQFBgcICQoLDA0ODw==".repeat(500);
    let rec = json!({"id": "tpl_1", "name": "ひな形", "buffer": {"__b64": b64}});
    env.json(Method::PUT, "/api/reports/templates/tpl_1", &rec).await;
    assert_eq!(env.get("/api/reports/templates/tpl_1").await.1["item"]["buffer"]["__b64"], rec["buffer"]["__b64"]);
}

#[tokio::test]
async fn rejects_bad_ids_stores_and_mismatch() {
    let env = store_env();
    let s = env.json(Method::PUT, "/api/reports/reports/..%2Fx", &json!({"id": "../x", "name": "x"})).await.0;
    assert!([400, 404, 405].contains(&s.as_u16()), "{s}"); // 外へは書かない
    assert_eq!(env.json(Method::PUT, "/api/reports/reports/a.b", &json!({"id": "a.b"})).await.0, 400);
    assert_eq!(env.json(Method::PUT, "/api/reports/reports/ok1", &json!({"id": "other"})).await.0, 400); // 中身と ID が違う
    assert_eq!(env.get("/api/reports/masters").await.0, 400); // 保存先にない種類
    assert_eq!(env.json(Method::POST, "/api/reports/reports/delete", &json!({"ids": "x"})).await.0, 400);
    assert_eq!(env.json(Method::POST, "/api/reports/reports/delete", &json!({"ids": ["../x"]})).await.0, 400);
    assert!(!env.root.join("x.json").exists());
}

#[tokio::test]
async fn too_large_is_refused() {
    let env = store_env();
    let big = format!(r#"{{"id":"big","buffer":{{"__b64":"{}"}}}}"#, "A".repeat(41 * 1024 * 1024));
    let (s, _, _) = env.send(Method::PUT, "/api/reports/templates/big", Some(big.into_bytes())).await;
    assert!([400, 413].contains(&s.as_u16()), "{s}");
    let mid = format!(r#"{{"id":"mid","buffer":{{"__b64":"{}"}}}}"#, "A".repeat(31 * 1024 * 1024));
    let (s, _, _) = env.send(Method::PUT, "/api/reports/templates/mid", Some(mid.into_bytes())).await;
    assert_eq!(s, 413); // 30MB を超える
}

#[tokio::test]
async fn unreadable_file_is_skipped_not_deleted() {
    let env = store_env();
    let d = env.root.join("shared_reports/reports");
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join("bad.json"), "{ broken").unwrap();
    assert_eq!(env.get("/api/reports/reports").await.1["items"], json!([]));
    assert!(d.join("bad.json").exists());
}

#[tokio::test]
async fn default_dir_is_local_data() {
    let env = Env::new(settings(|_| {}));
    env.json(Method::PUT, "/api/reports/reports/rp_9", &json!({"id": "rp_9"})).await;
    assert!(env.root.join("data/reports/reports/rp_9.json").exists());
}

// ---------------------------------------------------------------- ロットの全行
fn sample(rows: usize) -> (tempfile::TempDir, std::path::PathBuf) {
    let t = tempfile::tempdir().unwrap();
    let p = t.path().join("q.sqlite3");
    sample_db(&p, rows);
    (t, p)
}

#[test]
fn all_rows_of_the_lots() {
    let (_t, db) = sample(300);
    let g = query(&db, &QueryOpts { group: true, page_size: 400, ..Default::default() }).unwrap();
    let (rows, groups) = (g["rows"].as_array().unwrap(), g["groups"].as_array().unwrap());
    let multi: Vec<String> = rows
        .iter()
        .zip(groups)
        .filter(|(_, g)| g[0].as_i64() > Some(1))
        .map(|(r, _)| r["ロット番号"].as_str().unwrap().to_string())
        .take(2)
        .collect();
    assert_eq!(multi.len(), 2, "複数行のロットがサンプルにある");
    let ask = vec![multi[0].to_lowercase(), format!(" {} ", multi[1]), multi[0].clone()]; // 大小・空白・重なり
    let r = rows_of_lots(&db, &ask, "", "").unwrap();
    let expect: i64 = rows.iter().zip(groups).filter(|(r, g)| multi.contains(&r["ロット番号"].as_str().unwrap().to_string()) && g[1] == json!(1)).map(|(_, g)| g[0].as_i64().unwrap()).sum();
    assert_eq!(r["rows"].as_array().unwrap().len() as i64, expect);
    assert_eq!(r["lotColumn"], json!("ロット番号"));
}

#[test]
fn limits() {
    let (_t, db) = sample(50);
    let many: Vec<String> = (0..=MAX_LOTS).map(|i| format!("L{i}")).collect();
    assert!(matches!(rows_of_lots(&db, &many, "", ""), Err(LotError::Invalid(_))));
    assert_eq!(rows_of_lots(&db, &[], "", "").unwrap()["rows"], json!([]));
}

#[tokio::test]
async fn lots_api() {
    let (_t, db) = sample(120);
    let env = Env::new(settings(|s| {
        s.lot_list.source = db.display().to_string();
        s.lot_list.interval_sec = 10;
    }));
    let lot = query(&db, &QueryOpts { page_size: 1, ..Default::default() }).unwrap()["rows"][0]["ロット番号"].as_str().unwrap().to_string();
    let (s, j) = env.json(Method::POST, "/api/lotlist/lots", &json!({"lots": [lot]})).await;
    assert_eq!(s, 200, "{j}");
    assert!(j["rows"].as_array().unwrap().iter().all(|x| x["ロット番号"] == json!(lot)));
    assert_eq!(env.json(Method::POST, "/api/lotlist/lots", &json!({"lots": "x"})).await.0, 400);
    assert_eq!(env.json(Method::POST, "/api/lotlist/lots", &json!({"lots": [null]})).await.0, 400);
    let _: Value = j;
}
