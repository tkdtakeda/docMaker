//! このアプリのプログラムの指紋と、配る物の中身の要約（WaveLog app_build.py と同じ作り）。
//!
//! 古いサーバーが残っていると、サーバーが覚えている古い画面（HTML）に、ディスクの新しい JS が読み込まれて画面が止まる。そこで:
//!   - サーバーは起動したときの指紋を覚え、/api/instance で「自分の指紋」と「いまのディスクと違うか（stale）」を答える
//!   - 画面は stale を見て、開き直すよう伝える。画面の JS・CSS の URL には指紋を付ける（古い JS を使い回さない）
//!
//! 指紋 = 版（version.rs）＋ web/ の画面のファイル（.html .js .css .json）の名前・大きさ・更新時刻＋この実行ファイルの大きさ・更新時刻。
//!
//!
//! もう1つ、配る物の中身の要約（release_digest）で版を管理する（版を上げずに配るのを防ぐ）:
//!   - version.rs の RELEASE_VERSION / RELEASE_DIGEST に「配った版と、そのときの中身の要約」を書いておく
//!   - tests/version.rs が、いまの中身と記録を比べる。版を上げずにプログラムを変えると失敗して、直し方を言う
//!   - 記録は手で書かず、版を上げて更新履歴を足してから `cargo run --bin release -- --release` で書く。
//!     まだ配っていない版を直しただけなら `--amend`（版はそのままで要約だけ書き直す）

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::version::{self, version_key};

/// 指紋に入れる画面のファイルの種類。
const FP_EXTS: [&str; 4] = ["html", "js", "css", "json"];
const FP_SKIP_DIRS: [&str; 2] = ["vendor", "layouts"];
/// 改行を LF にそろえて要約するファイルの種類。
const TEXT_EXTS: [&str; 11] = ["rs", "toml", "lock", "html", "js", "css", "json", "bat", "txt", "svg", "cmd"];
/// 配る物: 本体のソース（src/）・画面（web/、vendor も）・Cargo の定義と固定・起動の係・設定の初期値。
/// 説明（.md）・テスト・docs・tools は含めない。version.rs 自身も含めない（記録を書くと要約が変わるため）。
const RELEASE_SKIP: [&str; 1] = ["src/version.rs"];
const VERSION_FILE: &str = "src/version.rs";

fn walk(dir: &Path, skip_dirs: &[&str], out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if !p.file_name().and_then(|n| n.to_str()).is_some_and(|n| skip_dirs.contains(&n)) {
                walk(&p, skip_dirs, out);
            }
        } else {
            out.push(p);
        }
    }
}

fn rel(base: &Path, p: &Path) -> String {
    p.strip_prefix(base).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

fn mtime_ns(m: &std::fs::Metadata) -> u128 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos())
}

/// 版＋画面のファイルと実行ファイルの名前・大きさ・更新時刻の要約。ファイルが1つでも変われば変わる。
pub fn fingerprint(base: &Path) -> String {
    let mut h = Sha1::new();
    h.update(version::APP_VERSION.as_bytes());
    let mut files = Vec::new();
    walk(&base.join("web"), &FP_SKIP_DIRS, &mut files);
    let mut items: Vec<String> = files
        .iter()
        .filter(|p| p.extension().and_then(|x| x.to_str()).is_some_and(|x| FP_EXTS.contains(&x)))
        .filter_map(|p| std::fs::metadata(p).ok().map(|m| format!("{}|{}|{}", rel(base, p), m.len(), mtime_ns(&m))))
        .collect();
    // サーバー自身が入れ替わったかも見る（Rust では本体が実行ファイル）
    if let Some(m) = std::env::current_exe().ok().and_then(|e| std::fs::metadata(e).ok()) {
        items.push(format!("exe|{}|{}", m.len(), mtime_ns(&m)));
    }
    items.sort();
    for it in &items {
        h.update(it.as_bytes());
    }
    format!("{}-{}", version::APP_VERSION, &hex::encode(h.finalize())[..12])
}

/// 配る物の一覧（相対パス → 実体）。
pub fn release_files(base: &Path) -> BTreeMap<String, PathBuf> {
    let mut all = Vec::new();
    for d in ["src", "web", "config"] {
        walk(&base.join(d), &["target"], &mut all);
    }
    for f in ["Cargo.toml", "Cargo.lock"] {
        all.push(base.join(f));
    }
    if let Ok(rd) = std::fs::read_dir(base) {
        all.extend(rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "bat")));
    }
    all.into_iter()
        .filter(|p| p.is_file())
        .map(|p| (rel(base, &p), p))
        .filter(|(r, p)| {
            let in_config = r.starts_with("config/") && r.matches('/').count() == 1 && r.ends_with(".json");
            let wanted = r.starts_with("src/") || r.starts_with("web/") || in_config || !r.contains('/');
            wanted && !RELEASE_SKIP.contains(&r.as_str()) && p.extension().is_none_or(|x| x != "md")
        })
        .collect()
}

