/* =========================================================
   js/report/render.js : 帳票テンプレートの HTML 表示（プレビュー・PDF 用の印刷）
   ・Excel の列幅・行の高さ・結合・罫線・文字の書式をできるだけそのまま表示する
   ・overlay で、配置した項目（配置の表示）や出力する値（出力イメージ）を重ねる
   ・PDF はブラウザの印刷（「PDF として保存」）で出す。1 ページ＝ 1 用紙に縮小して収める
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const { el } = U;

  const BORDER = {
    thin: '1px solid', hair: '1px solid', medium: '2px solid', thick: '3px solid', double: '3px double',
    dotted: '1px dotted', dashed: '1px dashed', mediumDashed: '2px dashed', dashDot: '1px dashed',
    mediumDashDot: '2px dashed', dashDotDot: '1px dotted', mediumDashDotDot: '2px dotted', slantDashDot: '2px dashed'
  };
  const H_ALIGN = { left: 'left', center: 'center', right: 'right', centerContinuous: 'center', distributed: 'justify', justify: 'justify', fill: 'left' };
  const V_ALIGN = { top: 'top', middle: 'middle', bottom: 'bottom', distributed: 'middle', justify: 'middle' };
  // 用紙の大きさ（mm、縦向き）
  const PAPER_MM = { A3: [297, 420], A4: [210, 297], A5: [148, 210], B4: [257, 364], B5: [182, 257], letter: [216, 279], legal: [216, 356] };
  const PRINT_MARGIN_MM = 8;
  // @page の size に使う用紙の名前（CSS で通る名前）
  const PAPER_CSS = { letter: 'letter', legal: 'legal' };

  const key = (r, c) => r + ',' + c;

  function borderCss(spec) {
    if (!spec) return '';
    const [style, color] = spec.split(' ');
    return `${BORDER[style] || '1px solid'} ${color || '#000'}`;
  }

  function cellCss(st, right, bottom) {
    const s = st || {};
    const css = [];
    if (s.f) css.push(`font-family:'${s.f}',sans-serif`);
    if (s.b) css.push('font-weight:bold');
    if (s.i) css.push('font-style:italic');
    if (s.u) css.push('text-decoration:underline');
    if (s.sz) css.push(`font-size:${s.sz}pt`);
    if (s.color) css.push(`color:${s.color}`);
    if (s.bg) css.push(`background:${s.bg}`);
    if (s.h) css.push(`text-align:${H_ALIGN[s.h] || 'left'}`);
    css.push(`vertical-align:${V_ALIGN[s.v] || 'bottom'}`);
    // 段落：左のインデント（1 段 3mm）・左右の余白（mm）・先頭行の字下げ（文字）・行間（倍）。基準の余白は --cpad
    if (s.ind || s.pl) css.push(`padding-left:calc(var(--cpad, 2px) + ${(s.ind || 0) * 3 + (s.pl || 0)}mm)`);
    if (s.pr) css.push(`padding-right:calc(var(--cpad, 2px) + ${s.pr}mm)`);
    if (s.fi) css.push(`text-indent:${s.fi}em`);
    if (s.lh) css.push(`line-height:${s.lh}`);
    if (s.wrap) css.push('white-space:pre-wrap');
    if (s.bt) css.push(`border-top:${borderCss(s.bt)}`);
    if (s.bl) css.push(`border-left:${borderCss(s.bl)}`);
    const br = (right || s).br;
    const bb = (bottom || s).bb;
    if (br) css.push(`border-right:${borderCss(br)}`);
    if (bb) css.push(`border-bottom:${borderCss(bb)}`);
    return css.join(';');
  }

  /**
   * シートを表として描く
   * @param {object} model report-xlsx の sheetModel
   * @param {{range?:{r0,c0,r1,c1}, overlay?:Map<string,{text:string, cls?:string, title?:string, html?:Node}>,
   *          rowCls?:(r:number)=>string, headers?:boolean}} opts
   * @returns {HTMLTableElement}
   */
  function sheet(model, opts) {
    const o = opts || {};
    const rg = o.range || { r0: 0, c0: 0, r1: model.nRows - 1, c1: model.nCols - 1 };
    const overlay = o.overlay || new Map();
    const covered = new Set();
    const mergeAt = new Map();
    model.merges.forEach((m) => {
      if (m.r1 < rg.r0 || m.r0 > rg.r1 || m.c1 < rg.c0 || m.c0 > rg.c1) return;
      const r0 = Math.max(m.r0, rg.r0);
      const c0 = Math.max(m.c0, rg.c0);
      mergeAt.set(key(r0, c0), { r0, c0, r1: Math.min(m.r1, rg.r1), c1: Math.min(m.c1, rg.c1), top: m });
      for (let r = r0; r <= Math.min(m.r1, rg.r1); r++) for (let c = c0; c <= Math.min(m.c1, rg.c1); c++) if (r !== r0 || c !== c0) covered.add(key(r, c));
    });

    let width = 0;
    const cols = [];
    if (o.headers) cols.push(el('col', { style: 'width:32px' }));
    for (let c = rg.c0; c <= rg.c1; c++) { cols.push(el('col', { style: `width:${model.colW[c]}px` })); width += model.colW[c]; }
    const table = el('table', { class: 'rp-sheet', style: `width:${width + (o.headers ? 32 : 0)}px` }, [el('colgroup', {}, cols)]);
    const tbody = el('tbody');
    table.appendChild(tbody);

    if (o.headers) {
      const tr = el('tr', { class: 'rp-colhead' }, [el('th', { class: 'rp-corner' })]);
      for (let c = rg.c0; c <= rg.c1; c++) tr.appendChild(el('th', { text: U.colLetter(c), 'data-c': c }));
      tbody.appendChild(tr);
    }

    for (let r = rg.r0; r <= rg.r1; r++) {
      const h = model.rowH[r];
      const tr = el('tr', { style: `height:${h}px`, class: (o.rowCls ? o.rowCls(r) : '') + (h === 0 ? ' is-hidden' : '') });
      if (o.headers) tr.appendChild(el('th', { class: 'rp-rowhead', text: String(r + 1), 'data-r': r }));
      for (let c = rg.c0; c <= rg.c1; c++) {
        const k = key(r, c);
        if (covered.has(k)) continue;
        const m = mergeAt.get(k);
        const base = model.cells.get(k);
        const right = m ? model.cells.get(key(m.r0, m.c1)) : null;
        const bottom = m ? model.cells.get(key(m.r1, m.c0)) : null;
        const ov = overlay.get(k);
        const td = el('td', {
          'data-r': r, 'data-c': c,
          rowspan: m && m.r1 > m.r0 ? m.r1 - m.r0 + 1 : null,
          colspan: m && m.c1 > m.c0 ? m.c1 - m.c0 + 1 : null,
          style: cellCss(base && base.s, right && right.s, bottom && bottom.s),
          class: ov && ov.cls ? ov.cls : null,
          title: ov && ov.title ? ov.title : null
        });
        if (base && base.im) { td.classList.add('rp-imgcell'); td.appendChild(el('img', { class: 'rp-img', src: base.im, alt: '' })); }
        if (ov && ov.html) td.appendChild(ov.html);
        else {
          const text = ov ? ov.text : base ? base.text : '';
          if (text) td.appendChild(el('span', { class: 'rp-text' + (base && base.s && base.s.shrink ? ' is-shrink' : ''), text }));
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    return table;
  }

  /** 「縮小して全体を表示」のセルの文字を、セルの幅に収まる大きさにする（表が画面に置かれた後に呼ぶ） */
  function shrinkFit(table) {
    table.querySelectorAll('.rp-text.is-shrink').forEach((span) => {
      const avail = span.parentElement.clientWidth - 4;
      if (avail > 0 && span.scrollWidth > avail) {
        const size = parseFloat(getComputedStyle(span).fontSize) || 12;
        span.style.fontSize = Math.max(6, size * avail / span.scrollWidth) + 'px';
      }
    });
  }

  /** 印刷する範囲（印刷範囲が設定されていればそれ、なければ使われている範囲すべて） */
  function printRange(model, table) {
    const a = model.print.area;
    const r1 = Math.max(a ? a.r1 : model.nRows - 1, table ? table.bottom : -1);
    return a ? { r0: a.r0, c0: a.c0, r1: Math.min(r1, model.nRows - 1), c1: a.c1 } : { r0: 0, c0: 0, r1: model.nRows - 1, c1: model.nCols - 1 };
  }

  /**
   * 印刷（PDF として保存）
   * @param {{model:object, overlay:Map, range:object}[]} pages
   * @param {{title:string}} opts
   */
  function print(pages, opts) {
    const root = document.getElementById('printRoot') || document.body.appendChild(el('div', { id: 'printRoot' }));
    root.innerHTML = '';
    const first = pages[0].model.print;
    const mm = PAPER_MM[first.paper] || PAPER_MM.A4;
    const [pw, ph] = first.orientation === 'landscape' ? [mm[1], mm[0]] : mm;
    // ツールで作った帳票は余白（mm）を持つ。Excel のひな形は従来どおり 8 mm
    const mg = first.marginsMm || { t: PRINT_MARGIN_MM, b: PRINT_MARGIN_MM, l: PRINT_MARGIN_MM, r: PRINT_MARGIN_MM };
    const pxW = (v) => (v - mg.l - mg.r) * 96 / 25.4;
    const pxH = (v) => (v - mg.t - mg.b) * 96 / 25.4;
    const cssPaper = PAPER_CSS[first.paper] || first.paper;
    const style = el('style', { id: 'printPageStyle', text: `@page { size: ${cssPaper} ${first.orientation}; margin: ${mg.t}mm ${mg.r}mm ${mg.b}mm ${mg.l}mm; }` });
    const oldStyle = document.getElementById('printPageStyle');
    if (oldStyle) oldStyle.remove();
    document.head.appendChild(style);
    pages.forEach((p) => {
      const t = sheet(p.model, { range: p.range, overlay: p.overlay });
      // 表と、自由に置く物（位置は表の左上から）を 1 つの枠に入れ、まとめて用紙に収める
      const inner = el('div', { class: 'rp-print-inner', style: 'position:relative' }, [t]);
      (p.floats || []).forEach((fl) => inner.appendChild(fl.node));
      const box = el('div', { class: 'rp-print-page' }, [inner]);
      root.appendChild(box);
      root.style.display = 'block';
      shrinkFit(t);
      root.style.display = '';
      // 1 ページを 1 枚の用紙に収める（Excel の「1 ページに印刷」と同じ）
      const w = parseFloat(t.style.width) || 1;
      let h = 0;
      for (let r = p.range.r0; r <= p.range.r1; r++) h += p.model.rowH[r];
      const z = Math.min(1, pxW(pw) / w, pxH(ph) / Math.max(1, h));
      inner.style.zoom = String(Math.floor(z * 1000) / 1000);
    });
    const oldTitle = document.title;
    document.title = opts && opts.title ? opts.title : oldTitle;
    const cleanup = () => {
      document.title = oldTitle;
      root.innerHTML = '';
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(() => window.print(), 50);
  }

  CDB.reportRender = { sheet, print, printRange, shrinkFit, key, cellCss };
})();
