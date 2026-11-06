/* ── detail-card: 選んだロットの全項目を、表の右にカードで出す ──────────
   - 表は列が多く、横にスクロールしないと見えない項目がある。選んだ 1 件の全項目を、縦に並べて一目で読めるようにする
   - 選ぶと自動で開き、選びが無くなれば閉じる。×で閉じても、別の行を選べばまた出る
   - 複数選んだときは「最後に選んだ 1 件」を出し、残りは数で添える（隠さない §1-13）
   - 表で隠した列も出す（印を付ける）。「値のある項目だけ」で空欄を省ける（設定は覚える） */
(function () {
  "use strict";
  const DM = window.DM;

  DM.mountDetailCard = function (el) {
    let dismissedFor = null;                                   // × で閉じたときの行。別の行を選べば解除
    let onlyFilled = DM.safeStorage.get("dm.detailFilled", "") === "1";

    function draw() {
      const s = DM.store, ids = Array.from(s.selected), id = ids[ids.length - 1];
      const r = id == null ? null : s.byId(id);
      if (!r || id === dismissedFor) { el.classList.add("hidden"); return; }
      if (dismissedFor != null && id !== dismissedFor) dismissedFor = null;
      const lot = DM.lotColumn(s.columns), hidden = DM.view.hidden;
      const title = lot && !DM.isEmpty(r[lot]) ? String(r[lot]) : "（ロット番号なし）";
      const items = s.columns.filter((c) => !onlyFilled || !DM.isEmpty(r[c]));
      el.classList.remove("hidden");
      el.innerHTML = `
        <div class="detail__head">
          <div class="detail__top"><i class="fa-solid fa-id-card"></i>選んだロット${ids.length > 1 ? `<span class="tag tag--info">ほか ${DM.fmtNum(ids.length - 1)} 件を選択中</span>` : ""}<span class="topbar__spacer"></span>
            <button class="btn btn--icon btn--ghost" data-close title="カードを閉じる" aria-label="カードを閉じる"><i class="fa-solid fa-xmark"></i></button></div>
          <div class="detail__lot">${DM.esc(title)}</div>
        </div>
        <div class="detail__tools"><label class="inline"><input type="checkbox" class="check" data-filled ${onlyFilled ? "checked" : ""}> 値のある項目だけ</label><span class="note">${DM.fmtNum(items.length)} / ${DM.fmtNum(s.columns.length)} 項目</span></div>
        <dl class="detail__list">${items.map((c) => {
          const empty = DM.isEmpty(r[c]);
          return `<div class="detail__item${empty ? " is-empty" : ""}${hidden.has(c) ? " is-hiddencol" : ""}"><dt>${hidden.has(c) ? '<i class="fa-solid fa-eye-slash" title="表では隠している列"></i>' : ""}${DM.esc(c)}</dt><dd>${empty ? "—" : DM.esc(r[c])}</dd></div>`;
        }).join("")}</dl>`;
    }

    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) { const ids = Array.from(DM.store.selected); dismissedFor = ids[ids.length - 1]; el.classList.add("hidden"); }
    });
    el.addEventListener("change", (e) => {
      if (e.target.matches("[data-filled]")) { onlyFilled = e.target.checked; DM.safeStorage.set("dm.detailFilled", onlyFilled ? "1" : ""); draw(); }
    });
    DM.bus.on("selection", draw); DM.bus.on("view", draw); DM.bus.on("data", draw);
    draw();
  };
})();
