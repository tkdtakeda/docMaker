/* =========================================================
   js/report/sheet-pages.js : ツールで作る帳票の用紙・ページ送り・描画用のモデル
   ・用紙の大きさと余白から、1 ページに入る板の行数を決める（ヘッダー・フッターの高さ込み。手で上書きも可）
   ・描画（プレビュー・印刷）と Excel 出力は、同じ「ページのモデル」から作る
     モデル = { name, nRows, nCols, colW, rowH, merges, cells:Map<'r,c', {text, s}>, print:{paper, orientation, area, marginsMm} }
   ・ヘッダー（板の表より上の行）は毎ページ、フッター（下の行）は最後のページのみ／毎ページ
   画面には依存しない
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const D = () => CDB.sheetDoc;

  /** 用紙の大きさ（mm・縦向き）と、Excel の用紙の番号（ExcelJS の paperSize） */
  const PAPERS = [
    { value: 'A3', label: 'A3', mm: [297, 420], xl: 8 },
    { value: 'A4', label: 'A4', mm: [210, 297], xl: 9 },
    { value: 'A5', label: 'A5', mm: [148, 210], xl: 11 },
    { value: 'B4', label: 'B4', mm: [257, 364], xl: 12 },
    { value: 'B5', label: 'B5', mm: [182, 257], xl: 13 },
    { value: 'letter', label: 'レター', mm: [216, 279], xl: 1 },
    { value: 'legal', label: 'リーガル', mm: [216, 356], xl: 5 }
  ];
  const PX_PER_MM = 96 / 25.4;
  const paperOf = (v) => PAPERS.find((p) => p.value === v) || PAPERS[1];

  /** 用紙の大きさ（mm。向きを反映） */
  function paperMm(page) {
    const p = paperOf(page.paper).mm;
    return page.orientation === 'landscape' ? [p[1], p[0]] : p.slice();
  }

  /** 印刷できる範囲（px・96dpi） */
  function printable(page) {
    const [w, h] = paperMm(page);
    const m = page.margin || { t: 15, b: 15, l: 12, r: 12 };
    return { w: Math.max(1, (w - m.l - m.r) * PX_PER_MM), h: Math.max(1, (h - m.t - m.b) * PX_PER_MM) };
  }

  const sum = (a, from, to) => { let s = 0; for (let i = from; i <= to; i++) s += a[i] || 0; return s; };

  /**
   * 区間（改ページで分けた本文のまとまり）。doc.sections があればそれ（行は帯の並びで、ヘッダーの行数は doc.headRows）。
   * なければ（旧形式・区切りなし）、ヘッダーなし・毎ページ出すフッターの手前までの 1 区間
   */
  function sectionsOf(doc) {
    if (doc.sections && doc.sections.length) return { head: doc.headRows || 0, secs: doc.sections };
    const fixed = Math.min((doc.page && doc.page.fixedFooter) || 0, doc.nRows);
    return { head: 0, secs: [{ r0: 0, r1: doc.nRows - fixed - 1 }] };
  }

  /** 板の表がある区間の番号（なければ -1） */
  function plateSection(doc, table) {
    if (!table) return -1;
    return sectionsOf(doc).secs.findIndex((x) => table.top >= x.r0 && table.top <= x.r1);
  }

  /** 板の表の行を並べられる高さ（px）。用紙の印刷できる高さから、ヘッダー・表より上の行・表より下の行・毎ページのフッターを引く */
  function bodyAvail(doc, table) {
    const avail = printable(doc.page).h;
    const { head, secs } = sectionsOf(doc);
    const sec = secs[Math.max(0, plateSection(doc, table))];
    const fixed = Math.min(doc.page.fixedFooter || 0, doc.nRows);
    const header = sum(doc.rowH, 0, head - 1) + sum(doc.rowH, sec.r0, table.top - 1);
    const footer = sum(doc.rowH, table.bottom + 1, sec.r1) + sum(doc.rowH, doc.nRows - fixed, doc.nRows - 1);
    return avail - header - footer;
  }

  /** 1 ページに入る板の数（板の表がなければ 0）。手で決めた数があればそれ。繰り返す行の高さの合計で割る */
  function capacity(doc, table) {
    if (!table) return 0;
    if (doc.page.rows > 0) return Math.floor(doc.page.rows);
    const body = Math.max(1, sum(doc.rowH, table.top, table.bottom) || 28);
    return Math.max(1, Math.floor(bodyAvail(doc, table) / body));
  }

  /** 横幅が印刷できる範囲に収まっているか（収まらないと縮小して印刷される） */
  const widthOver = (doc) => Math.max(0, sum(doc.colW, 0, doc.nCols - 1) - printable(doc.page).w);

  /** ページの設定の要約 */
  function summary(doc, table) {
    const p = paperOf(doc.page.paper).label;
    return `${p} ${doc.page.orientation === 'landscape' ? '横' : '縦'}・${table ? capacity(doc, table) + ' 行/ページ' : '1 ページ'}`;
  }

  const printOf = (doc) => ({ paper: doc.page.paper, orientation: doc.page.orientation, area: null, marginsMm: Object.assign({}, doc.page.margin) });

  /** 行 r をそのページに出すか（ヘッダー・フッターの帯の「1 ページ目だけ」「最後のページだけ」）。pg なしは常に出す */
  function rowVisible(doc, r, pg) {
    const m = doc.rowShow && doc.rowShow[r];
    return !m || !pg || (m === 'first' ? pg.idx === 0 : pg.idx === pg.count - 1);
  }

  /** 編集中のモデル（板の表は 1 行のまま）。pg：{idx, count}（出力のページ。出さない行は高さ 0・中身なし） */
  function toModel(doc, name, pg) {
    const cells = new Map();
    Object.keys(doc.cells).forEach((k) => { if (rowVisible(doc, Number(k.split(',')[0]), pg)) cells.set(k, { text: '', s: doc.cells[k].s || {}, im: doc.cells[k].im }); });
    return {
      name: name || '', nRows: doc.nRows, nCols: doc.nCols, colW: doc.colW.slice(), rowH: doc.rowH.map((h, r) => (rowVisible(doc, r, pg) ? h : 0)),
      merges: doc.merges.map((m) => Object.assign({}, m)), cells, print: printOf(doc)
    };
  }

  /**
   * 1 ページに載せる行の計画
   * 並び：ヘッダーの帯の行 → その区間の行（板の表の区間は、繰り返す行を n 回） → 毎ページ出すフッターの行
   * 板の表の区間では、板の表より下の行は showFooter のときだけ出す
   * @param {number} secIdx 区間の番号（既定 0）
   * @param {number} n この区間が板の表を持つとき、このページの板の数
   * @returns {{list:number[], rowOf:(r:number)=>number|null, block:number, inPlate:boolean}} list：載せる元の行の並び（ページの行 → 元の行）。block：繰り返す行の数
   */
  function plan(doc, table, secIdx, n, showFooter) {
    const { head, secs } = sectionsOf(doc);
    const sec = secs[secIdx || 0] || { r0: 0, r1: -1 };
    const fixed = Math.min((doc.page && doc.page.fixedFooter) || 0, doc.nRows);
    const inPlate = !!table && table.top >= sec.r0 && table.top <= sec.r1;
    const block = table ? table.bottom - table.top + 1 : 0;
    const list = [];
    const first = {};
    const push = (r) => { if (first[r] === undefined) first[r] = list.length; list.push(r); };
    for (let r = 0; r < head; r++) push(r);
    for (let r = sec.r0; r <= sec.r1; r++) {
      if (inPlate && r >= table.top && r <= table.bottom) {
        if (r === table.top) {
          for (let rr = table.top; rr <= table.bottom; rr++) first[rr] = list.length + (rr - table.top);
          for (let i = 0; i < n; i++) for (let rr = table.top; rr <= table.bottom; rr++) list.push(rr);
        }
      } else if (inPlate && r > table.bottom && !showFooter) continue;
      else push(r);
    }
    for (let r = doc.nRows - fixed; r < doc.nRows; r++) if (r >= (sec.r1 + 1)) push(r);
    return { list, rowOf: (r) => (first[r] === undefined ? null : first[r]), block, inPlate };
  }

  /** （旧）レイアウトの行 r が、板の表を n 行にした最初の区間のページのどの行になるか。plan の rowOf と同じ */
  function footerRow(doc, table, n, showFooter, r) {
    return plan(doc, table, 0, n, showFooter).rowOf(r);
  }

  /**
   * 1 ページ分のモデル（板の表は n 回に増やす。フッターは showFooter のときだけ。毎ページ出すフッターは常に）
   * @param {number} [secIdx] 区間の番号（既定 0）
   * @returns {{model, rowOf:(r:number)=>number|null, plan}} rowOf：レイアウトの行 → このページの行（なければ null）
   */
  function pageModel(doc, table, n, showFooter, name, pg, secIdx, plateStart, repH) {
    if (!table && (!doc.sections || doc.sections.length <= 1)) return { model: toModel(doc, name, pg), rowOf: (r) => r, plan: null };
    const pl = plan(doc, table, secIdx || 0, plateSection(doc, table) === (secIdx || 0) ? n : 0, showFooter);
    const rowH = [];
    const cells = new Map();
    pl.list.forEach((from, to) => {
      if (!rowVisible(doc, from, pg)) { rowH[to] = 0; return; } // 出さない行：高さ 0・中身なし
      for (let c = 0; c < doc.nCols; c++) {
        const cell = doc.cells[D().key(from, c)];
        if (cell) cells.set(D().key(to, c), { text: '', s: cell.s || {}, im: cell.im });
      }
      rowH[to] = doc.rowH[from];
    });
    // 繰り返す行の高さを、行ごとに変える（折り返して長くなる行を広げる）。repH[i][k]：i 回目の繰り返しの k 行目の高さ（px）
    if (repH && table && pl.inPlate && pl.block) {
      const start0 = pl.rowOf(table.top);
      repH.forEach((hs, i) => hs.forEach((h, k) => { const row = start0 + i * pl.block + k; if (h > 0 && rowH[row] > 0) rowH[row] = h; }));
    }
    const merges = [];
    const inBlock = (m) => table && pl.inPlate && m.r0 >= table.top && m.r1 <= table.bottom;
    doc.merges.forEach((m) => {
      if (inBlock(m)) { // 繰り返す行の中の結合は、繰り返しごとに
        const start = pl.rowOf(table.top);
        const reps = pl.block ? (pl.list.length ? pl.list.filter((r) => r === table.top).length : 0) : 0;
        for (let i = 0; i < reps; i++) merges.push({ r0: start + i * pl.block + (m.r0 - table.top), r1: start + i * pl.block + (m.r1 - table.top), c0: m.c0, c1: m.c1 });
        return;
      }
      const a = pl.rowOf(m.r0);
      const b = pl.rowOf(m.r1);
      if (a !== null && b !== null && b - a === m.r1 - m.r0) merges.push({ r0: a, r1: b, c0: m.c0, c1: m.c1 });
    });
    // 一定間隔の罫線（板の表の N 行ごと）：全体の何枚目かで決める（ページをまたいでも続く）。その行の下と、次の行の上に、同じ線を引く
    const rr = doc.rowRule;
    if (rr && table && pl.inPlate && pl.block) {
      const start = pl.rowOf(table.top);
      const reps = pl.list.filter((r) => r === table.top).length;
      const put = (row, edge) => { if (row < 0 || row >= pl.list.length || rowH[row] === 0) return; for (let c = 0; c < doc.nCols; c++) { const k = D().key(row, c); const cur = cells.get(k) || { text: '', s: {} }; cells.set(k, Object.assign({}, cur, { s: Object.assign({}, cur.s, { [edge]: rr.spec }) })); } };
      for (let i = 0; i < reps; i++) {
        if (((plateStart || 0) + i + 1) % rr.every !== 0) continue;
        const last = start + i * pl.block + pl.block - 1;
        put(last, 'bb');
        put(last + 1, 'bt');
      }
    }
    return { model: { name: name || '', nRows: pl.list.length, nCols: doc.nCols, colW: doc.colW.slice(), rowH, merges, cells, print: printOf(doc) }, rowOf: pl.rowOf, plan: pl };
  }

  CDB.sheetPages = { PAPERS, PX_PER_MM, paperOf, paperMm, printable, capacity, bodyAvail, widthOver, summary, toModel, pageModel, footerRow, rowVisible, sectionsOf, plateSection, plan };
})();
