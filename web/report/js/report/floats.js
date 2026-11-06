/* =========================================================
   js/report/floats.js : 自由に置く物（テキストボックス・図形・表・画像）の、出力用の描き方と位置
   ・nodeFor：値を入れた HTML の部品（画面の出力イメージ・PDF の印刷で使う）
   ・placeForPage：そのページでの位置（px・表の左上が原点）。ページ基準はそのまま、帯基準は帯の位置（板の表の行数で下がる）から
   ・toPng：Excel 用に画像にする（Excel の部品が図形・テキストボックスを扱えないため）
   位置の単位：データは mm、ここでの出力は px（96dpi）
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const SP = () => CDB.sheetPages;
  const RR = () => CDB.reportRender;
  const K = () => SP().PX_PER_MM;
  const SVGNS = 'http://www.w3.org/2000/svg';

  /** 図形の SVG（rect・ellipse・line・arrow）。大きさは px */
  function shapeSvg(f, wpx, hpx) {
    const sh = f.shape || {};
    const sw = Math.max(0.5, (sh.sw || 0.5) * K());
    const svg = document.createElementNS(SVGNS, 'svg');
    const pad = sw + 6; // 線の太さ・矢じりがはみ出さないように
    svg.setAttribute('width', String(wpx + pad * 2));
    svg.setAttribute('height', String(hpx + pad * 2));
    svg.setAttribute('viewBox', `${-pad} ${-pad} ${wpx + pad * 2} ${hpx + pad * 2}`);
    svg.style.cssText = `position:absolute;left:${-pad}px;top:${-pad}px;overflow:visible`;
    const mk = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k])); svg.appendChild(e); return e; };
    const stroke = sh.stroke || '#000000';
    const common = { stroke, 'stroke-width': String(sw), fill: sh.fill || 'none', 'stroke-linejoin': 'round' };
    if (sh.type === 'ellipse') mk('ellipse', Object.assign({ cx: wpx / 2, cy: hpx / 2, rx: Math.max(0.5, (wpx - sw) / 2), ry: Math.max(0.5, (hpx - sw) / 2) }, common));
    else if (sh.type === 'line' || sh.type === 'arrow') {
      const x1 = sh.fx ? wpx : 0; const y1 = sh.fy ? hpx : 0; const x2 = sh.fx ? 0 : wpx; const y2 = sh.fy ? 0 : hpx;
      mk('line', { x1, y1, x2, y2, stroke, 'stroke-width': String(sw), 'stroke-linecap': 'round' });
      if (sh.type === 'arrow') {
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const L = Math.max(8, sw * 4);
        const pt = (a) => `${x2 - L * Math.cos(ang + a)},${y2 - L * Math.sin(ang + a)}`;
        mk('polygon', { points: `${x2},${y2} ${pt(0.45)} ${pt(-0.45)}`, fill: stroke, stroke, 'stroke-width': '1', 'stroke-linejoin': 'round' });
      }
    } else mk('rect', Object.assign({ x: sw / 2, y: sw / 2, width: Math.max(0.5, wpx - sw), height: Math.max(0.5, hpx - sw) }, common));
    return svg;
  }

  const FONT = "font-family:'Yu Gothic','Meiryo',sans-serif;font-size:11pt;color:#000;";

  /** 値を入れた部品（位置は呼び出し側）。valueOf(r, c) は セルの値の文字（なければ ''） */
  function nodeFor(f, valueOf) {
    const k = K();
    const wpx = f.w * k;
    const hpx = f.h * k;
    const root = document.createElement('div');
    root.className = 'rp-float';
    root.style.cssText = `position:absolute;width:${wpx}px;height:${hpx}px;box-sizing:border-box;${FONT}--cpad:4px;`;
    if (f.kind === 'shape') { root.appendChild(shapeSvg(f, wpx, hpx)); return root; }
    if (f.kind === 'image') {
      const img = document.createElement('img');
      img.src = f.src; img.alt = '';
      img.style.cssText = `display:block;width:${wpx}px;height:${hpx}px;object-fit:fill`;
      root.appendChild(img);
      return root;
    }
    const t = f.table;
    const table = document.createElement('table');
    table.style.cssText = `border-collapse:collapse;table-layout:fixed;width:${wpx}px;`;
    const cg = document.createElement('colgroup');
    t.colW.forEach((fr) => { const c = document.createElement('col'); c.style.width = fr * wpx + 'px'; cg.appendChild(c); });
    table.appendChild(cg);
    const covered = new Set();
    const mergeAt = new Map();
    t.merges.forEach((m) => { mergeAt.set(m.r0 + ',' + m.c0, m); for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) covered.add(r + ',' + c); });
    const tb = document.createElement('tbody');
    table.appendChild(tb);
    for (let r = 0; r < t.nRows; r++) {
      const tr = document.createElement('tr');
      tr.style.height = t.rowH[r] + 'px';
      for (let c = 0; c < t.nCols; c++) {
        if (covered.has(r + ',' + c)) continue;
        const m = mergeAt.get(r + ',' + c);
        const cell = t.cells[r + ',' + c] || {};
        const td = document.createElement('td');
        if (m && m.r1 > m.r0) td.rowSpan = m.r1 - m.r0 + 1;
        if (m && m.c1 > m.c0) td.colSpan = m.c1 - m.c0 + 1;
        td.style.cssText = `padding:0 2px;overflow:hidden;${RR().cellCss(cell.s || {})}` + (cell.s && cell.s.wrap ? '' : ';white-space:pre');
        const text = valueOf(r, c);
        if (text) td.textContent = text;
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
    root.appendChild(table);
    return root;
  }

  /**
   * そのページでの位置（px。表の左上が原点）。出さない物は含めない
   * @param {object} preset
   * @param {number} pageIdx
   * @param {number} count 総ページ数
   * @param {{rowOf:Function, model:object}} layout RM.pageLayout の結果
   * @returns {{f:object, left:number, top:number}[]}
   */
  function placeForPage(preset, pageIdx, count, layout) {
    const out = [];
    (preset.floats || []).forEach((f) => {
      if (f.anchor === 'page') {
        if ((f.show === 'first' && pageIdx !== 0) || (f.show === 'last' && pageIdx !== count - 1)) return;
        out.push({ f, left: f.x * K(), top: f.y * K() });
        return;
      }
      const a = preset.doc && preset.doc.anchors && preset.doc.anchors[f.bandId];
      if (!a) return;
      const row = layout.rowOf(a.row);
      if (row === null || row === undefined) return; // その帯が出ないページ
      let top = 0;
      for (let r = 0; r < row; r++) top += layout.model.rowH[r] || 0;
      out.push({ f, left: f.x * K(), top: top + f.y * K() });
    });
    return out;
  }

  /** そのページの自由に置く物（値を入れた部品と位置）。res は RM.renderPage の結果 */
  function build(preset, res, pageIdx, count, layout) {
    return placeForPage(preset, pageIdx, count, layout).map((p) => {
      const node = nodeFor(p.f, (r, c) => { const v = res.floatCells && res.floatCells.get(p.f.id + '|' + r + ',' + c); return v ? v.text : ''; });
      node.style.left = p.left + 'px';
      node.style.top = p.top + 'px';
      return { f: p.f, left: p.left, top: p.top, w: p.f.w * K(), h: p.f.h * K(), node };
    });
  }

  /** 部品を PNG（data URL）にする（Excel 用）。scale 倍の大きさで描き、まわりに pad px の余白をつける */
  function toPng(node, wpx, hpx, scale, padPx) {
    const sc = scale || 2;
    return new Promise((resolve, reject) => {
      const pad = padPx === undefined ? 12 : padPx; // 図形の線・矢じりがはみ出す分（用紙の端に近いときは小さく）
      const clone = node.cloneNode(true);
      clone.style.left = pad + 'px';
      clone.style.top = pad + 'px';
      clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
      const W = wpx + pad * 2;
      const H = hpx + pad * 2;
      const xml = new XMLSerializer().serializeToString(clone);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * sc}" height="${H * sc}" viewBox="0 0 ${W} ${H}"><foreignObject x="0" y="0" width="${W}" height="${H}">${xml}</foreignObject></svg>`;
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = W * sc; cv.height = H * sc;
        cv.getContext('2d').drawImage(img, 0, 0);
        try { resolve({ src: cv.toDataURL('image/png'), pad }); } catch (err) { reject(err); }
      };
      img.onerror = () => reject(new Error('図形・テキストボックスを画像にできませんでした'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  CDB.reportFloats = { shapeSvg, nodeFor, placeForPage, build, toPng };
})();
