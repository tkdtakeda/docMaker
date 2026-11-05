/* ── grid: 表（メイン領域）──────────────────────────────
   - 列は DB と同じ項目。列幅は見出しと内容から実際のフォントで測って決める（§1-10）。
   - 見出し固定。選択行は背景色＋左の帯＋チェックで示す（§1-15）。
   - クリック＝その行だけ選ぶ／Ctrl＝足す・外す／Shift＝範囲／チェック＝足す・外す。
   - キーボード：↑↓ で移動、Space で選択、Enter で主操作（§1-16）。 */
(function () {
  "use strict";
  const DM = window.DM;
  const PAGE_SIZES = [100, 200, 500, 1000];

  DM.Grid = function (wrap, opts) {
    opts = opts || {};
    const self = this;
    const st = { page: 1, size: +DM.safeStorage.get("dm.pageSize", 200), view: [], widths: {}, manual: {}, anchor: null, numeric: new Set(), focusId: null };
    const canvas = document.createElement("canvas").getContext("2d");

    function measure() {
      const cs = getComputedStyle(wrap), pad = 2 * parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--table-cell-padding-x") || 10);
      const cellPad = isNaN(pad) ? 20 : pad;
      canvas.font = `${cs.fontSize} ${cs.fontFamily}`;
      const rows = DM.store.rows, sample = rows.length > 300 ? rows.filter((_, i) => i % Math.ceil(rows.length / 300) === 0) : rows;
      st.numeric = new Set(DM.numericColumns(rows, DM.store.columns));
      st.widths = {};
      DM.store.columns.forEach((c) => {
        let w = canvas.measureText(c).width + 30;                 // 見出し＋並べ替え印のぶん
        const lens = sample.map((r) => canvas.measureText(String(r[c] == null ? "" : r[c])).width).sort((a, b) => a - b);
        const body = lens.length ? lens[Math.min(lens.length - 1, Math.floor(lens.length * 0.95))] : 0;   // 極端な 1 件で広げない
        w = Math.max(w, body) + cellPad;
        st.widths[c] = Math.round(Math.min(Math.max(w, 64), 300));  // 最小・最大で止める
      });
    }
    const widthOf = (c) => st.manual[c] || st.widths[c] || 100;

    function hints() {
      if (!opts.formHints) return null;
      const f = DM.forms.get(DM.store.formId);
      return f ? { used: DM.forms.usedColumns(f), req: DM.forms.requiredColumns(f) } : null;
    }

    function compute() {
      const lot = DM.lotColumn(DM.store.columns);
      const res = DM.runQuery(DM.store.rows, DM.store.columns, DM.queryState, lot);
      st.view = res.rows; st.lot = lot; st.filterCount = res.filterCount;
      const pages = Math.max(1, Math.ceil(st.view.length / st.size));
      if (st.page > pages) st.page = pages;
    }

    function render() {
      compute();
      const s = DM.store, cols = s.columns, h = hints();
      const total = s.rows.length, n = st.view.length;
      if (!total) { wrap.innerHTML = opts.emptyHtml || `<div class="state"><i class="fa-regular fa-folder-open"></i><strong>まだデータを読み込んでいません</strong><span>まずはサンプルで動きを確かめられます。DB の読み込みは左の「データ」から行います。</span><button class="btn" data-load-sample><i class="fa-solid fa-flask"></i>サンプル（標準）を読み込む</button></div>`; status(); return; }
      if (!n) { wrap.innerHTML = `<div class="state"><i class="fa-solid fa-magnifying-glass"></i><strong>条件に一致するロットは 0 件です</strong><span>検索語や条件を変えてください。（全 ${DM.fmtNum(total)} 件）</span><button class="btn" data-reset-all><i class="fa-solid fa-eraser"></i>検索・条件をすべて外す</button></div>`; status(); return; }
      const from = (st.page - 1) * st.size, slice = st.view.slice(from, from + st.size);
      const allSel = slice.length && slice.every((r) => s.selected.has(r._id));
      const q = DM.norm(DM.queryState.search.trim());
      const sortOf = (c) => { const i = DM.queryState.sorts.findIndex((x) => x.column === c); return i < 0 ? null : { i, dir: DM.queryState.sorts[i].dir }; };
      const th = cols.map((c) => { const so = sortOf(c), num = st.numeric.has(c);
        const mark = h && h.req.has(c) ? `<i class="fa-solid fa-asterisk" title="この帳票で必須の項目" style="color:var(--color-step2);font-size:.7em"></i> ` : "";
        return `<th class="${num ? "num" : ""}" data-col="${DM.esc(c)}" style="width:${widthOf(c)}px" title="クリックで並べ替え（Shift＋クリックで複数）" aria-sort="${so ? (so.dir === "asc" ? "ascending" : "descending") : "none"}">${mark}${DM.esc(c)}${so ? `<span class="sort"><i class="fa-solid fa-arrow-${so.dir === "asc" ? "up" : "down"}"></i>${DM.queryState.sorts.length > 1 ? so.i + 1 : ""}</span>` : ""}<span class="resize" data-resize="${DM.esc(c)}" title="ドラッグで幅を変更／ダブルクリックで初期幅"></span></th>`; }).join("");
      let prevKey = null, body = "";
      slice.forEach((r) => {
        const sel = s.selected.has(r._id);
        if (DM.queryState.group && st.lot) { const k = DM.norm(r[st.lot]).trim(); if (k && k !== prevKey) { const cnt = st.view.filter((x) => DM.norm(x[st.lot]).trim() === k).length; body += `<tr class="group-head"><td colspan="${cols.length + 1}"><i class="fa-solid fa-layer-group"></i> ロット ${DM.esc(r[st.lot])}（${cnt} 行）</td></tr>`; } prevKey = k; }
        const tds = cols.map((c) => {
          let v = r[c] == null ? "" : String(r[c]); const miss = h && h.req.has(c) && DM.isEmpty(v);
          let shown = st.numeric.has(c) && !DM.isEmpty(v) ? DM.fmtNum(String(v).replace(/,/g, "")) : DM.esc(v);
          if (q && !DM.isEmpty(v) && DM.norm(v).includes(q) && !st.numeric.has(c)) shown = `<span class="hl">${shown}</span>`;
          if (miss) shown = `<i class="fa-solid fa-triangle-exclamation"></i> 未入力`;
          return `<td class="${st.numeric.has(c) ? "num" : ""}${miss ? " is-missing" : ""}${h && h.used.has(c) && !miss ? " is-used" : ""}" title="${DM.esc(v)}">${shown}</td>`;
        }).join("");
        body += `<tr tabindex="-1" data-id="${r._id}" class="${sel ? "is-selected" : ""}" aria-selected="${sel}"><td class="col-check"><input type="checkbox" class="check" ${sel ? "checked" : ""} aria-label="ロット ${DM.esc(r[st.lot] || "")} を選ぶ"></td>${tds}</tr>`;
      });
      const total_w = 40 + cols.reduce((a, c) => a + widthOf(c), 0);
      wrap.innerHTML = `<table class="grid" style="width:${total_w}px"><colgroup><col style="width:40px">${cols.map((c) => `<col style="width:${widthOf(c)}px">`).join("")}</colgroup>
        <thead><tr><th class="col-check"><input type="checkbox" class="check" data-all ${allSel ? "checked" : ""} aria-label="表示中をすべて選ぶ" title="表示中の行をすべて選ぶ／外す"></th>${th}</tr></thead><tbody>${body}</tbody></table>`;
      const f = wrap.querySelector(`tr[data-id="${st.focusId}"]`); if (f) f.tabIndex = 0; else { const t = wrap.querySelector("tbody tr[data-id]"); if (t) t.tabIndex = 0; }
      status();
    }

    function status() {
      if (!opts.statusEl) return;
      const s = DM.store, n = st.view.length, pages = Math.max(1, Math.ceil(n / st.size)), from = n ? (st.page - 1) * st.size + 1 : 0, to = Math.min(n, st.page * st.size);
      const src = s.source, sample = s.sampleCount();
      opts.statusEl.innerHTML = `
        <span><i class="fa-solid fa-database"></i> ${DM.esc(src.label)}${sample ? ` <span class="tag tag--sample"><i class="fa-solid fa-flask"></i>サンプル ${DM.fmtNum(sample)} 行</span>` : ""}</span>
        <span><b>${DM.fmtNum(n)}</b> 件${st.filterCount || DM.queryState.search ? `（全 ${DM.fmtNum(s.rows.length)} 件中・絞り込み中）` : ""}</span>
        <span>選択 <b>${DM.fmtNum(s.selected.size)}</b> 件</span><span class="spacer"></span>
        ${DM.store.columns.length && DM.lotColumn(DM.store.columns) ? `<label title="同じロット番号の行を続けて並べます"><input type="checkbox" class="check" data-group ${DM.queryState.group ? "checked" : ""}> ロットでまとめる</label>` : ""}
        <span class="pager"><select class="select" data-size style="height:22px;font-size:inherit" aria-label="1ページの件数">${PAGE_SIZES.map((z) => `<option ${z === st.size ? "selected" : ""} value="${z}">${z}件/ページ</option>`).join("")}</select>
        <button class="btn" data-pg="-1" ${st.page <= 1 ? "disabled" : ""} aria-label="前のページ"><i class="fa-solid fa-chevron-left"></i></button>
        <span>${DM.fmtNum(from)}–${DM.fmtNum(to)}　${st.page} / ${pages}</span>
        <button class="btn" data-pg="1" ${st.page >= pages ? "disabled" : ""} aria-label="次のページ"><i class="fa-solid fa-chevron-right"></i></button></span>`;
    }

    /* 選択 */
    function pick(id, e) {
      const s = DM.store, ids = st.view.map((r) => r._id);
      if (e.shiftKey && st.anchor != null && ids.includes(st.anchor)) { const a = ids.indexOf(st.anchor), b = ids.indexOf(id); s.setSelected(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); }
      else if (e.ctrlKey || e.metaKey || e.target.matches("input.check")) { const n = new Set(s.selected); n.has(id) ? n.delete(id) : n.add(id); s.setSelected(n); st.anchor = id; }
      else { s.setSelected([id]); st.anchor = id; }
      st.focusId = id;
    }
    wrap.addEventListener("click", (e) => {
      if (e.target.closest("[data-load-sample]")) { const c = DM.sampleLoad("standard"); DM.toast(`サンプル ${DM.fmtNum(c)} 行を読み込みました`, { icon: "fa-flask" }); return; }
      if (e.target.closest("[data-reset-all]")) { DM.queryState.search = ""; DM.queryState.filters = []; DM.queryState.sorts = []; DM.bus.emit("query"); DM.bus.emit("filters-external"); return; }
      if (e.target.closest("[data-resize]")) return;
      if (e.target.matches("[data-all]")) { const slice = st.view.slice((st.page - 1) * st.size, st.page * st.size), n = new Set(DM.store.selected); const all = slice.every((r) => n.has(r._id)); slice.forEach((r) => (all ? n.delete(r._id) : n.add(r._id))); DM.store.setSelected(n); return; }
      const th = e.target.closest("th[data-col]");
      if (th) { const c = th.dataset.col, sorts = DM.queryState.sorts, i = sorts.findIndex((x) => x.column === c);
        let next = e.shiftKey ? sorts.slice() : (i >= 0 ? sorts.filter((x) => x.column === c) : []);
        const cur = next.find((x) => x.column === c);
        if (!cur) next.push({ column: c, dir: "asc" }); else if (cur.dir === "asc") cur.dir = "desc"; else next = next.filter((x) => x.column !== c);
        DM.setQuery({ sorts: next.slice(0, 4) }); return; }
      const tr = e.target.closest("tr[data-id]"); if (tr) pick(+tr.dataset.id, e);
    });
    wrap.addEventListener("dblclick", (e) => {
      const rz = e.target.closest("[data-resize]"); if (rz) { delete st.manual[rz.dataset.resize]; render(); return; }
      const tr = e.target.closest("tr[data-id]"); if (tr && opts.onEnter) { DM.store.setSelected([+tr.dataset.id]); opts.onEnter(DM.store.byId(+tr.dataset.id)); }
    });
    wrap.addEventListener("pointerdown", (e) => {                 // 列幅の手動変更
      const rz = e.target.closest("[data-resize]"); if (!rz) return; e.preventDefault(); e.stopPropagation();
      const c = rz.dataset.resize, x0 = e.clientX, w0 = widthOf(c);
      const mv = (ev) => { st.manual[c] = Math.max(48, Math.round(w0 + ev.clientX - x0)); const i = DM.store.columns.indexOf(c) + 1; const col = wrap.querySelector(`colgroup col:nth-child(${i + 1})`); if (col) col.style.width = st.manual[c] + "px"; const t = wrap.querySelector("table"); if (t) t.style.width = 40 + DM.store.columns.reduce((a, k) => a + widthOf(k), 0) + "px"; };
      const up = () => { document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", up); render(); };
      document.addEventListener("pointermove", mv); document.addEventListener("pointerup", up);
    });
    wrap.addEventListener("keydown", (e) => {
      const tr = e.target.closest && e.target.closest("tr[data-id]"); if (!tr) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const rows = Array.from(wrap.querySelectorAll("tbody tr[data-id]")), i = rows.indexOf(tr) + (e.key === "ArrowDown" ? 1 : -1); if (rows[i]) { tr.tabIndex = -1; rows[i].tabIndex = 0; rows[i].focus(); st.focusId = +rows[i].dataset.id; if (e.shiftKey) pick(+rows[i].dataset.id, { shiftKey: true, target: rows[i] }); } }
      else if (e.key === " ") { e.preventDefault(); pick(+tr.dataset.id, { ctrlKey: true, target: tr }); setTimeout(() => { const t = wrap.querySelector(`tr[data-id="${tr.dataset.id}"]`); if (t) { t.tabIndex = 0; t.focus(); } }, 0); }
      else if (e.key === "Enter" && opts.onEnter) { e.preventDefault(); opts.onEnter(DM.store.byId(+tr.dataset.id)); }
    });
    if (opts.statusEl) {
      opts.statusEl.addEventListener("click", (e) => { const b = e.target.closest("[data-pg]"); if (b) { st.page += +b.dataset.pg; render(); } });
      opts.statusEl.addEventListener("change", (e) => {
        if (e.target.matches("[data-size]")) { st.size = +e.target.value; st.page = 1; DM.safeStorage.set("dm.pageSize", st.size); render(); }
        if (e.target.matches("[data-group]")) DM.setQuery({ group: e.target.checked });
      });
    }

    /* 再描画の契機（選択だけが変わったときはスクロールを保つ） */
    const keep = (fn) => () => { const t = wrap.scrollTop, l = wrap.scrollLeft; fn(); wrap.scrollTop = t; wrap.scrollLeft = l; const f = wrap.querySelector(`tr[data-id="${st.focusId}"]`); if (f && wrap.contains(document.activeElement)) f.focus(); };
    DM.bus.on("data", () => { st.page = 1; st.manual = {}; measure(); render(); });
    DM.bus.on("query", () => { st.page = 1; keep(render)(); });
    DM.bus.on("selection", keep(render));
    DM.bus.on("form", keep(render));
    DM.bus.on("density", () => { requestAnimationFrame(() => { measure(); render(); }); });
    self.resetWidths = () => { st.manual = {}; measure(); render(); };
    self.visibleRows = () => st.view;
    self.refresh = () => { measure(); render(); };
    measure(); render();
  };
})();
