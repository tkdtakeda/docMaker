/* サーバー版の確認（版・更新履歴・利用状況・古いサーバー）。
   使い方:  PYTHON=python node tools/check_server.js     （Flask が入った python を PYTHON に）
   一時フォルダへ本体を写してサーバーを起動し、実際のブラウザで確かめる。 */
const { chromium } = require("playwright");
const { spawn, execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const PY = process.env.PYTHON || "python3";
const PORT = 57841;
let failed = 0;
const ok = (c, m) => { console.log((c ? "  OK  " : "  NG  ") + m); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dm-"));
  for (const d of ["app", "web", "config"]) fs.cpSync(path.join(ROOT, d), path.join(tmp, d), { recursive: true, filter: (s) => !s.includes("__pycache__") });
  fs.copyFileSync(path.join(ROOT, "app_build.py"), path.join(tmp, "app_build.py"));
  fs.copyFileSync(path.join(ROOT, "run.py"), path.join(tmp, "run.py"));
  // 別の PC が新しい版を使っている記録（共有の置き場の代わり）
  const shared = path.join(tmp, "shared"); fs.mkdirSync(path.join(shared, "history"), { recursive: true });
  const now = new Date().toISOString().slice(0, 19);
  fs.writeFileSync(path.join(shared, "history", "PC-B@tanaka.json"), JSON.stringify({ key: "PC-B@tanaka", login: "tanaka", pc: "PC-B", version: "9.0.0", lastAt: now, sessions: 3, totalSec: 3600 }));
  fs.writeFileSync(path.join(tmp, "config", "settings.json"), JSON.stringify({ server: { host: "127.0.0.1", port: PORT, open_browser: false }, presence: { dir: shared } }));
  const srv = spawn(PY, ["run.py", "--no-browser"], { cwd: tmp, stdio: "ignore" });
  const browser = await chromium.launch();
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch (e) {} await sleep(250); }
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await ctx.addInitScript(() => { try { localStorage.setItem("dm.helpNever", "1"); } catch (e) {} });
    const p = await ctx.newPage();
    const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    await p.goto(`http://127.0.0.1:${PORT}/`);
    console.log("[版の札]");
    await p.waitForSelector("#ver", { timeout: 5000 });
    ok((await p.locator("#ver").innerText()).includes("v0.2.0"), "見出しに版の札が出る");
    await p.waitForSelector("#ver .tag--warn", { timeout: 8000 }).catch(() => {});
    ok((await p.locator("#ver").innerText()).includes("新しい版あり"), "ほかの PC が新しい版(9.0.0)を使っていると「新しい版あり」が出る（文字つき）");
    console.log("[更新履歴・利用状況]");
    await p.locator("#ver").click();
    await p.waitForSelector(".log");
    ok((await p.locator(".log").count()) >= 2, "更新履歴が開く");
    ok((await p.locator(".log .tag--ok").count()) === 1, "使用中の版に札が付く");
    await p.screenshot({ path: path.join(tmp, "log.png") });
    await p.locator('[data-tab="use"]').click();
    await p.waitForSelector(".help-table tbody tr");
    const rows = await p.locator(".help-table tbody tr").count();
    ok(rows === 2, `利用状況に 2 台（この PC とほかの PC）が出る（${rows}）`);
    const txt = await p.locator(".vm__body").innerText();
    ok(txt.includes("PC-B") && txt.includes("v9.0.0"), "ほかの PC の版が見える");
    ok(txt.includes("古い版") && txt.includes("使用中"), "状態が文字で出る（古い版／使用中）");
    ok(txt.includes("最新版：v9.0.0"), "最新版が数で比べられている");
    await p.screenshot({ path: path.join(tmp, "use.png") });
    await p.keyboard.press("Escape");
    console.log("[古いサーバー]");
    ok((await p.locator("#stale-bar").count()) === 0, "入れ替え前は警告が出ない");
    fs.appendFileSync(path.join(tmp, "web", "js", "core.js"), "\n// 入れ替わった\n");
    await p.evaluate(() => fetch("api/instance"));   // 控え(2秒)後に再確認させる
    await sleep(2300);
    const st = await (await fetch(`http://127.0.0.1:${PORT}/api/instance`)).json();
    ok(st.stale === true, "プログラムが入れ替わると /api/instance が stale を返す");
    await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await p.waitForSelector("#stale-bar", { timeout: 5000 }).catch(() => {});
    ok((await p.locator("#stale-bar").count()) === 1 && (await p.locator("#stale-bar").innerText()).includes("開いてください"), "画面の上に「開き直してください」が出る");
    await p.screenshot({ path: path.join(tmp, "stale.png") });
    ok(errs.length === 0, "コンソールエラーなし" + (errs.length ? " : " + errs.join(" / ") : ""));
    console.log("画像:", tmp);
  } finally { await browser.close(); srv.kill(); }
  console.log(failed ? `\n${failed} 件 NG` : "\nすべて OK");
  process.exit(failed ? 1 : 0);
})();
