/* =========================================================
   js/report/sheet-doc.js : ツールで作る帳票の中身（セルの書式・結合・行列・ページ設定）と、その編集処理
   画面には依存しない。編集は「レイアウト L = { doc, places, table }」を直接書き換える（取り消しは呼び出し側が控えを取る）
   doc = {
     nRows, nCols, colW:[px], rowH:[px],
     cells: { 'r,c': { s: 書式 } }                    … 値は持たない（値は項目の配置 places が出す）
     merges: [{ r0, c0, r1, c1 }],
     page: { paper:'A4', orientation:'portrait'|'landscape', margin:{ t, b, l, r }(mm), footer:'last'|'every', rows:0(自動) }
   }
   書式 s = { f:フォント, sz:pt, b, i, u, color, bg, h:'left|center|right', v:'top|middle|bottom', wrap, shrink,
              bt, br, bb, bl:'線の種類 #色' }          … report-render と同じ短い名前
   places = [{ id, r, c, item, show, sep }]、table = { top, bottom } | null（板の表は 1 行。top === bottom）
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});

  const MIN_COL = 16;
  const MIN_ROW = 12;
  const MAX_ROWS = 200;
  const MAX_COLS = 40;
  const FONTS = ['游ゴシック', 'MS ゴシック', 'MS Ｐゴシック', 'MS 明朝', '游明朝', 'メイリオ', 'Arial', 'Times New Roman', 'Courier New'];
  const BORDER_STYLES = [
    { value: 'thin', label: '細い線' }, { value: 'medium', label: '太い線' }, { value: 'dashed', label: '破線' },
    { value: 'dotted', label: '点線' }, { value: 'double', label: '二重線' }
  ];
  const DEFAULT_FONT = '游ゴシック';
  const DEFAULT_SIZE = 11;

  const key = (r, c) => r + ',' + c;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const norm = (rg) => ({ r0: Math.min(rg.r0, rg.r1), c0: Math.min(rg.c0, rg.c1), r1: Math.max(rg.r0, rg.r1), c1: Math.max(rg.c0, rg.c1) });
  const hit = (a, b) => !(a.r1 < b.r0 || a.r0 > b.r1 || a.c1 < b.c0 || a.c0 > b.c1);

  /* ---------- 新しい帳票 ---------- */
  function defaultPage() {
    return { paper: 'A4', orientation: 'portrait', margin: { t: 15, b: 15, l: 12, r: 12 }, footer: 'last', rows: 0 };
  }

  /** 空のレイアウト（行 nRows × 列 nCols。板の表は作らない） */
  function blank(nRows, nCols) {
    const doc = { nRows, nCols, colW: [], rowH: [], cells: {}, merges: [], page: defaultPage() };
    for (let c = 0; c < nCols; c++) doc.colW.push(90);
    for (let r = 0; r < nRows; r++) doc.rowH.push(28);
    return { doc, places: [], table: null };
  }

  /** 検査成績書のひな形（見出し・項目名の文字と、罫線・色つきの枠。値の項目は利用者が置く） */
  function skeleton() {
    const L = blank(6, 6);
    const d = L.doc;
    d.colW = [90, 110, 110, 110, 90, 150];
    d.rowH = [44, 30, 30, 30, 56, 36];
    const line = 'thin #111111';
    const edges = { bt: line, br: line, bb: line, bl: line };
    const head = Object.assign({ b: 1, bg: '#dbe7f4', h: 'center', v: 'middle' }, edges);
    const plain = Object.assign({ v: 'middle' }, edges);
    for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) setStyle(L, { r0: r, c0: c, r1: r, c1: c }, r === 0 || r === 2 ? head : plain);
    setStyle(L, { r0: 0, c0: 0, r1: 0, c1: 5 }, { sz: 18 });
    d.merges.push({ r0: 0, c0: 0, r1: 0, c1: 5 });
    d.merges.push({ r0: 4, c0: 0, r1: 4, c1: 5 });
    L.table = { top: 3, bottom: 3 };
    return L;
  }

  /* ---------- 書式 ---------- */
  const styleAt = (doc, r, c) => ((doc.cells[key(r, c)] || {}).s) || {};

  /** 範囲の書式を変える（patch の値が undefined・null・'' ・false ならその書式を外す） */
  function setStyle(L, rg, patch) {
    const a = norm(rg);
    for (let r = a.r0; r <= a.r1; r++) {
      for (let c = a.c0; c <= a.c1; c++) {
        const cell = L.doc.cells[key(r, c)] || (L.doc.cells[key(r, c)] = { s: {} });
        Object.keys(patch).forEach((k) => {
          const v = patch[k];
          if (v === undefined || v === null || v === '' || v === false) delete cell.s[k];
          else cell.s[k] = v;
        });
        if (!Object.keys(cell.s).length) delete L.doc.cells[key(r, c)];
      }
    }
  }

  /**
   * 罫線を引く。隣のセルの反対側の辺も同じにそろえる（結合・コピーで線がずれないように）
   * mode: all | outer | inner | top | bottom | left | right | none。spec: '細い線 #色' の形（none は消す）
   */
  function setBorder(L, rg, mode, spec) {
    const a = norm(rg);
    const d = L.doc;
    const edge = (r, c, side, val) => {
      if (r < 0 || c < 0 || r >= d.nRows || c >= d.nCols) return;
      setStyle(L, { r0: r, c0: c, r1: r, c1: c }, { ['b' + side]: val });
    };
    const put = (r, c, side, val) => {
      edge(r, c, side, val);
      if (side === 't') edge(r - 1, c, 'b', val);
      if (side === 'b') edge(r + 1, c, 't', val);
      if (side === 'l') edge(r, c - 1, 'r', val);
      if (side === 'r') edge(r, c + 1, 'l', val);
    };
    const val = mode === 'none' ? null : spec;
    for (let r = a.r0; r <= a.r1; r++) {
      for (let c = a.c0; c <= a.c1; c++) {
        const top = r === a.r0;
        const bottom = r === a.r1;
        const left = c === a.c0;
        const right = c === a.c1;
        if (mode === 'none') ['t', 'b', 'l', 'r'].forEach((s) => put(r, c, s, null));
        else if (mode === 'all') ['t', 'b', 'l', 'r'].forEach((s) => put(r, c, s, val));
        else if (mode === 'outer') {
          if (top) put(r, c, 't', val);
          if (bottom) put(r, c, 'b', val);
          if (left) put(r, c, 'l', val);
          if (right) put(r, c, 'r', val);
        } else if (mode === 'inner') {
          if (!top) put(r, c, 't', val);
          if (!left) put(r, c, 'l', val);
        } else if (mode === 'top' && top) put(r, c, 't', val);
        else if (mode === 'bottom' && bottom) put(r, c, 'b', val);
        else if (mode === 'left' && left) put(r, c, 'l', val);
        else if (mode === 'right' && right) put(r, c, 'r', val);
      }
    }
  }

  /* ---------- 結合 ---------- */
  const mergeAt = (doc, r, c) => doc.merges.find((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) || null;

  /** 結合できない理由（なければ ''）。板の表の行は、その行の中（列方向）の結合だけ */
  function mergeBlock(L, rg) {
    const a = norm(rg);
    if (a.r0 === a.r1 && a.c0 === a.c1) return '2 つ以上のセルを選んでください';
    if (L.table && a.r0 !== a.r1 && a.r0 <= L.table.bottom && a.r1 >= L.table.top) return '板の表の行は、行をまたぐ結合はできません（板ごとに繰り返す行のため。同じ行の中の結合はできます）';
    return '';
  }

  /** 結合する。範囲に重なる既存の結合は先に解く。結合の左上以外に置いていた項目は外す（外した数を返す） */
  function merge(L, rg) {
    const why = mergeBlock(L, rg);
    if (why) throw new Error(why);
    const a = norm(rg);
    L.doc.merges = L.doc.merges.filter((m) => !hit(m, a));
    L.doc.merges.push(a);
    const before = L.places.length;
    L.places = L.places.filter((p) => !(p.r >= a.r0 && p.r <= a.r1 && p.c >= a.c0 && p.c <= a.c1) || (p.r === a.r0 && p.c === a.c0));
    return before - L.places.length;
  }

  /** 結合を解く（範囲に重なる結合すべて）。解いた数を返す */
  function unmerge(L, rg) {
    const a = norm(rg);
    const n = L.doc.merges.length;
    L.doc.merges = L.doc.merges.filter((m) => !hit(m, a));
    return n - L.doc.merges.length;
  }

  /* ---------- 行・列の挿入と削除 ---------- */
  function remapCells(doc, fn) {
    const out = {};
    Object.keys(doc.cells).forEach((k) => {
      const [r, c] = k.split(',').map(Number);
      const at = fn(r, c);
      if (at) out[key(at.r, at.c)] = doc.cells[k];
    });
    doc.cells = out;
  }

  /** 行を挿入する（at の位置に n 行。上の行の書式・高さを引き継ぐ）。配置した項目・板の表・結合も一緒にずらす */
  function insertRows(L, at, n) {
    const d = L.doc;
    const cnt = Math.min(n || 1, MAX_ROWS - d.nRows);
    if (cnt <= 0) throw new Error(`行は ${MAX_ROWS} 行までです`);
    const src = Math.max(0, Math.min(at - 1, d.nRows - 1));
    remapCells(d, (r, c) => ({ r: r >= at ? r + cnt : r, c }));
    for (let i = 0; i < cnt; i++) {
      for (let c = 0; c < d.nCols; c++) {
        const s = styleAt(d, src >= at ? src + cnt : src, c);
        if (Object.keys(s).length) d.cells[key(at + i, c)] = { s: clone(s) };
      }
    }
    d.rowH.splice(at, 0, ...Array(cnt).fill(d.rowH[src] || 28));
    d.nRows += cnt;
    d.merges = d.merges.map((m) => {
      if (m.r0 >= at) return Object.assign({}, m, { r0: m.r0 + cnt, r1: m.r1 + cnt });
      if (m.r1 >= at) return Object.assign({}, m, { r1: m.r1 + cnt }); // 結合の途中に挿入したら結合も広がる
      return m;
    });
    L.places.forEach((p) => { if (p.r >= at) p.r += cnt; });
    if (L.table) {
      if (L.table.top >= at) { L.table.top += cnt; L.table.bottom += cnt; }
    }
    return cnt;
  }

  /** 行を削除する（r0〜r1）。その行にあった項目は外し、板の表の行を消したら板の表はなくなる */
  function deleteRows(L, r0, r1) {
    const d = L.doc;
    const a = Math.max(0, Math.min(r0, r1));
    const b = Math.min(d.nRows - 1, Math.max(r0, r1));
    const cnt = b - a + 1;
    if (cnt >= d.nRows) throw new Error('すべての行は削除できません');
    remapCells(d, (r, c) => (r >= a && r <= b ? null : { r: r > b ? r - cnt : r, c }));
    d.rowH.splice(a, cnt);
    d.nRows -= cnt;
    d.merges = d.merges.map((m) => {
      if (m.r1 < a) return m;
      if (m.r0 > b) return Object.assign({}, m, { r0: m.r0 - cnt, r1: m.r1 - cnt });
      const r0 = m.r0 < a ? m.r0 : a;
      const r1 = m.r1 > b ? m.r1 - cnt : a - 1;
      return r1 >= r0 && (r1 > r0 || m.c1 > m.c0) ? Object.assign({}, m, { r0, r1 }) : null;
    }).filter(Boolean);
    const lost = L.places.filter((p) => p.r >= a && p.r <= b).length;
    L.places = L.places.filter((p) => p.r < a || p.r > b);
    L.places.forEach((p) => { if (p.r > b) p.r -= cnt; });
    if (L.table) {
      if (L.table.top >= a && L.table.top <= b) L.table = null;
      else if (L.table.top > b) { L.table.top -= cnt; L.table.bottom -= cnt; }
    }
    return lost;
  }

  function insertCols(L, at, n) {
    const d = L.doc;
    const cnt = Math.min(n || 1, MAX_COLS - d.nCols);
    if (cnt <= 0) throw new Error(`列は ${MAX_COLS} 列までです`);
    const src = Math.max(0, Math.min(at - 1, d.nCols - 1));
    remapCells(d, (r, c) => ({ r, c: c >= at ? c + cnt : c }));
    for (let i = 0; i < cnt; i++) {
      for (let r = 0; r < d.nRows; r++) {
        const s = styleAt(d, r, src >= at ? src + cnt : src);
        if (Object.keys(s).length) d.cells[key(r, at + i)] = { s: clone(s) };
      }
    }
    d.colW.splice(at, 0, ...Array(cnt).fill(d.colW[src] || 90));
    d.nCols += cnt;
    d.merges = d.merges.map((m) => {
      if (m.c0 >= at) return Object.assign({}, m, { c0: m.c0 + cnt, c1: m.c1 + cnt });
      if (m.c1 >= at) return Object.assign({}, m, { c1: m.c1 + cnt });
      return m;
    });
    L.places.forEach((p) => { if (p.c >= at) p.c += cnt; });
    return cnt;
  }

  function deleteCols(L, c0, c1) {
    const d = L.doc;
    const a = Math.max(0, Math.min(c0, c1));
    const b = Math.min(d.nCols - 1, Math.max(c0, c1));
    const cnt = b - a + 1;
    if (cnt >= d.nCols) throw new Error('すべての列は削除できません');
    remapCells(d, (r, c) => (c >= a && c <= b ? null : { r, c: c > b ? c - cnt : c }));
    d.colW.splice(a, cnt);
    d.nCols -= cnt;
    d.merges = d.merges.map((m) => {
      if (m.c1 < a) return m;
      if (m.c0 > b) return Object.assign({}, m, { c0: m.c0 - cnt, c1: m.c1 - cnt });
      const c0 = m.c0 < a ? m.c0 : a;
      const c1 = m.c1 > b ? m.c1 - cnt : a - 1;
      return c1 >= c0 && (c1 > c0 || m.r1 > m.r0) ? Object.assign({}, m, { c0, c1 }) : null;
    }).filter(Boolean);
    const lost = L.places.filter((p) => p.c >= a && p.c <= b).length;
    L.places = L.places.filter((p) => p.c < a || p.c > b);
    L.places.forEach((p) => { if (p.c > b) p.c -= cnt; });
    return lost;
  }

  /* ---------- 列幅・行の高さ ---------- */
  const setColW = (L, c, px) => { L.doc.colW[c] = Math.max(MIN_COL, Math.round(px)); };
  const setRowH = (L, r, px) => { L.doc.rowH[r] = Math.max(MIN_ROW, Math.round(px)); };

  /** 板の表の行を決める（r0〜r1 の連続する行を、板ごとに繰り返す）。null で板の表なし。結合は、繰り返す行をまたぐものを解く */
  function setTable(L, r, r1) {
    if (r === null || r === undefined) { L.table = null; return; }
    const top = Math.min(r, r1 === undefined ? r : r1);
    const bottom = Math.max(r, r1 === undefined ? r : r1);
    L.doc.merges = L.doc.merges.filter((m) => !(m.r0 !== m.r1 && m.r0 <= bottom && m.r1 >= top));
    L.table = { top, bottom };
  }

  /** 検査して直せない問題を返す（保存前の点検用） */
  function check(L) {
    const warns = [];
    const d = L.doc;
    if (L.table && (L.table.top < 0 || L.table.top >= d.nRows)) warns.push('板の表の行が表の外にあります');
    L.places.forEach((p) => { if (p.r >= d.nRows || p.c >= d.nCols) warns.push('表の外に置いた項目があります'); });
    if (L.table) {
      const inBody = L.places.filter((p) => p.r === L.table.top).length;
      if (!inBody) warns.push('板の表の行に項目が置かれていません');
    }
    return Array.from(new Set(warns));
  }

  CDB.sheetDoc = {
    FONTS, BORDER_STYLES, DEFAULT_FONT, DEFAULT_SIZE, MIN_COL, MIN_ROW, MAX_ROWS, MAX_COLS,
    key, clone, norm, hit, defaultPage, blank, skeleton, styleAt, setStyle, setBorder, mergeAt, mergeBlock, merge, unmerge,
    insertRows, deleteRows, insertCols, deleteCols, setColW, setRowH, setTable, check
  };
})();
