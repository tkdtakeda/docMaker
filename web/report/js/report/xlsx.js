/* =========================================================
   js/report/xlsx.js : 帳票テンプレート（Excel）の読み込みと書き出し（ExcelJS を使う）
   ・読み込み：プレビュー用に、値・書式・結合・列幅・行の高さ・印刷範囲を取り出す
   ・書き出し：テンプレートのシートをロット・ページの数だけ複製し、値を書き込む
     罫線・結合・書式・印刷設定はテンプレートのまま残す
     ほかのシート・ブックを参照する式は、テンプレートに保存されていた結果の値に置き換える
   画面には依存しない
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;

  const MAX_ROWS = 400;
  const MAX_COLS = 80;
  const BORDER_MARGIN = 100; // 値のある最後の行から、罫線だけの行を何行先まで表示するか
  const DEFAULT_COL_W = 8.43;
  const DEFAULT_ROW_H = 15;
  // Excel の用紙番号 → 用紙名（印刷の @page に使う）
  const PAPER = { 1: 'letter', 5: 'legal', 8: 'A3', 9: 'A4', 11: 'A5', 12: 'B4', 13: 'B5' };

  function lib() {
    if (!window.ExcelJS) throw new Error('Excel を扱う部品（ExcelJS）を読み込めませんでした。インターネットに接続して開き直してください');
    return window.ExcelJS;
  }

  async function load(buffer) {
    const wb = new (lib().Workbook)();
    await wb.xlsx.load(buffer);
    return wb;
  }

  /** ファイルの中身を確かめ、シート名の一覧を返す */
  async function inspect(buffer) {
    const wb = await load(buffer);
    const sheets = wb.worksheets.filter((ws) => ws.state !== 'veryHidden').map((ws) => ws.name);
    if (!sheets.length) throw new Error('シートがありません');
    return { sheets };
  }

  /* ---------- 番地 ---------- */
  function colIndex(letters) {
    let n = 0;
    for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }
  /** "A1" → {r,c}（0 始まり） */
  function parseAddr(a) {
    const m = String(a).replace(/\$/g, '').match(/([A-Z]+)(\d+)/i);
    return m ? { r: Number(m[2]) - 1, c: colIndex(m[1]) } : null;
  }
  /** "A1:B3" → {r0,c0,r1,c1} */
  function parseRange(a) {
    const s = String(a || '').replace(/^.*!/, '').replace(/\$/g, '');
    const [p, q] = s.split(':');
    const x = parseAddr(p);
    const y = parseAddr(q || p);
    return x && y ? { r0: Math.min(x.r, y.r), c0: Math.min(x.c, y.c), r1: Math.max(x.r, y.r), c1: Math.max(x.c, y.c) } : null;
  }

  /* ---------- セルの文字 ---------- */
  const pad2 = (x) => String(x).padStart(2, '0');
  const dateText = (d) => `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}`;

  function numText(n, numFmt) {
    const m = String(numFmt || '').match(/0\.(0+)/);
    if (m) return n.toFixed(m[1].length);
    if (/%/.test(numFmt || '')) return (n * 100).toFixed(0) + '%';
    return CDB.formula.numToStr(n);
  }

  function valueText(v, numFmt) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return dateText(v);
    if (typeof v === 'number') return numText(v, numFmt);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'object') {
      if (v.richText) return v.richText.map((t) => t.text).join('');
      if (v.formula !== undefined || v.sharedFormula !== undefined) return valueText(v.result, numFmt);
      if (v.text !== undefined) return String(v.text);
      if (v.error) return v.error;
      return '';
    }
    return String(v);
  }

  /* ---------- 書式 ---------- */
  const argb = (c) => (c && typeof c.argb === 'string' && c.argb.length >= 6 ? '#' + c.argb.slice(-6) : '');

  function styleOf(cell) {
    const s = cell.style || {};
    const out = {};
    const f = s.font || {};
    if (f.bold) out.b = 1;
    if (f.italic) out.i = 1;
    if (f.underline) out.u = 1;
    if (f.size) out.sz = f.size;
    if (argb(f.color)) out.color = argb(f.color);
    const a = s.alignment || {};
    if (a.horizontal) out.h = a.horizontal;
    if (a.vertical) out.v = a.vertical;
    if (a.wrapText) out.wrap = 1;
    if (a.shrinkToFit) out.shrink = 1;
    const fill = s.fill || {};
    if (fill.type === 'pattern' && fill.pattern === 'solid' && argb(fill.fgColor)) out.bg = argb(fill.fgColor);
    const b = s.border || {};
    ['top', 'right', 'bottom', 'left'].forEach((k) => {
      if (b[k] && b[k].style) out['b' + k[0]] = b[k].style + (argb(b[k].color) ? ' ' + argb(b[k].color) : '');
    });
    return out;
  }

  /**
   * プレビュー用にシートを取り出す
   * @returns {{name, nRows, nCols, colW:number[], rowH:number[], merges:object[], cells:Map, print:object}}
   */
  function sheetModel(wb, name) {
    const ws = wb.getWorksheet(name);
    if (!ws) throw new Error(`シート「${name}」がありません`);
    const cells = new Map();
    let lastValueRow = -1;
    let lastValueCol = -1;
    let lastBorderRow = -1;
    let lastBorderCol = -1;
    ws.eachRow({ includeEmpty: false }, (row, rn) => {
      if (rn > 3000) return;
      row.eachCell({ includeEmpty: true }, (cell, cn) => {
        const r = rn - 1;
        const c = cn - 1;
        if (c >= MAX_COLS * 2) return;
        const text = valueText(cell.value, cell.numFmt);
        const st = styleOf(cell);
        const hasBorder = st.bt || st.br || st.bb || st.bl || st.bg;
        if (!text && !hasBorder) return;
        if (text) { lastValueRow = Math.max(lastValueRow, r); lastValueCol = Math.max(lastValueCol, c); }
        if (hasBorder) { lastBorderRow = Math.max(lastBorderRow, r); lastBorderCol = Math.max(lastBorderCol, c); }
        cells.set(r + ',' + c, { text, s: st, formula: !!(cell.value && typeof cell.value === 'object' && (cell.value.formula || cell.value.sharedFormula)) });
      });
    });
    const merges = (ws.model.merges || []).map(parseRange).filter(Boolean);
    const ps = ws.pageSetup || {};
    const area = ps.printArea ? parseRange(String(ps.printArea).split(',')[0]) : null;
    const titles = ps.printTitlesRow ? String(ps.printTitlesRow).replace(/\$/g, '').split(':').map((x) => Number(x) - 1) : null;
    let nRows = Math.max(lastValueRow, Math.min(lastBorderRow, lastValueRow + BORDER_MARGIN), area ? area.r1 : -1);
    let nCols = Math.max(lastValueCol, Math.min(lastBorderCol, lastValueCol + 20), area ? area.c1 : -1);
    merges.forEach((m) => { if (m.r0 <= nRows + 1) { nRows = Math.max(nRows, m.r1); nCols = Math.max(nCols, m.c1); } });
    nRows = Math.min(MAX_ROWS, nRows + 1);
    nCols = Math.min(MAX_COLS, nCols + 1);
    const defW = (ws.properties && ws.properties.defaultColWidth) || DEFAULT_COL_W;
    const defH = (ws.properties && ws.properties.defaultRowHeight) || DEFAULT_ROW_H;
    const colW = [];
    for (let c = 0; c < nCols; c++) {
      const col = ws.getColumn(c + 1);
      colW.push(col.hidden ? 0 : Math.round((col.width || defW) * 7 + 5));
    }
    const rowH = [];
    for (let r = 0; r < nRows; r++) {
      const row = ws.findRow(r + 1);
      rowH.push(row && row.hidden ? 0 : Math.round(((row && row.height) || defH) * 96 / 72));
    }
    return {
      name, nRows, nCols, colW, rowH, cells,
      merges: merges.filter((m) => m.r0 < nRows && m.c0 < nCols),
      print: {
        paper: PAPER[ps.paperSize] || 'A4',
        orientation: ps.orientation === 'landscape' ? 'landscape' : 'portrait',
        area: area ? { r0: titles ? Math.min(titles[0], area.r0) : area.r0, c0: area.c0, r1: Math.min(area.r1, nRows - 1), c1: Math.min(area.c1, nCols - 1) } : null,
        margins: ps.margins || null
      }
    };
  }

  /* ---------- 書き出し ---------- */
  /** 結合セルの中なら左上のセルの番地を返す */
  function mergeTopLeft(merges, r, c) {
    const m = merges.find((x) => r >= x.r0 && r <= x.r1 && c >= x.c0 && c <= x.c1);
    return m ? { r: m.r0, c: m.c0 } : { r, c };
  }

  /** ほかのシート・ブックを参照する式（Sheet1!A1・[1]Sheet!A1） */
  const isOuterRef = (formula) => /!|\[\d+\]/.test(String(formula || ''));

  /**
   * 条件付き書式の「空白を含む」などは、ExcelJS がそのまま書くと Excel で修復の警告が出る形になる。
   * 同じ意味の「数式で指定」に直す
   */
  function fixConditionalFormats(ws) {
    (ws.conditionalFormattings || []).forEach((cf) => (cf.rules || []).forEach((rule) => {
      if (rule.type !== 'containsText') return;
      const formula = rule.formulae && rule.formulae[0];
      if (!formula) return;
      rule.type = 'expression';
      delete rule.operator;
      delete rule.text;
    }));
  }

  /**
   * シートを複製して値を書き込み、Blob を返す
   * @param {ArrayBuffer} buffer テンプレート
   * @param {string} sheet テンプレートのシート名
   * @param {{name:string, cells:Map}[]} jobs 1 ページ 1 シート
   * @param {(done:number, total:number)=>Promise|void} onProgress
   */
  async function write(buffer, sheet, jobs, onProgress) {
    const wb = await load(buffer);
    const tpl = wb.getWorksheet(sheet);
    if (!tpl) throw new Error(`シート「${sheet}」がありません`);
    const originals = wb.worksheets.slice();
    const merges = (tpl.model.merges || []).map(parseRange).filter(Boolean);
    const used = new Set();
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const name = CDB.reportModel.sheetName(job.name, used);
      const ws = wb.addWorksheet('__tmp_' + i);
      const m = tpl.model;
      ws.model = Object.assign({}, m, { id: ws.id, name, mergeCells: m.merges });
      ws.name = name;
      fixConditionalFormats(ws);
      // 式の整理（ほかのシート・ブックの参照は値に）
      ws.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (v && typeof v === 'object' && (v.formula || v.sharedFormula) && isOuterRef(v.formula || v.sharedFormula)) {
          cell.value = v.result === undefined || (v.result && v.result.error) ? null : v.result;
        }
      }));
      job.cells.forEach((val, key) => {
        const [r, c] = key.split(',').map(Number);
        const at = mergeTopLeft(merges, r, c);
        const cell = ws.getCell(at.r + 1, at.c + 1);
        if (typeof val.num === 'number' && Number.isFinite(val.num) && val.place.show === 'value') {
          cell.value = val.num;
          if (val.numFmt && val.numFmt !== 'General') cell.style = Object.assign({}, cell.style, { numFmt: val.numFmt });
        } else {
          cell.value = val.text === '' ? null : val.text;
        }
      });
      if (onProgress) await onProgress(i + 1, jobs.length);
    }
    originals.forEach((ws) => wb.removeWorksheet(ws.id));
    // 印刷範囲などの名前定義はテンプレートのシートを指したままなので消す
    try { if (wb.definedNames && wb.definedNames.model) wb.definedNames.model = []; } catch (_) { /* 古い版では無視 */ }
    wb.calcProperties = Object.assign({}, wb.calcProperties, { fullCalcOnLoad: true });
    const out = await wb.xlsx.writeBuffer();
    return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  /** ダウンロード */
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = U.el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  CDB.reportXlsx = { load, inspect, sheetModel, write, download, parseAddr, parseRange, mergeTopLeft };
})();
