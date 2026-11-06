/* ── grid: 表（メイン領域）──────────────────────────────
   - 列は DB と同じ項目。列幅は見出しと内容から実際のフォントで測って決める（§1-10）。
   - 見出し固定。選択行は背景色＋左の帯＋チェックで示す（§1-15）。
   - クリック＝その行だけ選ぶ／Ctrl＝足す・外す／Shift＝範囲／チェック＝足す・外す。
   - キーボード：↑↓ で移動、Space で選択、Enter で主操作（§1-16）。 */
(function () {
  "use strict";
  const DM = window.DM;
  const PAGE_SIZES = [100, 200, 500, 1000];

  const pid = (v) => DM.parseId(v);

  DM.Grid = function (wrap, opts) {
    opts = opts || {};
    const self = this;
    const st = { page: 1, size: +DM.safeStorage.get("dm.pageSize", 200), view: [], widths: {}, anchor: null, numeric: new Set(), focusId: null };
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
    const widthOf = (c) => DM.view.widths[c] || st.widths[c] || 100;

    function hints() {
      if (!opts.formHints) return null;
      const f = DM.forms.get(DM.store.formId);
      return f ? { used: DM.forms.usedColumns(f), req: DM.forms.requiredColumns(f) } : null;
    }

    const rowEl = (id) => Array.from(wrap.querySelectorAll("tbody tr[data-id]")).find((t) => t.dataset.id === String(id));
    const remote = () => DM.store.mode === "remote";
    const pageRows = () => (remote() ? st.view : st.view.slice((st.page - 1) * st.size, st.page * st.size));
    /* ページを動かす：DB はサーバーへ取りに行き、サンプルは手元で切る */
    function go() { if (remote()) DM.data.load({ page: st.page, size: st.size }); else render(); }

    function compute() {
      const lot = DM.lotColumn(DM.store.columns);
      if (remote()) { st.view = DM.store.rows; st.lot = lot; st.filterCount = DM.queryState.filters.length; return; }
      const res = DM.runQuery(DM.store.rows, DM.store.columns, DM.queryState, lot);
      st.view = res.rows; st.lot = lot; st.filterCount = res.filterCount;
      const pages = Math.max(1, Math.ceil(st.view.length / st.size));
      if (st.page > pages) st.page = pages;
    }

    function render() {
      compute();
      const s = DM.store, cols = DM.view.columns(), h = hints();
      const total = s.rows.length, n = st.view.length;
      if (remote() && s.error && !s.rows.length) { wrap.innerHTML = `<div class="state state--error"><i class="fa-solid fa-circle-exclamation"></i><strong>品質データを読み込めませんでした</strong><span>${DM.esc(s.error.message)}</span><div class="row" style="flex:none"><button class="btn" data-retry><i class="fa-solid fa-rotate"></i>もう一度読み込む</button><button class="btn" data-open-data><i class="fa-solid fa-database"></i>「データ」を開く</button></div></div>`; status(); return; }
      if (!s.hasData()) { wrap.innerHTML = opts.emptyHtml || `<div class="state"><i class="fa-regular fa-folder-open"></i><strong>まだデータを読み込んでいません</strong><span>まずはサンプルで動きを確かめられます。DB の読み込みは左の「データ」から行います。</span><button class="btn" data-load-sample><i class="fa-solid fa-flask"></i>サンプル（標準）を読み込む</button></div>`; status(); return; }
      if (!n) { wrap.innerHTML = `<div class="state"><i class="fa-solid fa-magnifying-glass"></i><strong>条件に一致するロットは 0 件です</strong><span>検索語や条件を変えてください。${remote() ? "" : `（全 ${DM.fmtNum(total)} 件）`}</span><button class="btn" data-reset-all><i class="fa-solid fa-eraser"></i>検索・条件をすべて外す</button></div>`; status(); return; }
      const slice = pageRows();
      const allSel = slice.length && slice.every((r) => s.selected.has(r._id));
      const q = DM.norm(DM.queryState.search.trim());
      const sortOf = (c) => { const i = DM.queryState.sorts.findIndex((x) => x.column === c); return i < 0 ? null : { i, dir: DM.queryState.sorts[i].dir }; };
      const th = cols.map((c) => { const so = sortOf(c), num = st.numeric.has(c);
        const mark = h && h.req.has(c) ? `<i class="fa-solid fa-asterisk" title="この帳票で必須の項目" style="color:var(--color-step2);font-size:.7em"></i> ` : "";
        return `<th class="${num ? "num" : ""}" data-col="${DM.esc(c)}" style="width:${widthOf(c)}px" title="クリックで並べ替え（Shift＋クリックで複数）" aria-sort="${so ? (so.dir === "asc" ? "ascending" : "descending") : "none"}">${mark}${DM.esc(c)}${so ? `<span class="sort"><i class="fa-solid fa-arrow-${so.dir === "asc" ? "up" : "down"}"></i>${DM.queryState.sorts.length > 1 ? so.i + 1 : ""}</span>` : ""}<span class="resize" data-resize="${DM.esc(c)}" title="ドラッグで幅を変更／ダブルクリックで初期幅"></span></th>`; }).join("");
      let prevKey = null, body = "";
      slice.forEach((r, ix) => {
        const sel = s.selected.has(r._id);
        if (DM.queryState.group && st.lot && remote()) { const g = s.groups && s.groups[ix]; if (g && g[1] === 1 && !DM.isEmpty(r[st.lot])) body += `<tr class="group-head"><td colspan="${cols.length + 1}"><i class="fa-solid fa-layer-group"></i> ロット ${DM.esc(r[st.lot])}（${g[0]} 行）</td></tr>`; }
        else if (DM.queryState.group && st.lot) { const k = DM.norm(r[st.lot]).trim(); if (k && k !== prevKey) { const cnt = st.view.filter((x) => DM.norm(x[st.lot]).trim() === k).length; body += `<tr class="group-head"><td colspan="${cols.length + 1}"><i class="fa-solid fa-layer-group"></i> ロット ${DM.esc(r[st.lot])}（${cnt} 行）</td></tr>`; } prevKey = k; }
        const tds = cols.map((c) => {
          let v = r[c] == null ? "" : String(r[c]); const miss = h && h.req.has(c) && DM.isEmpty(v);
          let shown = st.numeric.has(c) && !DM.isEmpty(v) ? DM.fmtNum(String(v).replace(/,/g, "")) : DM.esc(v);
          if (q && !DM.isEmpty(v) && DM.norm(v).includes(q) && !st.numeric.has(c)) shown = `<span class="hl">${shown}</span>`;
          if (miss) shown = `<i class="fa-solid fa-triangle-exclamation"></i> 未入力`;
          return `<td class="${st.numeric.has(c) ? "num" : ""}${miss ? " is-missing" : ""}${h && h.used.has(c) && !miss ? " is-used" : ""}" title="${DM.esc(v)}">${shown}</td>`;
        }).join("");
        body += `<tr tabindex="-1" data-id="${DM.esc(r._id)}" class="${sel ? "is-selected" : ""}" aria-selected="${sel}"><td class="col-check"><input type="checkbox" class="check" ${sel ? "checked" : ""} aria-label="ロット ${DM.esc(r[st.lot] || "")} を選ぶ"></td>${tds}</tr>`;
      });
      const total_w = 40 + cols.reduce((a, c) => a + widthOf(c), 0);
      wrap.innerHTML = `<table class="grid" style="width:${total_w}px"><colgroup><col style="width:40px">${cols.map((c) => `<col style="width:${widthOf(c)}px">`).join("")}</colgroup>
        <thead><tr><th class="col-check"><input type="checkbox" class="check" data-all ${allSel ? "checked" : ""} aria-label="表示中をすべて選ぶ" title="表示中の行をすべて選ぶ／外す"></th>${th}</tr></thead><tbody>${body}</tbody></table>`;
      const f = rowEl(st.focusId); if (f) f.tabIndex = 0; else { const t = wrap.querySelector("tbody tr[data-id]"); if (t) t.tabIndex = 0; }
      status();
    }

    const ago = (h) => (h < 1 ? "1時間以内" : h < 48 ? `${Math.round(h)}時間前` : `${Math.round(h / 24)}日前`);
    function sourceHtml(s) {
      if (!remote()) { const sample = s.sampleCount(); return `<span><i class="fa-solid fa-database"></i> ${DM.esc(s.source.label)}${sample ? ` <span class="tag tag--sample"><i class="fa-solid fa-flask"></i>サンプル ${DM.fmtNum(sample)} 行</span>` : ""}</span>`; }
      const i = s.sourceInfo || {}, tags = [];
      if (s.loading) tags.push(`<span class="tag tag--info"><i class="fa-solid fa-spinner fa-spin"></i>読み込み中… ${Math.max(0, Math.round((Date.now() - (DM.data.since || Date.now())) / 1000))} 秒</span>`);
      if (s.error) tags.push(`<span class="tag tag--error" title="${DM.esc(s.error.message)}"><i class="fa-solid fa-circle-exclamation"></i>読み込み失敗</span>`);
      if (i.unreachable) tags.push(`<span class="tag tag--warn" title="${DM.esc(i.reason || "")}"><i class="fa-solid fa-plug-circle-exclamation"></i>共有に届きません（前の写しを表示中）</span>`);
      if (i.stale) tags.push(`<span class="tag tag--warn" title="元ファイルが ${i.staleHours} 時間より長く更新されていません"><i class="fa-solid fa-clock"></i>データが古い（${ago(i.ageHours)}）</span>`);
      return `<span title="${DM.esc(i.remote || "")}"><i class="fa-solid fa-database"></i> ${DM.esc(s.source.label)}${i.at ? `　更新 ${new Date(i.at * 1000).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : ""}</span>${tags.join(" ")}<button class="btn" data-refresh title="共有から取り直す"><i class="fa-solid fa-rotate"></i>再読込</button>`;
    }
    function status() {
      if (!opts.statusEl) return;
      const s = DM.store, n = remote() ? s.total : st.view.length, pages = Math.max(1, Math.ceil(n / st.size));
      const from = remote() ? s.range[0] : (n ? (st.page - 1) * st.size + 1 : 0), to = remote() ? s.range[1] : Math.min(n, st.page * st.size);
      const filtering = st.filterCount || DM.queryState.search;
      opts.statusEl.innerHTML = `
        ${sourceHtml(s)}
        <span><b>${DM.fmtNum(n)}</b> 件${filtering ? (remote() ? "（絞り込み中）" : `（全 ${DM.fmtNum(s.rows.length)} 件中・絞り込み中）`) : ""}</span>
        <span>選択 <b>${DM.fmtNum(s.selected.size)}</b> 件</span><span class="spacer"></span>
        ${DM.store.columns.length && DM.lotColumn(DM.store.columns) ? `<label title="同じロット番号の行を続けて並べます"><input type="checkbox" class="check" data-group ${DM.queryState.group ? "checked" : ""}> ロットでまとめる</label>` : ""}
        <span class="pager"><select class="select" data-size style="height:22px;font-size:inherit" aria-label="1ページの件数">${PAGE_SIZES.map((z) => `<option ${z === st.size ? "selected" : ""} value="${z}">${z}件/ページ</option>`).join("")}</select>
        <button class="btn" data-pg="-1" ${st.page <= 1 || s.loading ? "disabled" : ""} aria-label="前のページ"><i class="fa-solid fa-chevron-left"></i></button>
        <span>${DM.fmtNum(from)}–${DM.fmtNum(to)}　${st.page} / ${pages}</span>
        <button class="btn" data-pg="1" ${st.page >= pages || s.loading ? "disabled" : ""} aria-label="次のページ"><i class="fa-solid fa-chevron-right"></i></button></span>`;
    }

    /* 選択 */
    function pick(id, e) {
      const s = DM.store, ids = pageRows().map((r) => r._id);
      if (e.shiftKey && st.anchor != null && ids.includes(st.anchor)) { const a = ids.indexOf(st.anchor), b = ids.indexOf(id); s.setSelected(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); }
      else if (e.ctrlKey || e.metaKey || e.target.matches("input.check")) { const n = new Set(s.selected); n.has(id) ? n.delete(id) : n.add(id); s.setSelected(n); st.anchor = id; }
      else { s.setSelected([id]); st.anchor = id; }
      st.focusId = id;
    }
    wrap.addEventListener("click", (e) => {
      if (e.target.closest("[data-load-sample]")) { const c = DM.sampleLoad("standard"); DM.toast(`サンプル ${DM.fmtNum(c)} 行を読み込みました`, { icon: "fa-flask" }); return; }
      if (e.target.closest("[data-retry]")) { DM.data.connect(); return; }
      if (e.target.closest("[data-open-data]")) { const b = document.querySelector('.rail-btn[data-id="data"]'); if (b && b.getAttribute("aria-pressed") !== "true") b.click(); return; }
      if (e.target.closest("[data-reset-all]")) { DM.queryState.search = ""; DM.queryState.filters = []; DM.queryState.sorts = []; DM.bus.emit("query"); DM.bus.emit("filters-external"); return; }
      if (e.target.closest("[data-resize]")) return;
      if (e.target.matches("[data-all]")) { const slice = pageRows(), n = new Set(DM.store.selected); const all = slice.every((r) => n.has(r._id)); slice.forEach((r) => (all ? n.delete(r._id) : n.add(r._id))); DM.store.setSelected(n); return; }
      const th = e.target.closest("th[data-col]");
      if (th) { const c = th.dataset.col, sorts = DM.queryState.sorts, i = sorts.findIndex((x) => x.column === c);
        let next = e.shiftKey ? sorts.slice() : (i >= 0 ? sorts.filter((x) => x.column === c) : []);
        const cur = next.find((x) => x.column === c);
        if (!cur) next.push({ column: c, dir: "asc" }); else if (cur.dir === "asc") cur.dir = "desc"; else next = next.filter((x) => x.column !== c);
        DM.setQuery({ sorts: next.slice(0, 4) }); return; }
      const tr = e.target.closest("tr[data-id]"); if (tr) pick(pid(tr.dataset.id), e);
    });
    wrap.addEventListener("dblclick", (e) => {
      const rz = e.target.closest("[data-resize]"); if (rz) { delete DM.view.widths[rz.dataset.resize]; DM.bus.emit("view"); return; }
      const tr = e.target.closest("tr[data-id]"); if (tr && opts.onEnter) { DM.store.setSelected([pid(tr.dataset.id)]); opts.onEnter(DM.store.byId(pid(tr.dataset.id))); }
    });
    wrap.addEventListener("pointerdown", (e) => {                 // 列幅の手動変更
      const rz = e.target.closest("[data-resize]"); if (!rz) return; e.preventDefault(); e.stopPropagation();
      const c = rz.dataset.resize, x0 = e.clientX, w0 = widthOf(c);
      const mv = (ev) => { DM.view.widths[c] = Math.max(48, Math.round(w0 + ev.clientX - x0)); const i = DM.view.columns().indexOf(c) + 1; const col = wrap.querySelector(`colgroup col:nth-child(${i + 1})`); if (col) col.style.width = DM.view.widths[c] + "px"; const t = wrap.querySelector("table"); if (t) t.style.width = 40 + DM.view.columns().reduce((a, k) => a + widthOf(k), 0) + "px"; };
      const up = () => { document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", up); DM.bus.emit("view"); };   // 幅を変えた → 保存・再描画
      document.addEventListener("pointermove", mv); document.addEventListener("pointerup", up);
    });
    wrap.addEventListener("keydown", (e) => {
      const tr = e.target.closest && e.target.closest("tr[data-id]"); if (!tr) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const rows = Array.from(wrap.querySelectorAll("tbody tr[data-id]")), i = rows.indexOf(tr) + (e.key === "ArrowDown" ? 1 : -1); if (rows[i]) { tr.tabIndex = -1; rows[i].tabIndex = 0; rows[i].focus(); st.focusId = pid(rows[i].dataset.id); if (e.shiftKey) pick(pid(rows[i].dataset.id), { shiftKey: true, target: rows[i] }); } }
      else if (e.key === " ") { e.preventDefault(); pick(pid(tr.dataset.id), { ctrlKey: true, target: tr }); setTimeout(() => { const t = rowEl(tr.dataset.id); if (t) { t.tabIndex = 0; t.focus(); } }, 0); }
      else if (e.key === "Enter" && opts.onEnter) { e.preventDefault(); opts.onEnter(DM.store.byId(pid(tr.dataset.id))); }
    });
    if (opts.statusEl) {
      opts.statusEl.addEventListener("click", (e) => { const b = e.target.closest("[data-pg]"); if (b) { st.page += +b.dataset.pg; go(); return; } if (e.target.closest("[data-refresh]")) DM.data.refresh(); });
      opts.statusEl.addEventListener("change", (e) => {
        if (e.target.matches("[data-size]")) { st.size = +e.target.value; st.page = 1; DM.safeStorage.set("dm.pageSize", st.size); go(); }
        if (e.target.matches("[data-group]")) DM.setQuery({ group: e.target.checked });
      });
    }

    /* 再描画の契機（選択だけが変わったときはスクロールを保つ） */
    const keep = (fn) => () => { const t = wrap.scrollTop, l = wrap.scrollLeft; fn(); wrap.scrollTop = t; wrap.scrollLeft = l; const f = rowEl(st.focusId); if (f && wrap.contains(document.activeElement)) f.focus(); };
    DM.bus.on("data", () => { st.page = 1; measure(); render(); });
    DM.bus.on("view", () => keep(render)());               // 列の表示・並び・幅が変わった
    DM.bus.on("query", () => { st.page = 1; if (remote()) { if (DM.store.hasData() || DM.store.error) DM.data.load({ page: 1, size: st.size }); } else keep(render)(); });
    DM.bus.on("page", keep(render));                       // DB：ページ・結果が届いた
    DM.bus.on("loading", () => { wrap.classList.toggle("is-loading", DM.store.loading); status(); });
    setInterval(() => { if (DM.store.loading) status(); }, 1000);   // 経過秒の更新
    DM.bus.on("selection", keep(render));
    DM.bus.on("form", keep(render));
    DM.bus.on("density", () => { requestAnimationFrame(() => { measure(); render(); }); });
    self.resetWidths = () => { DM.view.set({ widths: {} }); };
    self.visibleRows = () => st.view;
    self.pageSize = () => st.size;
    self.refresh = () => { measure(); render(); };
    measure(); render();
  };
})();
