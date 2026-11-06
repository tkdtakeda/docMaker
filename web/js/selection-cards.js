/* ── selection-cards: 選んだロットを、下のトレーにカードで並べる ──────────
   - 1 枚＝選んだ 1 行。ロット番号を大きく、続く表示中の列から値のある 2 つを小さく出す（全項目は吹き出し）
   - 行・列が多くても高さは 1 段のまま（横スクロール）。表を狭めない
   - × でその 1 件だけ外す／カードを押すと、表のその行へ移る（いまのページにあるとき）
   - 多すぎるときは先頭から MAX 枚まで。残りは「ほか n 件」と数で出す（隠さない §1-13） */
(function () {
  "use strict";
  const DM = window.DM;
  const MAX = 60;

  DM.mountSelectionCards = function (el, opts) {
    let prevN = 0;
    const subOf = (r, lot) => DM.view.columns().filter((c) => c !== lot && !DM.isEmpty(r[c])).slice(0, 2).map((c) => String(r[c])).join("・");
    const allOf = (r) => DM.store.columns.filter((c) => !DM.isEmpty(r[c])).map((c) => `${c}: ${r[c]}`).join("\n");

    function draw() {
      const s = DM.store, ids = Array.from(s.selected), lot = DM.lotColumn(s.columns);
      const shown = ids.slice(0, MAX);
      el.innerHTML = shown.map((id) => {
        const r = s.byId(id); if (!r) return "";
        const title = lot && !DM.isEmpty(r[lot]) ? String(r[lot]) : "（ロット番号なし）";
        return `<div class="selcard" data-id="${DM.esc(id)}" title="${DM.esc(allOf(r))}"><div class="selcard__main"><div class="selcard__lot">${DM.esc(title)}</div><div class="selcard__sub">${DM.esc(subOf(r, lot)) || "&nbsp;"}</div></div>
          <button class="selcard__x" data-x aria-label="${DM.esc(title)} の選択を外す" title="この 1 件の選択を外す"><i class="fa-solid fa-xmark"></i></button></div>`;
      }).join("") + (ids.length > MAX ? `<div class="selcard selcard--more"><i class="fa-solid fa-ellipsis"></i>&nbsp;ほか ${DM.fmtNum(ids.length - MAX)} 件</div>` : "");
      if (ids.length === prevN + 1) el.scrollLeft = el.scrollWidth;       // 1 件足したときは、足したカードが見える所へ
      prevN = ids.length;
    }

    el.addEventListener("click", (e) => {
      const card = e.target.closest(".selcard[data-id]"); if (!card) return;
      const rawId = card.dataset.id, id = DM.parseId(rawId);
      if (e.target.closest("[data-x]")) { const n = new Set(DM.store.selected); n.delete(id); DM.store.setSelected(n); return; }
      const tr = Array.from(opts.grid.querySelectorAll("tbody tr[data-id]")).find((t) => t.dataset.id === rawId);
      if (tr) { tr.scrollIntoView({ block: "center" }); tr.focus(); }
      else DM.toast("この行は別のページにあります", { icon: "fa-circle-info" });
    });
    DM.bus.on("selection", draw); DM.bus.on("view", draw); DM.bus.on("data", draw);
    draw();
  };
})();
