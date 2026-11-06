/* ── about: バージョン情報（上部バーのロゴを押すと開く）──────────
   製品の顔になる情報だけを出す。版はサーバーにつながっているときだけ分かる（version.js が持つ）。 */
(function () {
  "use strict";
  const DM = window.DM;
  const online = /^https?:$/.test(location.protocol);
  let modal = null;
  const close = () => { if (modal) { modal.remove(); modal = null; } };

  DM.openAbout = function () {
    close();
    const v = DM.version && DM.version.state().version;
    const back = document.createElement("div"); back.className = "modal-back";
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="docMaker について" style="width:min(460px,94vw)">
      <div class="modal__head"><i class="fa-solid fa-circle-info"></i>docMaker について<span class="topbar__spacer"></span><button class="btn btn--ghost" data-close><i class="fa-solid fa-xmark"></i>閉じる</button></div>
      <div class="modal__body about">
        <img class="about__logo" src="img/logo.svg" alt="">
        <h2 class="about__name">doc<b>Maker</b></h2>
        <span class="about__ver">${v ? "バージョン " + DM.esc(v) : "バージョン情報はサーバー（Start.bat）で開いたときに表示されます"}</span>
        <p class="about__tag">品質データのロットを選び、帳票に必要事項を転記して、<br>そのまま印刷・Excel 出力できる業務ツールです。</p>
        <dl class="about__list">
          <dt>動作モード</dt><dd>${online ? '<i class="fa-solid fa-server"></i> サーバー（共有・帳票の登録が使えます）' : '<i class="fa-regular fa-file"></i> 単体（画面の確認用。サンプルで動かせます）'}</dd>
          <dt>画面の基準</dt><dd>Edge の最新版／画面幅 1100px 以上</dd>
        </dl>
        <div class="about__acts">
          ${online ? '<button class="btn" data-ver><i class="fa-solid fa-clock-rotate-left"></i>更新履歴</button>' : ""}
          <button class="btn btn--primary" data-help><i class="fa-solid fa-circle-question"></i>取扱説明書</button>
        </div>
      </div></div>`;
    document.body.appendChild(back); modal = back;
    back.addEventListener("click", (e) => {
      if (e.target === back || e.target.closest("[data-close]")) return close();
      if (e.target.closest("[data-ver]")) { close(); DM.openVersion("log"); }
      if (e.target.closest("[data-help]")) { close(); DM.openHelp(); }
    });
    back.querySelector("[data-help]").focus();
  };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modal) close(); });
})();