/// 配る物の中身の要約（16 桁）。改行は LF にそろえる（Windows で取り出して CRLF になっても同じ要約）。
pub fn release_digest(base: &Path) -> String {
    let mut h = Sha256::new();
    for (r, p) in release_files(base) {
        let mut data = std::fs::read(&p).unwrap_or_default();
        if p.extension().and_then(|x| x.to_str()).is_some_and(|x| TEXT_EXTS.contains(&x)) {
            data = normalize_newlines(&data);
        }
        h.update(r.as_bytes());
        h.update([0]);
        h.update(&data);
        h.update([0]);
    }
    hex::encode(h.finalize())[..16].to_string()
}

fn normalize_newlines(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        if data[i] == b'\r' && data.get(i + 1) == Some(&b'\n') {
            i += 1;
            continue;
        }
        out.push(data[i]);
        i += 1;
    }
    out
}

/// version.rs の中の `pub const NAME: &str = "…";` の値を読む。
fn read_const(text: &str, name: &str) -> Option<String> {
    let head = format!("pub const {name}: &str = \"");
    let start = text.find(&head)? + head.len();
    Some(text[start..start + text[start..].find('"')?].to_string())
}

fn write_const(text: &str, name: &str, value: &str) -> Option<String> {
    let head = format!("pub const {name}: &str = \"");
    let start = text.find(&head)? + head.len();
    let end = start + text[start..].find('"')?;
    Some(format!("{}{value}{}", &text[..start], &text[end..]))
}

/// 記録（RELEASE_*）を書く。版を上げずに中身だけ変えた記録は作らない（上げ忘れを止めるための仕組みなので）。
/// 成功したら画面に出す文、断るときは理由（Err）。base の `src/version.rs` を読み書きする。
pub fn record_release(base: &Path, amend: bool) -> Result<String, String> {
    let path = base.join(VERSION_FILE);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{} を読めません: {e}", path.display()))?;
    let digest = release_digest(base);
    let cur = read_const(&text, "APP_VERSION").ok_or("version.rs に APP_VERSION が見つかりません。")?;
    let rel_version = read_const(&text, "RELEASE_VERSION").ok_or("version.rs に RELEASE_VERSION が見つかりません。")?;
    let rel_digest = read_const(&text, "RELEASE_DIGEST").ok_or("version.rs に RELEASE_DIGEST が見つかりません。")?;
    let head = text.find("pub const CHANGELOG").and_then(|i| text[i..].find("version: \"").map(|j| i + j + "version: \"".len()));
    let head_version = head.and_then(|s| text[s..].find('"').map(|e| &text[s..s + e]));
    if head_version != Some(cur.as_str()) {
        return Err(format!("更新履歴（CHANGELOG）の先頭が版 {cur} ではありません。先頭に {cur} の1件を足してください。"));
    }
    if rel_version == cur && rel_digest == digest {
        return Ok(format!("記録済みです（{cur}・{digest}）。"));
    }
    if rel_version == cur && !amend {
        return Err(format!(
            "版 {cur} は記録済みで、そのあとプログラムが変わっています。版を上げて（src/version.rs の APP_VERSION と CHANGELOG の先頭、Cargo.toml の version）からもう一度。まだ配っていない {cur} を直しただけなら --amend。"
        ));
    }
    if !rel_version.is_empty() && version_key(&cur) < version_key(&rel_version) {
        return Err(format!("版 {cur} が、記録済みの {rel_version} より古くなっています。"));
    }
    let new = write_const(&text, "RELEASE_VERSION", &cur)
        .and_then(|t| write_const(&t, "RELEASE_DIGEST", &digest))
        .ok_or("version.rs に記録の行が見つかりません。")?;
    std::fs::write(&path, new).map_err(|e| format!("{} に書けません: {e}", path.display()))?;
    Ok(format!("記録しました: {cur}・{digest}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn const_roundtrip() {
        let t = "pub const A: &str = \"1\";\npub const B: &str = \"\";\n";
        assert_eq!(read_const(t, "A").as_deref(), Some("1"));
        assert_eq!(write_const(t, "B", "xyz").as_deref(), Some("pub const A: &str = \"1\";\npub const B: &str = \"xyz\";\n"));
    }

    #[test]
    fn crlf_is_folded() {
        assert_eq!(normalize_newlines(b"a\r\nb\nc\r"), b"a\nb\nc\r".to_vec());
    }
}
