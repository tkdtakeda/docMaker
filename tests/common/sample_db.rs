//! 動作確認用の品質データ（SQLite）を作る。  cargo run --bin make_sample_db -- 出力先.sqlite3 [行数]
//! 本物の SIKADEF.sqlite3 に似せた「仕掛」「品質情報」の 2 表。乱数の種は固定（毎回同じ内容）。
//! 同名の列が 2 つある・日付の書き方が混ざる・空欄がある、など現実のデータの癖も入れてある。

use std::path::Path;

use chrono::{Duration, NaiveDate};
use rusqlite::{params, Connection};

const PRODUCTS: [(&str, &str); 8] = [
    ("ブラケットA", "BRK-1001"), ("シャフト φ12", "SHF-2012"), ("カバー（大）", "CVR-3300"), ("ギアハウジング", "GHS-4100"),
    ("フランジ 50A", "FLG-5050"), ("ピストンロッド", "PST-6120"), ("端子台 6P", "TRM-7006"), ("ベースプレート", "BPL-8800"),
];
const CUSTOMERS: [&str; 5] = ["東洋精機（株）", "北辰工業（株）", "三和電装（株）", "（有）明星製作所", "大和プレシジョン（株）"];
const PROCESSES: [&str; 7] = ["切削", "研削", "熱処理", "メッキ", "組立", "検査", "梱包"];
const STATES: [&str; 5] = ["仕掛中", "検査待ち", "保留", "完了", "出荷待ち"];
const PEOPLE: [&str; 6] = ["山田", "佐藤", "鈴木", "高橋", "田中", "伊藤"];

/// 種を固定した小さな乱数（外部の crate に頼らない）。
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self, p: f64) -> bool {
        ((self.next() >> 11) as f64 / (1u64 << 53) as f64) < p
    }
    fn pick<'a>(&mut self, v: &[&'a str]) -> &'a str {
        v[self.below(v.len())]
    }
}

/// 出力先に 2 表を作り直す。→ 「仕掛」の行数
pub fn build(path: &Path, n: usize, seed: u64) -> rusqlite::Result<usize> {
    let mut r = Rng(seed);
    let today = NaiveDate::from_ymd_opt(2026, 11, 5).expect("date");
    let mut con = Connection::open(path)?;
    con.execute_batch(
        "DROP TABLE IF EXISTS 仕掛; DROP TABLE IF EXISTS 品質情報;
         CREATE TABLE 仕掛 (ロット番号 TEXT, 品名 TEXT, 品番 TEXT, 顧客 TEXT, 工程 TEXT, 数量 INTEGER, 単位 TEXT, 製造日 TEXT, 納期 TEXT, 状態 TEXT, 担当者 TEXT, 検査結果 TEXT, 備考 TEXT);
         CREATE TABLE 品質情報 (ロット番号 TEXT, 項目 TEXT, 値 TEXT);",
    )?;
    type Row = (String, String, String, String, String, i64, String, String, String, String, String, String, String);
    let mut rows: Vec<Row> = Vec::new();
    for i in 1..=n {
        let (name, code) = PRODUCTS[r.below(PRODUCTS.len())];
        let made = today - Duration::days(r.below(400) as i64);
        let lot = format!("L{:02}{:05}", made.format("%y"), i);
        let fmt = ["%Y/%m/%d", "%Y/%m/%d", "%Y-%m-%d", "%y/%m/%d"][r.below(4)]; // 日付の書き方が混ざる
        let due = made + Duration::days(14 + r.below(31) as i64);
        let blank = |r: &mut Rng, v: &str| if r.chance(0.08) { String::new() } else { v.to_string() }; // 空欄がある
        let customer = r.pick(&CUSTOMERS).to_string();
        let process = r.pick(&PROCESSES).to_string();
        let qty = 50 * (1 + r.below(40)) as i64;
        let state = r.pick(&STATES).to_string();
        let person = r.pick(&PEOPLE);
        let person = blank(&mut r, person);
        let result = r.pick(&["合格", "合格", "合格", "条件付合格", "不合格"]);
        let result = blank(&mut r, result);
        let note = r.pick(&["", "", "", "特急", "再検査あり", "100%検査", "A_1 ロット"]).to_string();
        rows.push((lot, name.into(), code.into(), customer, process, qty, "個".into(), made.format(fmt).to_string(), due.format(fmt).to_string(), state, person, result, note));
        if r.chance(0.15) {
            // 一部のロットは複数行
            let mut again = rows.last().cloned().expect("row");
            again.4 = r.pick(&PROCESSES).to_string();
            rows.push(again);
        }
    }
    let tx = con.transaction()?;
    {
        let mut ins = tx.prepare("INSERT INTO 仕掛 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")?;
        for x in &rows {
            ins.execute(params![x.0, x.1, x.2, x.3, x.4, x.5, x.6, x.7, x.8, x.9, x.10, x.11, x.12])?;
        }
        let mut q = tx.prepare("INSERT INTO 品質情報 VALUES (?,?,?)")?;
        for x in rows.iter().take(50) {
            q.execute(params![x.0, "外観", "良"])?;
        }
    }
    tx.commit()?;
    Ok(rows.len())
}
