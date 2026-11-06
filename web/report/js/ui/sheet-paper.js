/* =========================================================
   js/ui/sheet-paper.js : 出力イメージの表を「用紙」として描く（用紙の輪郭・印刷できる範囲・板の表の帯と凡例）
   セル型に変換した帳票（preset.doc）の表（RR.sheet が作る table）を受け取り、置く要素を返す
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const UI = CDB.ui;
  const { el, icon } = U;
  const SP = () => CDB.sheetPages;

  /**
   * @param {HTMLTableElement} table RR.sheet(…, {headers:true}) の表
   * @param {{top:number, body:number, nRows:number, plates?:number|null}|null} bands 板の表の行（top）と、板の行数（body）。null なら帯なし
   * @param {object} d preset.doc
   * @returns {HTMLElement} 置く要素（印刷範囲の線を重ねた枠）
   */
  function decorate(table, bands, d, opt) {
    const plain = !!(opt && opt.plain); // 行番号・列見出しのない表（ブロックの帳票）
    const pr = SP().printable(d.page);
    const trs = Array.from(table.querySelectorAll('tbody > tr'));
    const cols = table.querySelector('colgroup');
    if (bands) {
      const kinds = [
        { name: 'ヘッダー（毎ページ）', cls: 'is-h', from: 0, to: bands.top - 1 },
        { name: `板の表（板ごとに繰り返す）`, cls: 'is-b', from: bands.top, to: bands.top + bands.body - 1 },
        { name: d.page.footer === 'every' ? 'フッター（毎ページ）' : 'フッター（最後のページ）', cls: 'is-f', from: bands.top + bands.body, to: bands.nRows - 1 }
      ].filter((k) => k.to >= k.from);
      cols.insertBefore(el('col', { style: 'width:26px' }), cols.firstChild);
      const hOf = (i) => parseFloat(trs[i + 1] && trs[i + 1].style.height) || 24;
      trs.forEach((tr, i) => {
        if (i === 0) { tr.insertBefore(el('th', { class: 'rp-band-corner' }), tr.firstChild); return; }
        const k = kinds.find((x) => x.from === i - 1);
        if (!k) return;
        // 縦書きの文字が行の高さを押し広げないよう、帯の高さを行の高さの合計に固定する。名前は短く、説明は下の凡例
        let h = 0;
        for (let r = k.from; r <= k.to; r++) h += hOf(r);
        const short = { 'is-h': 'ヘッダー', 'is-b': '板の表', 'is-f': 'フッター' }[k.cls];
        // 高さが足りない帯（1 行の板の表など）は、縦書きの文字が入らないのでアイコンにする（名前は下の凡例とツールチップ）
        const mark = h >= 60 ? el('span', { text: short }) : icon({ 'is-h': 'fa-heading', 'is-b': 'fa-repeat', 'is-f': 'fa-shoe-prints' }[k.cls]);
        tr.insertBefore(el('th', { class: 'rp-band ' + k.cls, rowspan: k.to - k.from + 1, title: k.name }, [el('div', { class: 'rp-band-in', style: `height:${h}px` }, [mark])]), tr.firstChild);
      });
      table.style.width = (parseFloat(table.style.width) || 0) + 26 + 'px';
    }
    // 用紙として描く：用紙の輪郭（白い紙）と、印刷できる範囲（用紙 − 余白）の点線。表が点線をはみ出す／下端を超えると、次のページ・縮小になる
    const K = SP().PX_PER_MM;
    const m = d.page.margin;
    const [pwMm, phMm] = SP().paperMm(d.page);
    const originX = (bands ? 26 : 0) + (plain ? 0 : 32); // 表の中でデータが始まる位置（行番号・帯の列の右）
    const originY = plain ? 0 : 24; // 列見出しの高さ
    const paperX = originX - m.l * K;
    const paperY = originY - m.t * K;
    const shiftX = Math.max(0, -paperX) + 10;
    const shiftY = Math.max(0, -paperY) + 10;
    const tableW = parseFloat(table.style.width) || 0;
    const totalW = Math.max(shiftX + tableW, shiftX + paperX + pwMm * K) + 10;
    const wrap = el('div', { class: 'rp-paper', style: `padding:${shiftY}px 0 0 ${shiftX}px;min-width:${totalW}px;min-height:${shiftY + paperY + phMm * K + 10}px` });
    wrap.dataset.w = String(Math.round(totalW));
    wrap.dataset.h = String(Math.round(shiftY + paperY + phMm * K + 10));
    wrap.appendChild(el('div', {
      class: 'rp-sheet-paper', style: `left:${shiftX + paperX}px;top:${shiftY + paperY}px;width:${pwMm * K}px;height:${phMm * K}px`,
      title: `${SP().paperOf(d.page.paper).label} ${d.page.orientation === 'landscape' ? '横' : '縦'}の用紙`
    }));
    wrap.appendChild(table);
    if (opt && opt.overlay) { // 自由に置く物（表の左上が原点）
      opt.overlay.style.cssText += `;position:absolute;left:${shiftX + (plain ? 0 : originX)}px;top:${shiftY + (plain ? 0 : originY)}px;z-index:4;pointer-events:none`;
      wrap.appendChild(opt.overlay);
    }
    wrap.appendChild(el('div', { class: 'rp-pagelabel', style: `left:${shiftX + originX}px;top:${shiftY + originY + pr.h + 3}px`, text: '↑ 印刷範囲の下端（これを超えた板は次のページになります）' }));
    wrap.appendChild(el('div', {
      class: 'rp-printbox', style: `left:${shiftX + originX}px;top:${shiftY + originY}px;width:${pr.w}px;height:${pr.h}px`,
      title: `印刷できる範囲（用紙 − 余白）。表がこの外にはみ出すと縮小され、下端を超えた板は次のページになります`
    }));
    if (bands) {
      // 帯の説明（色と文字）
      wrap.appendChild(el('div', { class: 'rp-legend' }, [
        el('span', { class: 'rp-legend-i is-h', text: 'ヘッダー：毎ページ' }),
        el('span', { class: 'rp-legend-i is-b', text: bands.plates !== null && bands.plates !== undefined ? `板の表：板ごとに繰り返す（このプレビューは ${bands.plates} 行）` : '板の表：板ごとに繰り返す' }),
        el('span', { class: 'rp-legend-i is-f', text: d.page.footer === 'every' ? 'フッター：毎ページ' : 'フッター：最後のページだけ' })
      ]));
    }
    return wrap;
  }

  UI.sheetPaper = { decorate };
})();
