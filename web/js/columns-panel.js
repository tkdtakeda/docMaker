/* ── columns-panel: 列の表示・並び（表示パネルの「列」）──────────────
   - チェックで表示／非表示、ドラッグまたは ▲▼ で並べ替え（Alt+↑↓ でも）
   - 列が多いときは、入力しながら探せる（全角半角・かなカナの違いは同じとみなす §6）
   - 隠した列があることは見出しに数で出す（適用中の設定を隠さない §1-13）
   - 変えたら表へすぐ反映し、その行を短く光らせる（反映の合図 §7）
   - 列は名前で覚える（DM.view）。保存・当てはめは prefs.js が受け持つ */
(function () {
  "use strict";
  const DM = window.DM;

  DM.mountColumnsPanel = function (el) {
    let q = "", flashCol = "";
    const draw = () => {
      const keepFocus = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset.focusKey : "";
      const all = DM.view.ordered(), hidden = DM.view.hidden;
      const shown = all.filter((c) => !hidden.has(c)).length;
      const nq = DM.norm(q.trim());
      const rows = all.map((c, i) => ({ c, i })).filter((x) => !nq || DM.norm(x.c).includes(nq));
      el.innerHTML = `
        <div class="group"><div class="group__title"><i class="fa-solid fa-table-columns"></i>列（${shown} / ${all.length} 列を表示${hidden.size ? `・<span class="tag tag--warn"><i class="fa-solid fa-eye-slash"></i>隠した列 ${hidden.size}</span>` : ""}）</div>
          ${all.length ? `<div class="searchbox"><i class="fa-solid fa-magnifying-glass"></i><input class="input" type="search" data-colq data-focus-key="q" value="${DM.esc(q)}" placeholder="列を探す" aria-label="列を探す"></div>
          <ul class="collist" role="list">${rows.map(({ c, i }) => `<li class="collist__row${c === flashCol ? " is-applied" : ""}${hidden.has(c) ? " is-hidden" : ""}" draggable="${nq ? "false" : "true"}" data-col="${DM.esc(c)}">
            <span class="collist__grip" title="ドラッグで並べ替え"><i class="fa-solid fa-grip-vertical"></i></span>
            <label class="collist__name"><input type="checkbox" class="check" data-show data-focus-key="s:${DM.esc(c)}" ${hidden.has(c) ? "" : "checked"} aria-label="${DM.esc(c)} を表示"> <span>${DM.esc(c)}</span></label>
            <button class="btn btn--icon btn--ghost" data-move="-1" data-focus-key="u:${DM.esc(c)}" ${i === 0 || nq ? "disabled" : ""} title="${nq ? "探している間は並べ替えできません" : "上へ（Alt+↑）"}" aria-label="${DM.esc(c)} を上へ"><i class="fa-solid fa-chevron-up"></i></button>
            <button class="btn btn--icon btn--ghost" data-move="1" data-focus-key="d:${DM.esc(c)}" ${i === all.length - 1 || nq ? "disabled" : ""} title="${nq ? "探している間は並べ替えできません" : "下へ（Alt+↓）"}" aria-label="${DM.esc(c)} を下へ"><i class="fa-solid fa-chevron-down"></i></button></li>`).join("") || '<li class="note">当てはまる列がありません</li>'}</ul>
          <div class="row"><button class="btn" data-showall ${hidden.size ? "" : "disabled"} title="${hidden.size ? "" : "隠した列はありません"}"><i class="fa-solid fa-eye"></i>すべて表示</button>
            <button class="btn btn--ghost" data-resetorder ${DM.view.order.length || hidden.size ? "" : "disabled"}><i class="fa-solid fa-arrow-rotate-left"></i>DB の並びに戻す</button></div>`
          : '<span class="note">データを読み込むと、ここに列が並びます。</span>'}</div>`;
      if (keepFocus) { const f = el.querySelector(`[data-focus-key="${CSS.escape(keepFocus)}"]`); if (f) { f.focus(); if (f.matches("[data-colq]")) { const v = f.value; f.setSelectionRange(v.length, v.length); } } }
      flashCol = "";
    };
    const before = () => ({ hidden: Array.from(DM.view.hidden), order: DM.view.ordered() });
    const undoTo = (snap) => () => DM.view.set({ hidden: snap.hidden, order: snap.order });
    const move = (c, d) => {
      const ord = DM.view.ordered(), i = ord.indexOf(c), j = i + d;
      if (i < 0 || j < 0 || j >= ord.length) return;
      ord.splice(i, 1); ord.splice(j, 0, c);
      flashCol = c; DM.view.set({ order: ord });
    };
    el.addEventListener("input", (e) => { if (e.target.matches("[data-colq]")) { q = e.target.value; draw(); } });
    el.addEventListener("change", (e) => {
      const row = e.target.closest("[data-col]");
      if (!row || !e.target.matches("[data-show]")) return;
      const c = row.dataset.col, h = new Set(DM.view.hidden);
      if (e.target.checked) h.delete(c);
      else {
        if (DM.view.columns().length <= 1) { e.target.checked = true; DM.toast("すべての列は隠せません（1 列は表示します）", { icon: "fa-circle-info" }); return; }
        h.add(c);
      }
      flashCol = c; DM.view.set({ hidden: Array.from(h) });
    });
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.move) { const r = b.closest("[data-col]"); if (r) move(r.dataset.col, +b.dataset.move); }
      else if (b.dataset.showall !== undefined) { const s = before(); DM.view.set({ hidden: [] }); DM.toast("すべての列を表示しました", { icon: "fa-eye", undo: undoTo(s) }); }
      else if (b.dataset.resetorder !== undefined) { const s = before(); DM.view.set({ hidden: [], order: [] }); DM.toast("列を DB の並びに戻しました", { icon: "fa-arrow-rotate-left", undo: undoTo(s) }); }
    });
    el.addEventListener("keydown", (e) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      const r = e.target.closest && e.target.closest("[data-col]"); if (!r || q) return;
      e.preventDefault(); move(r.dataset.col, e.key === "ArrowUp" ? -1 : 1);
    });
    /* ドラッグで並べ替え（落とした行の前に入れる） */
    let dragCol = "";
    el.addEventListener("dragstart", (e) => { const r = e.target.closest("[data-col]"); if (!r) return; dragCol = r.dataset.col; e.dataTransfer.effectAllowed = "move"; r.classList.add("is-dragging"); });
    el.addEventListener("dragover", (e) => { const r = e.target.closest("[data-col]"); if (!r || !dragCol) return; e.preventDefault(); el.querySelectorAll(".is-drop").forEach((x) => x.classList.remove("is-drop")); r.classList.add("is-drop"); });
    el.addEventListener("dragend", () => { dragCol = ""; el.querySelectorAll(".is-drop,.is-dragging").forEach((x) => x.classList.remove("is-drop", "is-dragging")); });
    el.addEventListener("drop", (e) => {
      const r = e.target.closest("[data-col]"); if (!r || !dragCol) return;
      e.preventDefault();
      const ord = DM.view.ordered().filter((c) => c !== dragCol);
      ord.splice(ord.indexOf(r.dataset.col), 0, dragCol);
      flashCol = dragCol; dragCol = ""; DM.view.set({ order: ord });
    });
    ["data", "view"].forEach((n) => DM.bus.on(n, draw)); draw();
  };
})();
