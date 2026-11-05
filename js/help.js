/* ── help: 取扱説明書（モーダル。基本設計 §12）────────────────
   章は登録簿。機能を足したら章を足す（一覧もここから作る）。
   最初に「3 分で使う」を出し、前回見ていた章を覚える。自動表示は切り替えられる。 */
(function () {
  "use strict";
  const DM = window.DM;
  DM.help = DM.createRegistry();
  const K = (t) => `<kbd>${t}</kbd>`;

  DM.help.register({ id: "quick", title: "3 分で使う", icon: "fa-bolt", html: `
    <ol class="help-steps">
      <li><b>① ロットを選ぶ</b><br>上の検索欄に、ロット番号・品名・顧客などを入れます（どの項目でも探せます）。表の行をクリックするか、左端のチェックで選びます。複数選ぶときは ${K("Ctrl")}＋クリック、範囲は ${K("Shift")}＋クリックです。</li>
      <li><b>② 帳票を選ぶ</b><br>ロットを選ぶと下に帳票の一覧が出ます。選ぶと、その帳票で必須の項目が表に印（＊）で出て、DB に値がない欄は赤く「未入力」と出ます。</li>
      <li><b>③ 確認して印刷</b><br>右上の青いボタン（いつも同じ位置）を押すと、1 ロット 1 枚で転記結果が並びます。不足があるロットは左の一覧に ⚠ が出ます。内容を確かめて「印刷」を押します。</li>
    </ol>
    <p class="note"><i class="fa-solid fa-circle-info"></i> 右上のボタンは、状態に応じて「① ロットを選ぶ → ② 帳票を選ぶ → ③ n 件を確認して印刷」と変わります。押せないときは、理由がボタンの横に出ます。</p>` });
  DM.help.register({ id: "search", title: "検索と絞り込み", icon: "fa-filter", html: `
    <p>検索欄は全項目が対象です。全角・半角、大文字・小文字、ひらがな・カタカナの違いは同じとみなします。</p>
    <p>左の「条件」で、項目ごとの条件を足せます（すべてに当てはまる行だけを表示）。「7日以内」のように日付の絞り込みもできます。適用中の条件は表の上に札で出て、× で外せます（外すと「元に戻す」が出ます）。</p>
    <p>見出しのクリックで並べ替え（昇順→降順→解除）、${K("Shift")}＋クリックで複数の項目を重ねられます。列の境目のドラッグで幅を変え、ダブルクリックで初期幅に戻ります。</p>` });
  DM.help.register({ id: "keys", title: "キーボード操作", icon: "fa-keyboard", html: `
    <table class="help-table"><tr><th>操作</th><th>キー</th></tr>
    <tr><td>行の移動</td><td>${K("↑")} ${K("↓")}（${K("Shift")}＋で範囲選択）</td></tr>
    <tr><td>行の選択・解除</td><td>${K("Space")}</td></tr>
    <tr><td>確認画面を開く（帳票を選択済み）</td><td>${K("Enter")}</td></tr>
    <tr><td>検索を消す</td><td>${K("Esc")}</td></tr>
    <tr><td>入力欄で次へ／前へ</td><td>${K("Enter")} ／ ${K("Shift")}＋${K("Enter")}（変換中は移りません）</td></tr>
    <tr><td>確認画面を閉じる</td><td>${K("Esc")}</td></tr></table>` });
  DM.help.register({ id: "sample", title: "サンプルデータ", icon: "fa-flask", html: `
    <p>左の「データ」から、目的別のサンプルを読み込めます（毎回同じ内容です）。「必須項目の欠け」を読み込むと、不足の表示を確かめられます。</p>
    <p>「サンプルだけを消す」で、サンプルの行だけが消えます。あとから読み込む実データは消えません。</p>` });
  DM.help.register({ id: "print", title: "印刷のコツ", icon: "fa-print", html: `
    <p>印刷画面で、用紙は <b>A4・縦</b>、余白は <b>なし（または最小）</b>、倍率は <b>100%</b> にしてください。</p>
    <p>画面で赤く出ている不足の欄は、印刷では色が付きません（文字「未入力」は残ります）。</p>` });

  let modal = null;
  DM.openHelp = function (id) {
    if (modal) modal.remove();
    const chapters = DM.help.list(), last = id || DM.safeStorage.get("dm.helpChapter", "quick");
    const back = document.createElement("div"); back.className = "modal-back";
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="取扱説明書" style="width:min(860px,96vw);height:min(560px,90dvh)">
      <div class="modal__head"><i class="fa-solid fa-circle-question"></i>取扱説明書<span class="topbar__spacer"></span>
        <div class="searchbox" style="width:220px"><i class="fa-solid fa-magnifying-glass"></i><input class="input" type="search" placeholder="言葉で章を探す" data-hsearch></div>
        <button class="btn btn--ghost" data-close><i class="fa-solid fa-xmark"></i>閉じる</button></div>
      <div class="help"><nav class="help__nav"></nav><div class="help__body"></div></div>
      <div class="modal__foot"><label class="inline"><input type="checkbox" class="check" data-never ${DM.safeStorage.get("dm.helpNever", "") === "1" ? "checked" : ""}> 起動時に自動で表示しない</label></div></div>`;
    document.body.appendChild(back); modal = back;
    const nav = back.querySelector(".help__nav"), body = back.querySelector(".help__body");
    const show = (cid) => { const c = DM.help.get(cid) || chapters[0]; DM.safeStorage.set("dm.helpChapter", c.id); body.innerHTML = `<h2><i class="fa-solid ${c.icon}"></i> ${DM.esc(c.title)}</h2>${c.html}`; nav.querySelectorAll("button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.c === c.id))); };
    const drawNav = (q) => { nav.innerHTML = chapters.filter((c) => !q || DM.norm(c.title + c.html.replace(/<[^>]+>/g, "")).includes(DM.norm(q))).map((c) => `<button data-c="${c.id}"><i class="fa-solid ${c.icon}"></i>${DM.esc(c.title)}</button>`).join("") || '<span class="note">該当する章がありません</span>'; };
    drawNav(""); show(last);
    back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-close]")) { modal.remove(); modal = null; return; } const b = e.target.closest("[data-c]"); if (b) show(b.dataset.c); });
    back.querySelector("[data-hsearch]").addEventListener("input", (e) => { drawNav(e.target.value); const f = nav.querySelector("button"); if (f) show(f.dataset.c); });
    back.querySelector("[data-never]").addEventListener("change", (e) => DM.safeStorage.set("dm.helpNever", e.target.checked ? "1" : ""));
  };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modal) { modal.remove(); modal = null; } });
  DM.maybeAutoHelp = function () { if (DM.safeStorage.get("dm.helpNever", "") !== "1") DM.openHelp("quick"); };
})();
