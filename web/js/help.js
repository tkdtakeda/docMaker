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
  DM.help.register({ id: "work", title: "設定の保存（作業セット）", icon: "fa-bookmark", html: `
    <p><b>自動保存</b>：条件・並べ替え・ロットでまとめる・列（表示・並び）・列幅は、自動で覚えます。列の構成（列の名前の並び）ごとに覚え、次に同じ構成の表を読み込むと当てはめます。当てはめたときは通知が出て、「元に戻す」で初期の表示に戻せます。検索欄の文字は覚えません。</p>
    <p><b>作業セット</b>：左の「作業」で、いまの設定に名前を付けて保存し、一覧の「当てはめる」で切り替えます。同じ名前で保存すると上書きします。上書き・名前の変更・削除は ⋮ の中にあります（削除は元に戻せます）。</p>
    <p><b>ほかの PC へ渡す</b>：「書き出す（JSON）」で保存し、渡した先の「読み込む」かドロップで入れます。同じ名前があれば「(2)」を付けて足します。</p>
    <p><b>列</b>：左の「表示」で、列のチェックを外すと隠れ、ドラッグか ▲▼（Alt+↑↓）で並べ替えます。</p>
    <p class="note"><i class="fa-solid fa-circle-info"></i><span>保存先はこの PC・このブラウザです（作業セットは 50 件まで、合わせて 1,000 KB まで）。</span></p>` });
  DM.help.register({ id: "keys", title: "キーボード操作", icon: "fa-keyboard", html: `
    <table class="help-table"><tr><th>操作</th><th>キー</th></tr>
    <tr><td>行の移動</td><td>${K("↑")} ${K("↓")}（${K("Shift")}＋で範囲選択）</td></tr>
    <tr><td>行の選択・解除</td><td>${K("Space")}</td></tr>
    <tr><td>確認画面を開く（帳票を選択済み）</td><td>${K("Enter")}</td></tr>
    <tr><td>検索を消す</td><td>${K("Esc")}</td></tr>
    <tr><td>入力欄で次へ／前へ</td><td>${K("Enter")} ／ ${K("Shift")}＋${K("Enter")}（変換中は移りません）</td></tr>
    <tr><td>確認画面を閉じる</td><td>${K("Esc")}</td></tr></table>` });
  DM.help.register({ id: "report", title: "帳票を作る・直す", icon: "fa-file-invoice", html: `
    <p>左の <b>「帳票」</b> で帳票の画面が開きます（帳票は前もって作っておき、全員で使います）。作り方は 2 つです。</p>
    <ul><li><b>ツールで作る</b>：「＋」で新しい帳票。帯（縦に積む）→ 区画（横に並べる）→ 表のブロックで組み立て、セルに文字や <code>{列名}</code> を入れます（右の列の一覧からクリックでも入ります）。<code>{数量|桁=0|桁区切り}</code> のように書式も付けられます。</li>
    <li><b>Excel のひな形</b>：Excel で作った様式（.xlsx）を入れ、セルを選んで項目（DB の列・計算式・公差・固定の文字・ページ番号など）を置きます。</li></ul>
    <p>明細の表（板の表）にした行は、ロットの行の数だけ繰り返し、あふれたら次のページへ続きます。表の外のセルは、ロットの行で値が 1 つならその値、違う値があれば空欄になります。</p>
    <p>ロットを選んでから開くと、そのロットで出力イメージを確かめながら作れます。変更は自動で保存されます。</p>
    <p class="note"><i class="fa-solid fa-circle-info"></i><span>帳票の部品は CDB と同じものです（CDB の検査番号・板番号の特別な機能と、作成済の記録は入っていません）。</span></p>` });
  DM.help.register({ id: "db", title: "DB を読み込む", icon: "fa-database", html: `
    <p>Start.bat で開いたとき、左の <b>「データ」</b> に品質データ（SQLite）のファイルの場所を入れて、Enter（または「読み込む」）。共有（<code>\\\\server\\share\\…</code>）も指定できます。次に開いたときは自動で読み込みます。</p>
    <p>共有は直接読まず、この PC に<b>写してから</b>読みます（書き込み中の中途半端な状態を読まないため）。壊れた写しは採用せず、共有に届かないときは前の写しを使い続けます。</p>
    <p>状態バーに、出どころ・更新時刻・件数が出ます。<b>「データが古い」</b>は元ファイルが長く更新されていない印、<b>「共有に届きません」</b>は前の写しを表示している印です。「再読込」で共有から取り直せます。</p>
    <p>検索・絞り込み・並べ替えは、DB 全体に対して行います（表示は 1 ページずつ）。別のページで選んだロットも、まとめて帳票にできます。</p>
    <p class="note"><i class="fa-solid fa-circle-info"></i><span>まったく同じ内容の行は 1 件として扱います（DB に行を区別する番号がないため）。</span></p>` });
  DM.help.register({ id: "sample", title: "サンプルデータ", icon: "fa-flask", html: `
    <p>左の「データ」から、目的別のサンプルを読み込めます（毎回同じ内容です）。「必須項目の欠け」を読み込むと、不足の表示を確かめられます。</p>
    <p>「サンプルだけを消す」で、サンプルの行だけが消えます。あとから読み込む実データは消えません。</p>` });
  DM.help.register({ id: "version", title: "版と利用状況", icon: "fa-code-branch", html: `
    <p>右上の <b>v0.0.0</b> の札を押すと、<b>更新履歴</b>と<b>利用状況</b>が開きます。</p>
    <p>ほかの人が新しい版を使い始めると、札の横に <b>「新しい版あり」</b> が出ます（使い続けても構いません）。最新版は「使っている人たちの版のうち、いちばん新しいもの」です。</p>
    <p>画面の上に <b>「プログラムが入れ替わりました」</b> と出たら、Start.bat の窓を閉じて、もう一度 Start.bat を開いてください（古いサーバーが残っている状態です）。</p>
    <p class="note"><i class="fa-solid fa-circle-info"></i><span>サーバー（Start.bat）を使わず index.html を直接開いたときは、版の札は出ません。</span></p>` });
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
