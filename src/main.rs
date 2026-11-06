//! 起動: `docmaker`（Start.bat から）。ブラウザで画面を開く。`--no-browser` で開かない、`--port=N` でポートを変える。

use docmaker::config::find_base_dir;
use docmaker::server::{me, router, AppState};
use docmaker::version::APP_VERSION;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version") {
        println!("docMaker v{APP_VERSION}");
        return;
    }
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return fail(&format!("起動できませんでした: {e}")),
    };
    if let Err(msg) = rt.block_on(run(&args)) {
        fail(&msg);
    }
}

fn fail(msg: &str) {
    eprintln!("\n  {msg}\n");
    std::process::exit(1);
}

async fn run(args: &[String]) -> Result<(), String> {
    let base = find_base_dir();
    if !base.join("web").join("index.html").is_file() {
        return Err(format!("画面のファイルが見つかりません（{}）。docmaker.exe は web フォルダと同じ場所に置いてください。", base.join("web").display()));
    }
    let state = AppState::new(&base, None);
    let srv = state.settings.server.clone();
    let port = args.iter().find_map(|a| a.strip_prefix("--port=")).map_or(Ok(srv.port), |p| p.parse::<u16>().map_err(|_| format!("--port の値が正しくありません: {p}")))?;
    let url = format!("http://{}:{port}/", srv.host);

    let listener = tokio::net::TcpListener::bind((srv.host.as_str(), port))
        .await
        .map_err(|e| format!("{}:{port} を使えません（{e}）。すでに docMaker が起動していませんか。そのときは {url} を開いてください。", srv.host))?;
    println!("{}", "=".repeat(52));
    println!("  docMaker  v{APP_VERSION}  帳票作成ツール");
    println!("{}", "=".repeat(52));
    println!("  画面: {url}");
    println!("  終了するには、この窓で Ctrl+C を押すか、窓を閉じてください。\n");
    if srv.open_browser && !args.iter().any(|a| a == "--no-browser") {
        let _ = webbrowser::open(&url);
    }

    let app = router(state.clone());
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| format!("サーバーが止まりました: {e}"))?;
    let (login, pc) = me();
    state.presence.leave(&login, &pc);
    Ok(())
}
