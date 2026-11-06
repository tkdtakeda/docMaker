/* ── data-source: 品質データ（SQLite）をサーバーから引く ──────────
   画面は検索・絞り込み・並べ替え・ページを「条件」としてサーバーへ渡し、1 ページぶんだけ受け取る（DB が大きくても重くならない）。
   サーバーへ届かないとき・読めないときは、理由と次の操作を表に出す（§1-17）。
   サンプル（local）と DB（remote）は同時には出さない。サンプルを読むと DB の表示をやめ、サンプルを消すと DB へ戻る。 */
(function () {
  "use strict";
  const DM = window.DM;
  const online = /^https?:$/.test(location.protocol);
  let seq = 0;
  const JSON_H = { "Content-Type": "application/json" };

  async function j(url, opt) {
    const r = await fetch(url, opt);
    let body = null;
    try { body = await r.json(); } catch (e) { /* JSON でない応答 */ }
    if (!r.ok) { const err = new Error((body && body.error) || `サーバーの応答が正しくありません（${r.status}）`); err.body = body; throw err; }
    return body;
  }
  /* DB の行には主キーが無いので、行の内容から id を作る（まったく同じ内容の行は 1 件として扱う） */
  const rowId = (row, cols) => "r:" + cols.map((c) => (row[c] == null ? "" : String(row[c]))).join("\u0001");

  DM.data = {
    online, settings: { source: "", table: "", page_size: 200 }, since: 0,

    /* 起動時：設定を読み、元ファイルが決まっていれば自動で読み込む */
    async init() {
      if (!online) return;
      try { await this.loadSettings(); } catch (e) { return; }
      if (this.settings.source) await this.connect();
    },
    async loadSettings() {
      const r = await j("api/settings");
      this.settings = Object.assign(this.settings, r.lot_list);
      DM.bus.emit("datasettings");
      return this.settings;
    },
    async saveSettings(patch) {
      const r = await j("api/settings", { method: "POST", headers: JSON_H, body: JSON.stringify({ lot_list: patch }) });
      this.settings = Object.assign(this.settings, r.lot_list);
      DM.bus.emit("datasettings");
      return this.settings;
    },

    /* DB を表示する状態にして、最初のページを引く */
    async connect() {
      const s = DM.store;
      s.mode = "remote"; s.connected = false; s.error = null; s.rows = []; s.columns = []; s.total = 0; s.range = [0, 0]; s.groups = null;
      s.selected = new Set(); s.rowCache = new Map();
      s.source = { kind: "db", label: "品質データ（読み込み中）", at: null };
      DM.bus.emit("selection");
      return this.load({ page: 1, first: true });
    },
    /* サンプルから DB へ戻る（設定があるときだけ） */
    reconnectIfConfigured() { if (online && this.settings.source && DM.store.mode !== "remote") return this.connect(); },

    query(page, size) {
      const q = DM.queryState;
      const filters = q.filters.filter((f) => f.column && DM.ops.get(f.op) && (!DM.ops.get(f.op).needsValue || !DM.isEmpty(f.value)));
      const p = new URLSearchParams({ page: String(page), page_size: String(size), search: q.search || "", filters: JSON.stringify(filters), sorts: JSON.stringify(q.sorts || []) });
      if (q.group) p.set("group", "1");
      return "api/lotlist?" + p.toString();
    },

    async load(o) {
      o = o || {};
      const s = DM.store, my = ++seq;                        // 古い問い合わせの答えは捨てる（連続入力のため）
      const size = o.size || +DM.safeStorage.get("dm.pageSize", 200), page = o.page || 1;
      s.loading = true; this.since = Date.now(); DM.bus.emit("loading");
      try {
        const r = await j(this.query(page, size));
        if (my !== seq || s.mode !== "remote") return;      // その間にサンプルへ切り替わっていたら捨てる
        const newCols = JSON.stringify(r.columns) !== JSON.stringify(s.columns);
        s.mode = "remote"; s.connected = true; s.error = null;
        s.columns = r.columns; s.total = r.count; s.range = r.range || [0, 0]; s.groups = r.groups || null;
        s.dateColumns = r.dateColumns || []; s.lotColumn = r.lotColumn || ""; s.sourceInfo = r.source || null;
        s.rows = r.rows.map((row) => Object.assign({ _id: rowId(row, r.columns) }, row));
        s.source = { kind: "db", label: `品質データ（${r.table}）`, at: r.source && r.source.at };
        s.loading = false;
        DM.bus.emit(o.first || newCols ? "data" : "page");
        if (!(o.first || newCols)) DM.bus.emit("page");
        DM.bus.emit("selection");
      } catch (e) {
        if (my !== seq) return;
        s.loading = false;
        s.error = { message: e.message || "読み込めませんでした", source: e.body && e.body.source };
        if (e.body && e.body.source) s.sourceInfo = e.body.source;
        DM.bus.emit("page");
        if (s.rows.length) DM.toast("読み込めませんでした：" + s.error.message, { icon: "fa-circle-exclamation" });
      }
    },

    /* 「再読込」：共有から取り直す（変わっていなくても写し直す）。結果を文字で知らせる */
    async refresh() {
      if (DM.store.mode !== "remote") return;
      DM.store.loading = true; this.since = Date.now(); DM.bus.emit("loading");
      try {
        const r = await j("api/lotlist/refresh", { method: "POST" });
        const res = r.result || {};
        DM.toast(res.updated ? "品質データを最新に更新しました" : (res.reason || "更新を確認しました"), { icon: res.unreachable ? "fa-plug-circle-exclamation" : "fa-rotate" });
      } catch (e) { DM.toast("再読込できませんでした：" + e.message, { icon: "fa-circle-exclamation" }); }
      DM.store.loading = false;
      return this.load({ page: 1 });
    },
  };
})();
