//! 帳票（プリセット）とひな形（Excel）の保存。CDB では各 PC のブラウザ内（IndexedDB）だったものを、共有フォルダに置く。
//!
//! 置き場: 設定 reports.dir（共有フォルダ）の下。空なら data/reports（この PC の中だけ）。
//!   reports/<id>.json    … 帳票プリセット（CDB の preset そのまま）
//!   templates/<id>.json  … ひな形（Excel は base64 で { "__b64": … } の形。画面の adapter.js が変換する）
//! 1 つの帳票は 1 つのファイル。書くときは一時ファイル → 置き換え（読む側が書きかけを見ない）。
//! 同じ帳票を 2 台で同時に直したときは、後から保存したほうが残る（いまは衝突を知らせない）。
//! 読めないファイルは一覧から外すが、消さない。

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::fsio::{retrying, write_json_atomic};

pub const STORES: [&str; 2] = ["reports", "templates"];
/// ひな形 15MB の base64 が入る大きさ
pub const MAX_BYTES: usize = 30 * 1024 * 1024;

#[derive(Debug)]
pub enum StoreError {
    /// 呼び出しの誤り（400）
    Invalid(String),
    /// 保存先の読み書きに失敗（503）
    Io(std::io::Error),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Invalid(s) => f.write_str(s),
            StoreError::Io(e) => e.fmt(f),
        }
    }
}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e)
    }
}

/// 英数字・_・- の 80 文字まで。
pub fn valid_id(id: &str) -> bool {
    (1..=80).contains(&id.chars().count()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub struct ReportStore {
    pub root: PathBuf,
}

impl ReportStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn dir(&self, store: &str) -> Result<PathBuf, StoreError> {
        if !STORES.contains(&store) {
            return Err(StoreError::Invalid(format!("「{store}」は保存先にありません")));
        }
        Ok(self.root.join(store))
    }

    fn path(&self, store: &str, id: &str) -> Result<PathBuf, StoreError> {
        if !valid_id(id) {
            return Err(StoreError::Invalid("帳票の ID が正しくありません（英数字・_・- の 80 文字まで）".into()));
        }
        Ok(self.dir(store)?.join(format!("{id}.json")))
    }

    /// 一覧。読めないものは出さない（消さない）。
    pub fn list(&self, store: &str) -> Result<Vec<Value>, StoreError> {
        let d = self.dir(store)?;
        let Ok(rd) = std::fs::read_dir(&d) else { return Ok(Vec::new()) };
        let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
        files.sort();
        Ok(files
            .iter()
            .filter_map(|p| {
                let rec: Value = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
                (rec.get("id").and_then(Value::as_str) == p.file_stem().and_then(|s| s.to_str())).then_some(rec)
            })
            .collect())
    }

    pub fn get(&self, store: &str, id: &str) -> Result<Option<Value>, StoreError> {
        match std::fs::read_to_string(self.path(store, id)?) {
            Ok(t) => Ok(Some(serde_json::from_str(&t).map_err(std::io::Error::other)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn put(&self, store: &str, id: &str, rec: &Value, raw_size: usize) -> Result<(), StoreError> {
        let p = self.path(store, id)?;
        if !rec.is_object() || rec.get("id").and_then(Value::as_str) != Some(id) {
            return Err(StoreError::Invalid("帳票の中身と ID が合いません".into()));
        }
        if raw_size > MAX_BYTES {
            return Err(StoreError::Invalid(format!(
                "大きすぎます（{}MB まで）。ひな形の不要なシートや画像を消してください",
                MAX_BYTES / 1024 / 1024
            )));
        }
        write_json_atomic(&p, rec, false, 2.0)?;
        Ok(())
    }

    /// 消した数を返す（無かったものは数えない）。
    pub fn delete(&self, store: &str, ids: &[Value]) -> Result<usize, StoreError> {
        let mut n = 0;
        for id in ids {
            let p = self.path(store, id.as_str().unwrap_or(""))?;
            match retrying(|| std::fs::remove_file(&p), 1.0) {
                Ok(()) => n += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(n)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}
