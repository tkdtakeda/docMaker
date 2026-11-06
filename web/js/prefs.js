/* ── prefs: 設定の自動保存と作業セット（基本設計 §8）────────────────
   - 自動保存：条件・並べ替え・ロットでまとめる・列（表示・並び）・列幅を、ブラウザに自動で保存する。
     「列の構成」（列の名前の並び）ごとに覚え、同じ構成の表を読み込んだら自動で当てはめる（毎月差し替える表でもそのまま使える）。
     検索欄の文字はその場限りの操作なので覚えない。
   - 作業セット：設定一式に名前を付けて保存・切り替え。JSON に書き出し・読み込み（ほかの PC へ渡せる）。
   - 上限：保存の量・数に上限を決め、超えるときは理由を知らせて保存しない（§1-4）。古い表の自動保存は、数の上限を超えたら古い順に忘れる。
   - 帳票の選択（どの帳票を選んでいたか）も覚える。
   保存先は localStorage（PC・ブラウザごと）。読めない・保存できない環境でも、画面はそのまま動く。 */
(function () {
  "use strict";
  const DM = window.DM;
  const KEY = "dm.prefs.v1";
  const LIMIT = 1000 * 1000;        // 保存する量の上限（文字数。localStorage は 5MB 前後なので余裕を持たせる）
  const MAX_TABLES = 30;            // 自動保存で覚える表（列の構成）の数
  const MAX_SETS = 50;              // 作業セットの数
  const MAX_NAME = 40;
  const FORMAT = { app: "docMaker", kind: "作業セット", version: 1 };

  let data = { byCols: {}, sets: [] }, sig = "", applying = 0, timer = null, warned = false;

  /* ── 読み書き ── */
  function read() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || "null");
      if (d && typeof d === "object") data = { byCols: d.byCols && typeof d.byCols === "object" ? d.byCols : {}, sets: Array.isArray(d.sets) ? d.sets : [] };
    } catch (e) { /* 読めなければ空から */ }
  }
  function write() {
    const raw = JSON.stringify(data);
    if (raw.length > LIMIT) return { ok: false, reason: `保存できる量（${DM.fmtNum(Math.round(LIMIT / 1000))} KB）を超えます。使わない作業セットを消してください` };
    try { localStorage.setItem(KEY, raw); return { ok: true }; } catch (e) { return { ok: false, reason: "ブラウザに保存できませんでした（容量がいっぱい、または保存が禁止されています）" }; }
  }
  const usage = () => { try { return (localStorage.getItem(KEY) || "").length; } catch (e) { return 0; } };

  /* 列の構成の印（列の名前の並びから作る） */
  function sigOf(cols) {
    if (!cols.length) return "";
    let h = 5381; const s = cols.join("\u0001");
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36) + ":" + cols.length;
  }

  /* ── 設定一式を取り出す・当てはめる ── */
  function snapshot() {
    const q = DM.queryState;
    return {
      filters: q.filters.filter((f) => f.column).map((f) => ({ column: f.column, op: f.op, value: f.value })),
      sorts: q.sorts.map((s) => ({ column: s.column, dir: s.dir })),
      group: !!q.group,
      hidden: Array.from(DM.view.hidden), order: DM.view.order.slice(), widths: Object.assign({}, DM.view.widths),
    };
  }
  /** 当てはめる。この表に無い列の条件・並べ替えは外し、その数を返す（黙って捨てない §1-6） */
  function apply(state) {
    const cols = new Set(DM.store.columns), st = state || {};
    const fl = (st.filters || []).filter((f) => f && typeof f.column === "string" && DM.ops.get(f.op));
    const so = (st.sorts || []).filter((s) => s && typeof s.column === "string");
    const filters = fl.filter((f) => cols.has(f.column)), sorts = so.filter((s) => cols.has(s.column)).slice(0, 4);
    applying++;
    try {
      DM.queryState.filters = filters.map((f) => ({ column: f.column, op: f.op, value: String(f.value == null ? "" : f.value) }));
      DM.queryState.sorts = sorts.map((s) => ({ column: s.column, dir: s.dir === "desc" ? "desc" : "asc" }));
      DM.queryState.group = !!st.group;
      DM.view.set({ hidden: (st.hidden || []).filter((c) => typeof c === "string"), order: (st.order || []).filter((c) => typeof c === "string"), widths: st.widths && typeof st.widths === "object" ? st.widths : {} }, true);
      if (!DM.view.columns().length) DM.view.set({ hidden: [] }, true);      // 全部隠れることは無いようにする
      DM.bus.emit("view"); DM.bus.emit("filters-external"); DM.bus.emit("query");
    } finally { applying--; }
    return { filters: filters.length, sorts: sorts.length, hidden: DM.view.hidden.size, group: !!st.group, dropped: fl.length - filters.length + so.length - sorts.length };
  }
  const summary = (r) => [r.filters ? `条件 ${r.filters}` : "", r.sorts ? `並べ替え ${r.sorts}` : "", r.hidden ? `隠した列 ${r.hidden}` : "", r.group ? "ロットでまとめる" : ""].filter(Boolean).join("・") || "初期の表示";
  const describe = (st) => summary({ filters: (st.filters || []).length, sorts: (st.sorts || []).length, hidden: (st.hidden || []).length, group: !!st.group });

  /* ── 自動保存（列の構成ごと） ── */
  function autosave() {
    if (applying || !sig) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      data.byCols[sig] = { state: snapshot(), at: Date.now(), cols: DM.store.columns.slice(0, 60) };
      const keys = Object.keys(data.byCols);
      if (keys.length > MAX_TABLES) keys.sort((a, b) => data.byCols[a].at - data.byCols[b].at).slice(0, keys.length - MAX_TABLES).forEach((k) => delete data.byCols[k]);
      const r = write();
      if (!r.ok && !warned) { warned = true; DM.toast("設定を自動保存できません：" + r.reason, { icon: "fa-triangle-exclamation" }); }
      if (r.ok) warned = false;
      DM.bus.emit("prefs");
    }, 400);
  }
  /* 新しい表（列の構成が変わった）を読み込んだら、前回の設定を当てはめる */
  function onData() {
    const s = sigOf(DM.store.columns);
    if (s === sig) return;
    sig = s;
    const saved = s && data.byCols[s];
    if (!saved) { DM.bus.emit("prefs"); return; }
    const prev = snapshot();
    const r = apply(saved.state);
    if (r.filters || r.sorts || r.hidden || r.group || Object.keys(DM.view.widths).length)
      DM.toast(`この表の前回の設定を当てはめました（${summary(r)}）`, { icon: "fa-clock-rotate-left", undo: () => apply(prev) });
    DM.bus.emit("prefs");
  }

  /* ── 作業セット ── */
  const findSet = (id) => data.sets.find((x) => x.id === id);
  const cleanName = (n) => String(n == null ? "" : n).replace(/[\u0000-\u001f]/g, "").trim().slice(0, MAX_NAME);
  const uid = () => "ws_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const commit = (rollback) => { const r = write(); if (!r.ok) { rollback(); DM.toast("保存できませんでした：" + r.reason, { icon: "fa-triangle-exclamation" }); } DM.bus.emit("prefs"); return r.ok; };

  DM.prefs = {
    LIMIT, MAX_SETS, MAX_NAME, usage, describe,
    sets: () => data.sets.slice(),
    tableCount: () => Object.keys(data.byCols).length,
    hasAuto: () => !!(sig && data.byCols[sig]),
    /** 名前を付けて保存。同じ名前があれば上書き（元に戻せる） */
    saveSet(name) {
      const n = cleanName(name);
      if (!n) return { ok: false, reason: "名前を入れてください" };
      const same = data.sets.find((x) => x.name === n);
      if (!same && data.sets.length >= MAX_SETS) return { ok: false, reason: `作業セットは ${MAX_SETS} 件までです。使わないものを消してください` };
      const before = data.sets.map((x) => Object.assign({}, x));
      const rec = { id: same ? same.id : uid(), name: n, state: snapshot(), at: Date.now(), cols: DM.store.columns.slice(0, 60) };
      if (same) Object.assign(same, rec); else data.sets.push(rec);
      const ok = commit(() => { data.sets = before; });
      return ok ? { ok: true, overwrote: !!same, undo: () => { data.sets = before; commit(() => {}); } } : { ok: false, reason: "" };
    },
    applySet(id) {
      const s = findSet(id); if (!s) return null;
      const prev = snapshot(), r = apply(s.state);
      return Object.assign(r, { name: s.name, text: summary(r), undo: () => apply(prev) });
    },
    renameSet(id, name) {
      const s = findSet(id), n = cleanName(name); if (!s) return { ok: false, reason: "見つかりません" };
      if (!n) return { ok: false, reason: "名前を入れてください" };
      if (data.sets.some((x) => x.id !== id && x.name === n)) return { ok: false, reason: `「${n}」はもうあります` };
      const old = s.name; s.name = n;
      return { ok: commit(() => { s.name = old; }) };
    },
    removeSet(id) {
      const i = data.sets.findIndex((x) => x.id === id); if (i < 0) return null;
      const [rm] = data.sets.splice(i, 1);
      commit(() => data.sets.splice(i, 0, rm));
      return { name: rm.name, undo: () => { data.sets.splice(i, 0, rm); commit(() => {}); } };
    },
    /** この表の自動保存を消す（初期の表示に戻すかは呼び出し側） */
    clearAuto() {
      if (!sig || !data.byCols[sig]) return null;
      const rec = data.byCols[sig], k = sig; delete data.byCols[k];
      commit(() => { data.byCols[k] = rec; });
      return { undo: () => { data.byCols[k] = rec; commit(() => {}); } };
    },
    /** JSON に書き出す（作業セットだけ。自動保存は PC ごとのものなので含めない） */
    exportJson() {
      const body = Object.assign({}, FORMAT, { exportedAt: new Date().toISOString(), sets: data.sets.map((s) => ({ name: s.name, state: s.state, at: s.at, cols: s.cols })) });
      return JSON.stringify(body, null, 1);
    },
    /** JSON を読み込む。同じ名前があれば「名前 (2)」として足す（上書きしない） */
    importJson(text) {
      let d;
      try { d = JSON.parse(text); } catch (e) { return { ok: false, reason: "JSON として読めません" }; }
      if (!d || d.app !== FORMAT.app || d.kind !== FORMAT.kind || !Array.isArray(d.sets)) return { ok: false, reason: "docMaker の作業セットの書き出しファイルではありません" };
      const before = data.sets.slice(), names = new Set(data.sets.map((x) => x.name));
      let n = 0, skipped = 0;
      for (const s of d.sets) {
        const base = cleanName(s && s.name);
        if (!base || !s.state || typeof s.state !== "object") { skipped++; continue; }
        if (data.sets.length >= MAX_SETS) { skipped++; continue; }
        let name = base, k = 2;
        while (names.has(name)) name = cleanName(`${base} (${k++})`);
        names.add(name);
        data.sets.push({ id: uid(), name, state: s.state, at: Number(s.at) || Date.now(), cols: Array.isArray(s.cols) ? s.cols.slice(0, 60) : [] });
        n++;
      }
      if (!commit(() => { data.sets = before; })) return { ok: false, reason: "" };
      return { ok: true, added: n, skipped, undo: () => { data.sets = before; commit(() => {}); } };
    },
  };

  /* ── 配線 ── */
  read();
  DM.bus.on("data", onData);
  DM.bus.on("query", autosave);
  DM.bus.on("view", autosave);
  DM.bus.on("form", () => { if (DM.store.formId) DM.safeStorage.set("dm.formId", DM.store.formId); });
})();
