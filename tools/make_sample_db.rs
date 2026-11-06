//! 動作確認用の品質データ（SQLite）を作る。  cargo run --bin make_sample_db -- 出力先.sqlite3 [行数]
//! 作り方は tests/common/sample_db.rs（テストと同じ物を使う）。

#[path = "../tests/common/sample_db.rs"]
mod sample_db;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let out = args.first().map_or("sample_quality.sqlite3", String::as_str);
    let n = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(3000);
    match sample_db::build(std::path::Path::new(out), n, 7) {
        Ok(rows) => println!("{out}: {rows} 行"),
        Err(e) => {
            eprintln!("作れませんでした: {e}");
            std::process::exit(1);
        }
    }
}
