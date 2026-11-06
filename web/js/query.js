/* ── query: 検索・フィルター・並べ替えの処理（画面と分離）─────────
   演算子はWaveLog の lot_list と同じ種類。register するだけで足せる（§9）。
   いまはブラウザ内のサンプルを引く。サーバー接続時は同じ条件（state）を API へ渡す差し替えになる。 */
(function () {
  "use strict";
  const DM = window.DM;

  DM.queryState = { search: "", filters: [], sorts: [], group: false };

  /* 日付として読めれば Date、読めなければ null（lot_list.to_date 相当） */
  const DATE_RX = [/^\s*(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/, /^\s*(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/, /^\s*(\d{4})(\d{2})(\d{2})\s*$/];
  DM.toDate = function (v) {
    const s = String(v == null ? "" : v);
    for (const rx of DATE_RX) {
      const m = rx.exec(s);
      if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3]); if (d.getMonth() === +m[2] - 1) return d; }
    }
    return null;
  };
  function cutoff(unit, n) {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    n = Math.max(0, Math.floor(+n || 0));
    if (unit === "days") d.setDate(d.getDate() - n);
    else if (unit === "weeks") d.setDate(d.getDate() - 7 * n);
    else if (unit === "months") d.setMonth(d.getMonth() - n);
    else d.setFullYear(d.getFullYear() - n);
    return d;
  }
  const num = (v) => { const m = /^\s*[+-]?\d+(\.\d+)?/.exec(String(v == null ? "" : v).replace(/,/g, "")); return m ? parseFloat(m[0]) : 0; };

  DM.ops = DM.createRegistry();
  const op = (id, label, needsValue, test, extra) => DM.ops.register(Object.assign({ id, label, needsValue, test }, extra || {}));
  op("contains", "を含む", true, (c, v) => DM.norm(c).includes(DM.norm(v)));
  op("not_contains", "を含まない", true, (c, v) => !DM.norm(c).includes(DM.norm(v)));
  op("eq", "と等しい", true, (c, v) => DM.norm(c) === DM.norm(v));
  op("neq", "と等しくない", true, (c, v) => DM.norm(c) !== DM.norm(v));
  op("starts", "で始まる", true, (c, v) => DM.norm(c).startsWith(DM.norm(v)));
  op("ends", "で終わる", true, (c, v) => DM.norm(c).endsWith(DM.norm(v)));
  op("gt", "より大きい", true, (c, v) => num(c) > num(v), { numeric: true });
  op("gte", "以上", true, (c, v) => num(c) >= num(v), { numeric: true });
  op("lt", "より小さい", true, (c, v) => num(c) < num(v), { numeric: true });
  op("lte", "以下", true, (c, v) => num(c) <= num(v), { numeric: true });
  op("empty", "が空欄", false, (c) => DM.isEmpty(c));
  op("not_empty", "が入力済み", false, (c) => !DM.isEmpty(c));
  [["within_days", "日以内", "days"], ["within_weeks", "週間以内", "weeks"], ["within_months", "か月以内", "months"], ["within_years", "年以内", "years"]]
    .forEach(([id, label, unit]) => op(id, label, true, (c, v) => { const d = DM.toDate(c); return !!d && d >= cutoff(unit, v); }, { date: true }));

  /* 日付の列か（値の大半が日付と読める）。空欄は数えない */
  DM.dateColumns = function (rows, columns) {
    return columns.filter((col) => {
      const vals = []; for (let i = 0; i < rows.length && vals.length < 60; i++) { const v = rows[i][col]; if (!DM.isEmpty(v)) vals.push(v); }
      return vals.length > 0 && vals.filter((v) => DM.toDate(v)).length / vals.length >= 0.8;
    });
  };
  DM.numericColumns = function (rows, columns) {
    return columns.filter((col) => {
      const vals = []; for (let i = 0; i < rows.length && vals.length < 60; i++) { const v = rows[i][col]; if (!DM.isEmpty(v)) vals.push(v); }
      return vals.length > 0 && vals.every((v) => /^\s*[+-]?[\d,]+(\.\d+)?\s*$/.test(String(v)));
    });
  };

  const cmp = (a, b) => {
    const ea = DM.isEmpty(a), eb = DM.isEmpty(b);
    if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;          // 空欄は常に下
    const na = Number(String(a).replace(/,/g, "")), nb = Number(String(b).replace(/,/g, ""));
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a).localeCompare(String(b), "ja");
  };

  /* 実行：検索（全列 OR）→ フィルター（AND）→ 並べ替え。group なら先頭ロット順にまとめる */
  DM.runQuery = function (rows, columns, state, lotCol) {
    const q = DM.norm((state.search || "").trim());
    const filters = (state.filters || []).filter((f) => f.column && DM.ops.get(f.op) && (!DM.ops.get(f.op).needsValue || !DM.isEmpty(f.value)));
    let out = rows.filter((r) => {
      if (q && !columns.some((c) => DM.norm(r[c]).includes(q))) return false;
      return filters.every((f) => DM.ops.get(f.op).test(r[f.column], f.value));
    });
    const sorts = (state.sorts || []).filter((s) => columns.includes(s.column));
    if (sorts.length) out = out.map((r, i) => [r, i]).sort((x, y) => {
      for (const s of sorts) { const c = cmp(x[0][s.column], y[0][s.column]); if (c) return s.dir === "desc" ? -c : c; }
      return x[1] - y[1];
    }).map((p) => p[0]);
    if (state.group && lotCol) {
      const order = new Map(); out.forEach((r) => { const k = DM.norm(r[lotCol]).trim(); if (k && !order.has(k)) order.set(k, order.size); });
      out = out.map((r, i) => [r, i]).sort((x, y) => {
        const kx = DM.norm(x[0][lotCol]).trim(), ky = DM.norm(y[0][lotCol]).trim();
        return (kx ? order.get(kx) : 1e9 + x[1]) - (ky ? order.get(ky) : 1e9 + y[1]) || x[1] - y[1];
      }).map((p) => p[0]);
    }
    return { rows: out, filterCount: filters.length };
  };
  DM.lotColumn = function (cols) {
    for (const c of ["ロット番号", "ﾛｯﾄ番号", "ロット№", "LTNO"]) if (cols.includes(c)) return c;
    return cols.find((c) => c.includes("ロット") || c.includes("ﾛｯﾄ")) || "";
  };
  DM.setQuery = function (patch) { Object.assign(DM.queryState, patch); DM.bus.emit("query"); };
})();
