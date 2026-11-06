/* 確認スクリプト（本体とは別。基本設計 §13）
   使い方:  node tools/check.js          （playwright が入っている環境で）
   index.html を実際のブラウザで開き、主要な作業経路と、これまでの機能が壊れていないかを確かめる。 */
const { chromium } = require("playwright");
const path = require("path");
const URL = "file://" + path.resolve(__dirname, "..", "web", "index.html");
let failed = 0;
const ok = (cond, msg) => { console.log((cond ? "  OK  " : "  NG  ") + msg); if (!cond) failed++; };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("dm.helpNever", "1"); } catch (e) {} });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await p.goto(URL);

  console.log("[初期状態]");
  ok(await p.locator(".state strong").first().innerText() === "まだデータを読み込んでいません", "空の状態に案内が出る");
  ok((await p.locator("#cta").innerText()).includes("① データを読み込む"), "主操作が「① データを読み込む」");

  console.log("[サンプル読み込み → 選択 → 帳票]");
  await p.locator("[data-load-sample]").click();
  ok((await p.locator("tbody tr[data-id]").count()) === 60, "標準サンプル 60 行");
  ok(await p.locator("#cta").isDisabled(), "ロット未選択では主操作が押せない");
  ok((await p.locator("#cta").getAttribute("title")).length > 0, "押せない理由が出る");
  const box = await p.locator("#cta").boundingBox();
  ok(box && box.x + box.width <= 1366, "1366px で主操作ボタンが画面内に収まる");
  await p.locator("tbody tr[data-id]").nth(0).click();
  await p.locator("tbody tr[data-id]").nth(2).click({ modifiers: ["Control"] });
  ok((await p.locator("tbody tr.is-selected").count()) === 2, "Ctrl＋クリックで 2 件選択");
  ok(!(await p.locator("#tray").evaluate((e) => e.classList.contains("hidden"))), "選択すると下部トレーが出る");
  ok((await p.locator("#cta").innerText()).includes("② 帳票を選ぶ"), "主操作が「② 帳票を選ぶ」");
  await p.locator(".pill").first().click();
  ok((await p.locator("#cta").innerText()).includes("③ 2 件を確認して印刷"), "主操作が「③ 2 件を確認して印刷」（件数は自動）");

  console.log("[検索・フィルター]");
  await p.locator("#search").fill("ｓｈｆ");   // 全角英字 → 半角・小文字を同一視（品番 SHF-2012）
  await p.waitForTimeout(300);
  const n1 = await p.locator("tbody tr[data-id]").count();
  ok(n1 > 0 && n1 < 60, `全角・小文字でも品番を検索できる（${n1} 件）`);
  await p.locator("#search").fill("しゃふと");   // ひらがな → カタカナを同一視（シャフト）
  await p.waitForTimeout(300);
  const n1b = await p.locator("tbody tr[data-id]").count();
  ok(n1b > 0 && n1b < 60, `ひらがなでも「シャフト」を検索できる（${n1b} 件）`);
  await p.locator("#search").fill("");
  await p.waitForTimeout(300);
  await p.locator('.rail-btn[data-id="filter"]').click();
  await p.locator("[data-add]").click();
  await p.locator('.filter-row select[data-k="column"]').selectOption("顧客");
  await p.locator('.filter-row input[data-k="value"]').fill("東洋");
  await p.waitForTimeout(400);
  const n2 = await p.locator("tbody tr[data-id]").count();
  ok(n2 > 0 && n2 < 60, `フィルター（顧客に「東洋」）で絞れる（${n2} 件）`);
  ok((await p.locator("#chips .tag").count()) >= 1, "適用中の条件が札で表に近く出る");
  await p.locator('#chips button[data-rm="0"]').click();
  await p.waitForTimeout(200);
  ok((await p.locator("tbody tr[data-id]").count()) === 60, "札の × で条件が外れる");
  await p.locator('.rail-btn[data-id="filter"]').click();

  console.log("[0 件の状態]");
  await p.locator("#search").fill("zzzzzzzz");
  await p.waitForTimeout(300);
  ok((await p.locator(".state strong").first().innerText()).includes("0 件"), "0 件の案内が出る");
  await p.locator("[data-reset-all]").click();
  await p.waitForTimeout(200);

  console.log("[不足の検出（必須項目の欠け）]");
  await p.locator('.rail-btn[data-id="data"]').click();
  await p.locator('[data-sample="missing"]').click();
  await p.locator('.rail-btn[data-id="data"]').click();
  await p.locator("#search").fill("X26");
  await p.waitForTimeout(300);
  await p.locator('.grid thead th[data-col="検査結果"]').click();   // 昇順（空欄は下）
  await p.locator('.grid thead th[data-col="検査結果"]').click();   // 降順
  await p.waitForTimeout(150);
  const missCells = await p.locator("td.is-missing").count();
  ok(missCells > 0, `必須列の未入力が赤で出る（${missCells} セル）`);
  await p.evaluate(() => { const r = DM.store.rows.filter((x) => x._sample === "missing" && DM.isEmpty(x["検査結果"])); DM.store.setSelected(r.slice(0, 2).map((x) => x._id)); DM.store.setForm("ship-insp"); });
  ok((await p.locator(".pill[aria-checked=true] .tag--warn").count()) === 1, "トレーに「不足 n」が文字で出る");
  await p.locator("#cta").click();
  ok(await p.locator(".preview").count() === 1, "確認画面（モーダル）が開く");
  ok((await p.locator(".preview .tag--warn").count()) >= 1, "確認画面に不足の要約が出る");
  ok((await p.locator(".preview .sheet__missing").count()) >= 2, "帳票に「未入力」の文字が出る");
  ok((await p.locator(".preview [data-print]").innerText()).includes("不足を承知で"), "印刷ボタンが不足を承知で、と言う");
  await p.keyboard.press("Escape");
  ok(await p.locator(".preview").count() === 0, "Esc で閉じる");

  console.log("[印刷（1 ロット 1 ページ）]");
  await p.evaluate(() => { DM.store.setSelected(DM.store.rows.filter((x) => x._sample === "standard").slice(0, 3).map((x) => x._id)); });
  await p.evaluate(() => { const f = DM.forms.get("ship-insp"), rows = DM.store.selectedRows(); const r = document.createElement("div"); r.id = "print-root"; document.body.appendChild(r); r.innerHTML = rows.map((x) => DM.forms.renderSheet(f, x)).join(""); });
  const pdf = await p.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  ok(pages === 3, `3 ロットが 3 ページで出る（${pages} ページ）`);
  await p.evaluate(() => document.getElementById("print-root").remove());

  console.log("[サンプルだけ消す]");
  await p.locator('.rail-btn[data-id="data"]').click();
  await p.evaluate(() => { const s = DM.store; s.rows.push({ _id: s.nextId(), _sample: false, "ロット番号": "REAL-1", "品名": "実データ" }); DM.bus.emit("data"); });
  await p.locator("[data-clear-sample]").click();
  const left = await p.evaluate(() => DM.store.rows.map((r) => r["ロット番号"]));
  ok(left.length === 1 && left[0] === "REAL-1", "サンプルだけが消え、実データは残る");
  await p.locator(".toast button").click();
  ok((await p.evaluate(() => DM.store.rows.length)) > 1, "「元に戻す」で復元できる");

  console.log("[大量データ 5,000 行]");
  await p.locator('[data-sample="large"]').click();
  const t0 = Date.now();
  await p.locator("#search").fill("B0100");
  await p.waitForSelector("tbody tr[data-id]");
  const ms = Date.now() - t0;
  ok(ms < 1500, `5,000 行の検索が速い（${ms} ms）`);
  await p.locator("#search").fill("");

  console.log("[表示密度]");
  for (const d of ["compact", "comfortable", "standard"]) {
    await p.evaluate((x) => DM.density.set(x), d);
    await p.waitForTimeout(80);
  }
  ok((await p.evaluate(() => document.documentElement.dataset.density)) === "standard", "密度の切替が動く");

  console.log("[列の表示・並べ替え]");
  const panel = async (id, open) => { const b = p.locator(`.rail-btn[data-id="${id}"]`); if (((await b.getAttribute("aria-pressed")) === "true") !== open) await b.click(); };
  await panel("data", true);
  await p.locator('[data-sample="standard"]').click();
  await panel("view", true);
  const heads = async () => p.locator(".grid thead th[data-col]").evaluateAll((ths) => ths.map((t) => t.dataset.col));
  ok((await heads()).length === 13, "初めは 13 列すべて表示");
  await p.locator('.collist__row[data-col="単位"] [data-show]').uncheck();
  ok(!(await heads()).includes("単位"), "チェックを外すと列が隠れる");
  ok((await p.locator(".pane-part").first().innerText()).includes("隠した列 1"), "隠した列の数が見出しに出る");
  await p.locator('.collist__row[data-col="顧客"] [data-move="-1"]').click();
  await p.locator('.collist__row[data-col="顧客"] [data-move="-1"]').click();
  ok((await heads()).slice(0, 3).join(",") === "ロット番号,顧客,品名", "▲ で列の並びが変わる（ロット番号,顧客,品名）");
  await p.locator("[data-colq]").fill("ﾛｯﾄ");
  ok((await p.locator(".collist__row").count()) === 1, "列を、半角カナでも探せる（ﾛｯﾄ → ロット番号）");
  await p.locator("[data-colq]").fill("");
  await panel("view", false);

  console.log("[設定の自動保存（開き直すと当てはまる）]");
  await panel("filter", true);
  await p.locator("[data-add]").click();
  await p.locator('.filter-row select[data-k="column"]').selectOption("顧客");
  await p.locator('.filter-row input[data-k="value"]').fill("東洋");
  await p.waitForTimeout(400);
  await panel("filter", false);
  await p.locator('.grid thead th[data-col="数量"]').click();
  await p.waitForTimeout(700);                                          // 自動保存（0.4 秒後）
  await p.reload();
  await p.locator("[data-load-sample]").click();
  await p.waitForTimeout(300);
  ok((await p.locator("#chips").innerText()).includes("東洋"), "開き直して同じ表を読むと、条件が当てはまる");
  ok(!(await heads()).includes("単位") && (await heads())[1] === "顧客", "隠した列・列の並びも当てはまる");
  ok((await p.locator(".toast").allInnerTexts()).some((t) => t.includes("前回の設定を当てはめました")), "当てはめたことを通知で知らせる");
  await p.locator(".toast button").last().click();
  await p.waitForTimeout(200);
  ok((await heads()).includes("単位") && (await p.locator("#chips .tag").count()) === 0, "通知の「元に戻す」で初期の表示に戻る");

  console.log("[作業セット]");
  await panel("work", true);
  await p.locator("[data-setname]").fill("東洋だけ");
  await p.locator("[data-setname]").press("Enter");                     // 空の条件で保存されないよう、先に条件を作る前の状態を保存しておく
  await panel("work", false);
  await panel("filter", true);
  await p.locator("[data-add]").click();
  await p.locator('.filter-row select[data-k="column"]').selectOption("状態");
  await p.locator('.filter-row input[data-k="value"]').fill("完了");
  await p.waitForTimeout(400);
  await panel("filter", false);
  await panel("work", true);
  await p.locator("[data-setname]").fill("完了だけ");
  await p.locator("[data-save]").click();
  ok((await p.locator(".setlist__row").count()) === 2, "名前を付けて 2 件保存できる");
  ok((await p.locator("[data-setname]").inputValue()) === "", "保存したら名前の欄が空になる");
  ok((await p.locator(".setlist__row").first().innerText()).includes("条件 1"), "一覧に中身の要約が出る");
  await p.locator('.setlist__row:has-text("東洋だけ") [data-apply]').click();
  await p.waitForTimeout(200);
  ok((await p.locator("#chips .tag").count()) === 0, "「当てはめる」で、その作業セットの設定に切り替わる");
  await p.locator('.setlist__row:has-text("完了だけ") [data-apply]').click();
  await p.waitForTimeout(200);
  ok((await p.locator("#chips").innerText()).includes("完了"), "別の作業セットに切り替えられる");
  const [dlSet] = await Promise.all([p.waitForEvent("download"), p.locator("[data-export]").click()]);
  const exported = await (await dlSet.createReadStream()).toArray().then((a) => Buffer.concat(a).toString("utf8"));
  ok(JSON.parse(exported).sets.length === 2, "JSON に書き出せる（2 件）");
  await p.locator('.setlist__row:has-text("完了だけ") summary').click();
  await p.locator('.setlist__row:has-text("完了だけ") [data-remove]').click();
  ok((await p.locator(".setlist__row").count()) === 1, "⋮ の中から削除できる");
  await p.locator("[data-file]").setInputFiles({ name: "sets.json", mimeType: "application/json", buffer: Buffer.from(exported) });
  await p.waitForTimeout(300);
  const names = await p.locator(".setlist__main b").allInnerTexts();
  ok(names.length === 3 && names.includes("東洋だけ (2)"), "読み込むと、同じ名前は「(2)」を付けて足す（上書きしない）: " + names.join("／"));
  await p.locator("[data-file]").setInputFiles({ name: "x.json", mimeType: "application/json", buffer: Buffer.from('{"a":1}') });
  await p.waitForTimeout(200);
  ok((await p.locator(".toast").last().innerText()).includes("作業セットの書き出しファイルではありません"), "違うファイルは理由を出して読み込まない");
  await p.locator("[data-setname]").fill("");
  await p.locator("[data-save]").click();
  ok((await p.locator(".toast").last().innerText()).includes("名前を入れてください"), "名前が空なら保存せず理由を出す");
  await panel("work", false);

  ok(errors.length === 0, "コンソールエラーなし" + (errors.length ? " : " + errors.join(" / ") : ""));
  await browser.close();
  console.log(failed ? `\n${failed} 件 NG` : "\nすべて OK");
  process.exit(failed ? 1 : 0);
})();
