/* ── report-bridge: 帳票（CDB の帳票部品）との受け渡し ──────────────
   帳票の画面は web/report.html を iframe で開く（CDB の CSS・JS を docMaker と分けるため）。
   - 登録済みの帳票（サーバーの共有フォルダ）を、トレーの帳票の一覧（DM.forms）にする
   - ③：選んだロットの「全行」を集めて（DB はサーバーから取り直す）、帳票の画面を出力イメージで開く
   - 帳票の作成・直し：左の「帳票」から、同じ画面を作成の状態で開く
   データの渡し方（CDB の形への読み替え）：1 枚＝同じロット番号の行のまとまり。列はすべて「板の側（p:列名）」にし、
   表の外のセルは、そのロットの行で値が 1 つならその値（違う値があれば空欄。CDB と同じ）、板の表はロットの行ごとに繰り返す。
   サーバーにつながらないとき（file://）は何もしない（仮の帳票とプレビューで動く）。 */
(function () {
  "use strict";
  const DM = window.DM;
  const online = /^https?:$/.test(location.protocol);
  const LAST = "cdb.report.last";          // 帳票の画面が最後に開いた帳票（iframe と同じ保存先）
  let frame = null, ctx = null, reloadT = null;

  const j = async (url, opt) => {
    const r = await fetch(url, opt);
    let b = null; try { b = await r.json(); } catch (e) { /* JSON でない */ }
    if (!r.ok) throw new Error((b && b.error) || `サーバーの応答が正しくありません（${r.status}）`);
    return b;
  };

  /* ── 登録済みの帳票 → トレーの一覧（DM.forms）。必須＝「空欄の置き換え」が無い列の項目 ── */
  const colOf = (it) => String(it.col || "").replace(/^[mp]:/, "");
  function formOf(p) {
    const fields = (p.items || []).filter((it) => it.kind === "field" && it.col)
      .map((it) => ({ key: it.id, label: it.label || colOf(it), cols: [colOf(it)], required: it.blank === undefined || it.blank === null || it.blank === "" }));
    return { id: p.id, name: p.name || "（名前なし）", icon: p.blocks || p.doc ? "fa-file-pen" : "fa-file-excel",
      desc: (p.sample ? "サンプル・" : "") + (p.blocks || p.doc ? "ツールで作った帳票" : "Excel のひな形の帳票"), fields, sample: !!p.sample, preset: true };
  }
  DM.reports = {
    online, list: [], loaded: false, error: "",
    async load() {
      if (!online) return;
      try {
        const r = await j("api/reports/reports");
        this.list = r.items || []; this.dir = r.dir; this.error = ""; this.loaded = true;
        DM.forms.clear();
        this.list.sort((a, b) => (a.sample === b.sample ? String(a.name).localeCompare(String(b.name), "ja") : a.sample ? 1 : -1)).forEach((p) => DM.forms.register(formOf(p)));
        if (DM.store.formId && !DM.forms.get(DM.store.formId)) DM.store.formId = "";
      } catch (e) { this.error = e.message; }
      DM.bus.emit("form");
    },
    soon() { clearTimeout(reloadT); reloadT = setTimeout(() => this.load(), 300); },
    /* サンプルの帳票だけを消す（「元に戻す」で戻せる） */
    async clearSamples() {
      if (!online) return null;
      const saved = {};
      for (const st of ["reports", "templates"]) {
        const items = ((await j("api/reports/" + st)).items || []).filter((x) => x.sample);
        saved[st] = items;
        if (items.length) await j(`api/reports/${st}/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: items.map((x) => x.id) }) });
      }
      this.load();
      const n = saved.reports.length;
      return { count: n, undo: async () => { for (const st of ["templates", "reports"]) for (const x of saved[st]) await j(`api/reports/${st}/${encodeURIComponent(x.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(x) }); this.load(); } };
    },
  };

  /* ── 選んだロットの全行を集める（1 枚＝同じロット番号の行のまとまり） ── */
  const lotKey = (v) => DM.norm(v).trim();
  async function rowsOfSelection() {
    const s = DM.store, cols = s.columns.slice(), lot = DM.lotColumn(cols), sel = s.selectedRows();
    if (!lot) return { columns: cols, lot: "", rows: sel };
    const keys = []; sel.forEach((r) => { const k = lotKey(r[lot]); if (k && !keys.includes(k)) keys.push(k); });
    const lone = sel.filter((r) => !lotKey(r[lot]));           // ロット番号が空の行は、その行だけで 1 枚
    if (s.mode === "remote") {
      const r = await j("api/lotlist/lots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lots: sel.map((x) => x[lot]).filter((v) => lotKey(v)) }) });
      return { columns: r.columns, lot: r.lotColumn, rows: r.rows.concat(lone) };
    }
    const set = new Set(keys);
    return { columns: cols, lot, rows: s.rows.filter((r) => set.has(lotKey(r[lot]))).concat(lone) };
  }

  /* ── CDB の帳票部品が読む形にする ── */
  function toCtx(data, mode) {
    const cols = data.columns.filter((c) => !String(c).startsWith("_"));
    const masters = new Map();
    const rows = data.rows.map((r, i) => {
      const lv = data.lot ? r[data.lot] : "";
      const key = data.lot && lotKey(lv) ? "lot:" + lotKey(lv) : "row:" + i;
      if (!masters.has(key)) masters.set(key, { id: key, lot: lv == null ? "" : String(lv) });
      const v = {}; cols.forEach((c) => { v["p:" + c] = r[c] == null ? "" : r[c]; });
      return { id: i + 1, mid: key, gkey: key, status: "linked", v, raw: v };
    });
    return {
      mode,
      getColumns: () => cols.map((c) => ({ id: "p:" + c, label: c, side: "plate" })),
      getViewRows: () => rows,
      getMasters: () => Array.from(masters.values()),
    };
  }

  function mountFrame(query) {
    close();
    frame = document.createElement("div");
    frame.className = "report-frame";
    frame.innerHTML = `<iframe src="report.html${query || ""}" title="帳票"></iframe><div class="report-frame__wait"><i class="fa-solid fa-spinner fa-spin"></i> 帳票の画面を開いています…</div>`;
    document.body.appendChild(frame);
    frame.querySelector("iframe").focus();
  }
  function close() {
    if (frame) { frame.remove(); frame = null; }
    ctx = null;
  }

  DM.reportBridge = {
    online,
    ctx: () => ctx,
    opened() { if (frame) { const w = frame.querySelector(".report-frame__wait"); if (w) w.remove(); } },
    close() { close(); DM.reports.load(); },
    changed() { DM.reports.soon(); },
    /* ③ 確認して印刷：選んだロットの全行で、選んだ帳票を出力イメージで開く */
    async openOutput() {
      const n = DM.store.selected.size;
      if (!n) return;
      DM.toast(`${DM.fmtNum(n)} 件のロットの行を集めています…`, { icon: "fa-spinner" });
      let data;
      try { data = await rowsOfSelection(); } catch (e) { DM.toast("ロットの行を読めませんでした：" + e.message, { icon: "fa-circle-exclamation" }); return; }
      try { localStorage.setItem(LAST, DM.store.formId); } catch (e) { /* 前回の帳票のまま開く */ }
      mountFrame();
      ctx = toCtx(data, "output");
    },
    /* 帳票を作る・直す：選んだロット（無ければ表の先頭の行）を見本のデータにして開く */
    async openDesign(opts) {
      opts = opts || {};
      let data = { columns: DM.store.columns.slice(), lot: DM.lotColumn(DM.store.columns), rows: [] };
      try {
        if (DM.store.selected.size) data = await rowsOfSelection();
        else if (DM.store.rows.length) data.rows = DM.store.rows.slice(0, 1);
      } catch (e) { DM.toast("見本のデータを読めませんでした（データなしで開きます）：" + e.message, { icon: "fa-circle-exclamation" }); }
      if (DM.store.formId) try { localStorage.setItem(LAST, DM.store.formId); } catch (e) { /* 前回のまま */ }
      mountFrame(opts.samples ? "?samples=1" : "");
      ctx = toCtx(data, "design");
    },
  };
  /* ③ の入口：サーバーで開いていれば帳票の画面、file:// なら仮のプレビュー */
  DM.openOutput = () => (online && DM.forms.get(DM.store.formId) && DM.forms.get(DM.store.formId).preset ? DM.reportBridge.openOutput() : DM.openPreview());
})();
