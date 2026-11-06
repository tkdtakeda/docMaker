//! 版の記録の道具。  cargo run --bin release -- --release | --amend | --digest
//!
//! 版を上げて更新履歴を足してから `--release` で、配る物の中身の要約を src/version.rs に書く。
//! まだ配っていない版を直しただけなら `--amend`（版はそのままで要約だけ書き直す）。`--digest` は要約を表示するだけ。

use docmaker::build_info::{fingerprint, record_release, release_digest, release_files};
use docmaker::config::find_base_dir;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let base = find_base_dir();
    if args.iter().any(|a| a == "--release" || a == "--amend") {
        match record_release(&base, args.iter().any(|a| a == "--amend")) {
            Ok(msg) => println!("{msg}"),
            Err(msg) => {
                eprintln!("{msg}");
                std::process::exit(1);
            }
        }
    } else {
        println!("指紋 {}・配る物の要約 {}（{} ファイル）", fingerprint(&base), release_digest(&base), release_files(&base).len());
    }
}
