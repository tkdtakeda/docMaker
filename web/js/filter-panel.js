/* ── filter-panel: 検索・フィルターの入力部品 ────────────────
   - 入力しながら即反映（0.4 秒以内の合図 §7）。Enter で次の欄へ、変換中は移らない（§6）。
   - 適用中の条件は表の近くに札で出す（§1-12 §1-13）。 */
(function () {
  "use strict";
  const DM = window.DM;

  /* 検索ボックス（上部バー用）。全列を対象に、全角半角・かなカナの違いは同じとみなす */
  DM.mountSearch = function (input) {
    let t;
    input.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => { DM.setQuery({ search: input.value }); input.classList.remove("is-applied"); void input.offsetWidth; input.classList.add("is-applied"); }, 160);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") { input.value = ""; DM.setQuery({ search: "" }); } });
    DM.bus.on("query", () => { if (input.value !== DM.queryState.search) input.value = DM.queryState.search; });
  };

  /* フィルター条件の編集パネル */
  DM.mountFilterPanel = function (el) {
    const render = () => {
      const cols = DM.store.columns, st = DM.queryState;
      const dateCols = DM.store.mode === "remote" ? DM.store.dateColumns : DM.dateColumns(DM.store.rows, cols);
      const rowsHtml = st.filters.map((f, i) => {
        const o = DM.ops.get(f.op) || DM.ops.get("contains");
        return `<div class="filter-row" data-i="${i}">
          <div class="row">
            <div class="field"><label>項目</label><select class="select" data-k="column" data-nav>${cols.map((c) => `<option ${c === f.column ? "selected" : ""}>${DM.esc(c)}</option>`).join("")}</select></div>
            <button class="btn btn--icon btn--ghost" data-del="${i}" title="この条件を外す" aria-label="この条件を外す"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <div class="row">
            <div class="field" style="flex:1.1"><label>条件</label><select class="select" data-k="op" data-nav>${DM.ops.list().map((x) => `<option value="${x.id}" ${x.id === f.op ? "selected" : ""}>${DM.esc(x.label)}</option>`).join("")}</select></div>
            <div class="field ${o.needsValue ? "" : "hidden"}"><label>${o.date ? "数（" + o.label + "）" : "値"}</label><input class="input" type="text" data-k="value" data-nav value="${DM.esc(f.value)}" inputmode="${o.date || o.numeric ? "numeric" : "text"}"></div>
          </div></div>`;
      }).join("");
      const quick = dateCols.slice(0, 2).map((c) => `<span class="quick"><span class="label">${DM.esc(c)}</span>${[["7", "7日以内"], ["30", "30日以内"], ["90", "3か月以内"]].map(([n, l]) => `<button class="btn" data-quick="${DM.esc(c)}|${n}">${l}</button>`).join("")}</span>`).join("");
      el.innerHTML = `
        <div class="group"><div class="group__title"><i class="fa-solid fa-bolt"></i>よく使う絞り込み</div>${quick || '<span class="label">日付の列が見つかりません</span>'}</div>
        <div class="group"><div class="group__title"><i class="fa-solid fa-filter"></i>条件（すべてに当てはまる行）</div>
          ${rowsHtml || '<span class="label">条件はありません。下のボタンで追加します。</span>'}
          <div class="row"><button class="btn" data-add ${st.filters.length >= 20 ? "disabled title='条件は20件までです'" : ""}><i class="fa-solid fa-plus"></i>条件を追加</button>
          <button class="btn btn--ghost" data-clear ${st.filters.length ? "" : "disabled"}><i class="fa-solid fa-eraser"></i>すべて外す</button></div></div>`;
    };
    const flash = (t) => { t.classList.remove("is-applied"); void t.offsetWidth; t.classList.add("is-applied"); };
    const upd = (i, patch, target) => {
      const prev = DM.queryState.filters.map((f) => Object.assign({}, f));
      DM.queryState.filters[i] = Object.assign({}, DM.queryState.filters[i], patch);
      if (patch.op) { const o = DM.ops.get(patch.op); if (!o.needsValue) DM.queryState.filters[i].value = ""; }
      DM.bus.emit("query");
      if (patch.op || patch.column) render();
      if (target && target.isConnected) flash(target);
      return prev;
    };
    el.addEventListener("input", (e) => { const r = e.target.closest(".filter-row"); if (r && e.target.dataset.k === "value") { clearTimeout(el._t); el._t = setTimeout(() => upd(+r.dataset.i, { value: e.target.value }, e.target), 180); } });
    el.addEventListener("change", (e) => { const r = e.target.closest(".filter-row"); if (r && e.target.dataset.k && e.target.dataset.k !== "value") upd(+r.dataset.i, { [e.target.dataset.k]: e.target.value }); });
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const st = DM.queryState, prev = st.filters.map((f) => Object.assign({}, f));
      const undo = () => { st.filters = prev; DM.bus.emit("query"); render(); };
      if (b.dataset.add !== undefined) { st.filters.push({ column: DM.store.columns[0] || "", op: "contains", value: "" }); DM.bus.emit("query"); render(); const last = el.querySelectorAll(".filter-row"); const n = last[last.length - 1]; if (n) n.querySelector("select").focus(); }
      else if (b.dataset.del !== undefined) { st.filters.splice(+b.dataset.del, 1); DM.bus.emit("query"); render(); DM.toast("条件を外しました", { icon: "fa-filter-circle-xmark", undo }); }
      else if (b.dataset.clear !== undefined) { st.filters = []; DM.bus.emit("query"); render(); DM.toast("すべての条件を外しました", { icon: "fa-filter-circle-xmark", undo }); }
      else if (b.dataset.quick) { const [c, n] = b.dataset.quick.split("|"); st.filters = st.filters.filter((f) => !(f.column === c && f.op === "within_days")); st.filters.push({ column: c, op: "within_days", value: n }); DM.bus.emit("query"); render(); }
    });
    DM.enableFormNav(el);
    DM.bus.on("data", render);
    DM.bus.on("page", () => { if (DM.store.mode === "remote" && !el._dc) { el._dc = 1; render(); } });
    DM.bus.on("filters-external", render);
    render();
    return { render };
  };

  /* 適用中の条件を札で並べる（表の近く）。札の × で外す */
  DM.mountActiveChips = function (el) {
    const draw = () => {
      const st = DM.queryState, tags = [];
      if (st.search) tags.push(`<span class="tag tag--info"><i class="fa-solid fa-magnifying-glass"></i>「${DM.esc(st.search)}」<button data-rm="search" aria-label="検索を外す"><i class="fa-solid fa-xmark"></i></button></span>`);
      st.filters.forEach((f, i) => { const o = DM.ops.get(f.op); if (!o) return; tags.push(`<span class="tag tag--info"><i class="fa-solid fa-filter"></i>${DM.esc(f.column)} ${o.needsValue ? DM.esc(f.value || "…") + " " : ""}${DM.esc(o.label)}<button data-rm="${i}" aria-label="この条件を外す"><i class="fa-solid fa-xmark"></i></button></span>`); });
      st.sorts.forEach((s, i) => tags.push(`<span class="tag"><i class="fa-solid fa-arrow-${s.dir === "desc" ? "down" : "up"}-wide-short"></i>${DM.esc(s.column)} ${s.dir === "desc" ? "降順" : "昇順"}<button data-rms="${i}" aria-label="並べ替えを外す"><i class="fa-solid fa-xmark"></i></button></span>`));
      el.innerHTML = tags.join("");
      el.classList.toggle("hidden", !tags.length);
    };
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.rm === "search") DM.setQuery({ search: "" });
      else if (b.dataset.rm !== undefined) { DM.queryState.filters.splice(+b.dataset.rm, 1); DM.bus.emit("query"); DM.bus.emit("filters-external"); }
      else if (b.dataset.rms !== undefined) { DM.queryState.sorts.splice(+b.dataset.rms, 1); DM.bus.emit("query"); }
    });
    DM.bus.on("query", draw); draw();
  };
})();
