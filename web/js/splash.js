/* ── splash: 起動中の画面 ────────────────────────────
   index.html の先頭に置いた .splash を、準備が終わったら消す。
   - 進み具合は「実際に終わった作業」だけで動かす（DM.splash.step）。見かけだけの待ち時間は作らない。
   - ただしロゴが一瞬ちらつくだけにならないよう、最低 700ms は見せる。
   - 何かが固まっても 8 秒で必ず消す。「スキップ」でも消せる。 */
(function () {
  "use strict";
  const DM = (window.DM = window.DM || {});
  const MIN_MS = 700, LIMIT_MS = 8000;
  const t0 = performance.now();
  let el = null, bar = null, msg = null, closed = false;

  function find() { el = document.getElementById("splash"); if (el) { bar = el.querySelector(".splash__bar"); msg = el.querySelector(".splash__msg"); } return el; }

  DM.splash = {
    /* 進み具合（0〜1）と、いま何をしているかの文言 */
    step(ratio, text) {
      if (closed || !find()) return;
      bar.classList.remove("is-wait"); bar.firstElementChild.style.width = Math.round(Math.max(0.08, Math.min(1, ratio)) * 100) + "%";
      if (text) msg.textContent = text;
    },
    /* 長く待つ作業のとき（サーバー・共有への接続など）：終わりが読めない動きにする */
    wait(text) { if (closed || !find()) return; bar.classList.add("is-wait"); if (text) msg.textContent = text; },
    done() {
      if (closed || !find()) return Promise.resolve();
      closed = true;
      bar.classList.remove("is-wait"); bar.firstElementChild.style.width = "100%"; msg.textContent = "準備ができました";
      const rest = Math.max(0, MIN_MS - (performance.now() - t0));
      return new Promise((resolve) => setTimeout(() => {
        el.classList.add("is-leaving");
        setTimeout(() => { el.remove(); resolve(); }, 400);
      }, rest + 120));
    },
  };

  /* 固まったときの逃げ道 */
  setTimeout(() => { if (!closed) DM.splash.done(); }, LIMIT_MS);
  document.addEventListener("DOMContentLoaded", () => {
    if (!find()) return;
    const skip = el.querySelector("[data-skip]");
    if (skip) skip.addEventListener("click", () => DM.splash.done());
  });
})();
