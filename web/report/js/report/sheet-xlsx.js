/* =========================================================
   js/report/sheet-xlsx.js : ツールで作った帳票を Excel（.xlsx）に書き出す（ExcelJS）
   1 ページ 1 シート。ページのモデル（js/report/sheet-pages.js）と、項目の値（renderPage の cells）から新しいブックを作る
   列幅・行の高さ・結合・書式・用紙・余白は、画面のプレビュー・印刷と同じ設定から作る
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});

  const DEFAULT_FONT = '游ゴシック';
  const argb = (hex) => 'FF' + String(hex || '#000000').replace('#', '').toUpperCase().padStart(6, '0').slice(-6);

  /** '細い線' の内部名（thin など）と色 → ExcelJS の罫線 */
  function borderOf(spec) {
    if (!spec) return undefined;
    const [style, color] = String(spec).split(' ');
    return { style: style || 'thin', color: { argb: argb(color) } };
  }

  /** 画面と同じ短い書式 → ExcelJS のセルの書式 */
  function styleOf(s, outer) {
    const o = outer || {};
    const out = { font: { name: s.f || DEFAULT_FONT, size: s.sz || 11, bold: !!s.b, italic: !!s.i, underline: !!s.u } };
    if (s.color) out.font.color = { argb: argb(s.color) };
    if (s.bg) out.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(s.bg) } };
    out.alignment = { horizontal: s.h || (s.ind ? 'left' : undefined), vertical: s.v || 'middle', wrapText: !!s.wrap, shrinkToFit: !!s.shrink };
    if (s.ind) out.alignment.indent = Math.min(15, Math.round(s.ind)); // セルのインデントは左の段数だけ（先頭行・右余白・行間は Excel にない）
    const b = {};
    const t = borderOf(o.bt !== undefined ? o.bt : s.bt);
    const l = borderOf(o.bl !== undefined ? o.bl : s.bl);
    const r = borderOf(o.br !== undefined ? o.br : s.br);
    const bt = borderOf(o.bb !== undefined ? o.bb : s.bb);
    if (t) b.top = t;
    if (l) b.left = l;
    if (r) b.right = r;
    if (bt) b.bottom = bt;
    if (Object.keys(b).length) out.border = b;
    return out;
  }

  /**
   * @param {{name:string, model:object, cells:Map}[]} jobs 1 ページ 1 シート。model はページのモデル、cells は項目の値（行・列は model と同じ番地）
   * @param {(done:number, total:number)=>Promise|void} onProgress
   * @returns {Promise<Blob>}
   */
  async function write(jobs, onProgress) {
    if (!window.ExcelJS) throw new Error('Excel を扱う部品（ExcelJS）を読み込めませんでした。インターネットに接続して開き直してください');
    const wb = new window.ExcelJS.Workbook();
    const used = new Set();
    for (let i = 0; i < jobs.length; i++) {
      const { model, cells } = jobs[i];
      const name = CDB.reportModel.sheetName(jobs[i].name, used);
      const pr = model.print;
      const paper = CDB.sheetPages.paperOf(pr.paper);
      const mg = pr.marginsMm || { t: 15, b: 15, l: 12, r: 12 };
      const inch = (mm) => mm / 25.4;
      const ws = wb.addWorksheet(name, {
        pageSetup: {
          paperSize: paper.xl, orientation: pr.orientation === 'landscape' ? 'landscape' : 'portrait',
          fitToPage: true, fitToWidth: 1, fitToHeight: 1,
          margins: { left: inch(mg.l), right: inch(mg.r), top: inch(mg.t), bottom: inch(mg.b), header: 0.3, footer: 0.3 }
        },
        views: [{ showGridLines: false }]
      });
      model.colW.forEach((px, c) => { ws.getColumn(c + 1).width = Math.max(1, (px - 5) / 7); });
      model.rowH.forEach((px, r) => { const row = ws.getRow(r + 1); row.height = px * 72 / 96; if (px === 0) row.hidden = true; });

      const mergeOf = (r, c) => model.merges.find((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) || null;
      // 書式（結合の中は、左上のセルに結合の外枠の罫線をまとめる）
      model.cells.forEach((cell, k) => {
        const [r, c] = k.split(',').map(Number);
        const m = mergeOf(r, c);
        if (m && (m.r0 !== r || m.c0 !== c)) return;
        let outer = null;
        if (m) {
          const at = (rr, cc) => (model.cells.get(rr + ',' + cc) || { s: {} }).s;
          outer = { bt: at(m.r0, m.c0).bt, bl: at(m.r0, m.c0).bl, br: at(m.r0, m.c1).br, bb: at(m.r1, m.c0).bb };
        }
        Object.assign(ws.getCell(r + 1, c + 1), { style: styleOf(cell.s || {}, outer) });
      });
      model.merges.forEach((m) => { if (m.r0 !== m.r1 || m.c0 !== m.c1) ws.mergeCells(m.r0 + 1, m.c0 + 1, m.r1 + 1, m.c1 + 1); });
      // 画像（結合したセルの枠いっぱいに置く）
      model.cells.forEach((cell, k) => {
        const im = cell.im && String(cell.im).match(/^data:image\/(png|jpeg|jpg|gif);base64,(.+)$/);
        if (!im) return;
        const [r, c] = k.split(',').map(Number);
        const m = mergeOf(r, c) || { r0: r, c0: c, r1: r, c1: c };
        if (!wb.__imgs) wb.__imgs = new Map();
        if (!wb.__imgs.has(cell.im)) wb.__imgs.set(cell.im, wb.addImage({ base64: im[2], extension: im[1] === 'jpg' ? 'jpeg' : im[1] }));
        ws.addImage(wb.__imgs.get(cell.im), { tl: { col: m.c0, row: m.r0 }, br: { col: m.c1 + 1, row: m.r1 + 1 }, editAs: 'oneCell' });
      });
      // 値
      cells.forEach((val, k) => {
        const [r, c] = k.split(',').map(Number);
        const m = mergeOf(r, c);
        const at = m ? { r: m.r0, c: m.c0 } : { r, c };
        const cell = ws.getCell(at.r + 1, at.c + 1);
        if (typeof val.num === 'number' && Number.isFinite(val.num) && val.place && val.place.show === 'value') {
          cell.value = val.num;
          if (val.numFmt && val.numFmt !== 'General') cell.numFmt = val.numFmt;
        } else cell.value = val.text === '' ? null : val.text;
      });
      // 自由に置く物（テキストボックス・図形・表・画像）：Excel の部品が扱えないので、画像にして位置を合わせて貼る
      const at = (arr, v) => { let acc = 0; for (let n = 0; n < arr.length; n++) { if (v < acc + arr[n]) return n + (v - acc) / arr[n]; acc += arr[n]; } return arr.length - 0.001; };
      for (const fl of jobs[i].floats || []) {
        const pad = Math.max(0, Math.min(12, fl.left, fl.top));
        const png = await CDB.reportFloats.toPng(fl.node, fl.w, fl.h, 2, pad);
        const id = wb.addImage({ base64: png.src.split(',')[1], extension: 'png' });
        ws.addImage(id, { tl: { col: at(model.colW, fl.left - pad), row: at(model.rowH, fl.top - pad) }, ext: { width: fl.w + pad * 2, height: fl.h + pad * 2 }, editAs: 'oneCell' });
      }
      if (onProgress) await onProgress(i + 1, jobs.length);
    }
    const out = await wb.xlsx.writeBuffer();
    return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  CDB.sheetXlsx = { write, styleOf };
})();
