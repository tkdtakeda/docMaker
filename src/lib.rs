//! docMaker のサーバー。品質データ（SQLite）のロットを引き、帳票の保存と版・利用状況を受け持つ。
//! 画面（web/）は静的ファイルとして配る。

pub mod build_info;
pub mod config;
pub mod db_mirror;
pub mod fsio;
pub mod lot_list;
pub mod presence;
pub mod report_store;
pub mod server;
pub mod sqlite_ro;
pub mod version;
