/* =========================================================
   js/report/rowgroup.js : 板の表の「行のまとめ方」（板ごと／列の値ごと）と、折り返しで伸びる行の高さの見積もり
   ・板ごと（既定）：板 1 枚 = 1 行
   ・列ごと（table.by = 列ID）：その列の値（検査番号など）が同じ板を 1 行にまとめ、値の昇順に並べる
       行 entry = { row: 先頭の板, plates: その行にまとめた板, key: 列の値（表示用） }
   ・値のない板（列が空）は、最後の 1 行にまとめる
   ・外した板（NG など）は、まとめる対象に入れない（lot.live の板だけ）
   ・行の高さ：折り返す文字が長いとき、行を広げる（はみ出さない）。ページ送りもその高さで決める
   画面には依存しない（式の計算は model.js が行い、ここは文字の長さと並びだけを扱う）
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;

  const PX_PER_PT = 96 / 72;
  const PAD_X = 8; // セルの左右の余白（px）
  const PAD_Y = 6; // セルの上下の余白（px）
  const ASCII_EM = 0.56; // 半角文字の幅（文字サイズに対する比）
  const SAFETY = 1.06; // 見積もりの余裕（折り返しの位置の違いで 1 行増えるのを防ぐ）

  const natural = (a, b) => String(a).localeCompare(String(b), 'ja', { numeric: true });

  /** 帳票が「列ごとの行」か（ツールで作った帳票の板の表で、まとめる列が選ばれている） */
  const isGrouped = (preset) => !!(preset && preset.doc && preset.table && preset.table.by);

  /**
   * 板の表の行の一覧
   * @returns {{row:object, plates:object[], key:string}[]}
   */
  function entriesOf(preset, lot) {
    const by = preset.table && preset.table.by;
    if (!by || !preset.doc) return lot.plates.map((r) => ({ row: r, plates: [r], key: '' }));
    const map = new Map();
    (lot.live || lot.plates).forEach((r) => {
      const label = U.normValue(r.v ? r.v[by] : '');
      const k = U.normKey(label);
      let e = map.get(k);
      if (!e) { e = { row: r, plates: [], key: label }; map.set(k, e); }
      e.plates.push(r);
    });
    const list = Array.from(map.values());
    list.sort((a, b) => (a.key === '' ? 1 : 0) - (b.key === '' ? 1 : 0) || natural(a.key, b.key));
    return list;
  }

  /** 文字 1 つの幅（px）。全角は文字サイズ、半角は約 0.56 倍 */
  const charW = (ch, szPx) => (/[\u0000-\u007f｡-ﾟ]/.test(ch) ? szPx * ASCII_EM : szPx);

  /** 幅 widthPx のセルに text を折り返して入れたときの行数（改行も数える） */
  function lineCount(text, widthPx, szPx) {
    const usable = Math.max(szPx, widthPx - PAD_X);
    return String(text).split('\n').reduce((n, seg) => {
      let w = 0;
      for (const ch of seg) w += charW(ch, szPx);
      return n + Math.max(1, Math.ceil((w * SAFETY) / usable));
    }, 0);
  }

  /**
   * セルが必要とする高さ（px）。折り返しがオフなら 0（高さを変えない）
   * @param {{sz?:number, wrap?:any, lh?:number}} style
   */
  function needPx(text, widthPx, style, defaultSize) {
    const s = style || {};
    if (!s.wrap || text === '' || text === undefined || text === null) return 0;
    const szPx = (s.sz || defaultSize || 11) * PX_PER_PT;
    return Math.ceil(lineCount(text, widthPx, szPx) * szPx * (s.lh || 1.3) + PAD_Y);
  }

  /**
   * 行の高さの並び（px。1 行ずつの合計）を、1 ページの高さ avail に収まるように、ページに分ける
   * @param {number} maxRows 1 ページの行数の上限（手で決めた数。0 なら上限なし）
   * @returns {[number, number][]} ページごとの [先頭, 末尾の次]。行がなければ空
   */
  function paginate(heights, avail, maxRows) {
    const pages = [];
    let start = 0;
    let acc = 0;
    heights.forEach((h, i) => {
      const full = i > start && (acc + h > avail + 0.5 || (maxRows > 0 && i - start >= maxRows));
      if (full) { pages.push([start, i]); start = i; acc = 0; }
      acc += h;
    });
    if (heights.length) pages.push([start, heights.length]);
    return pages;
  }

  /**
   * 1 ページ分のモデルの行を、中身（改行・長い文字）に合わせて広げる（折り返すセルだけ。行をまたぐ結合は触らない）
   * @param {{rowH:number[], colW:number[], merges:object[], cells:Map}} model sheet-pages の pageModel の結果
   * @param {Map<string,{text:string}>} values renderPage の cells（キーは model と同じ 'r,c'）
   * @returns {number} 広げた行の数
   */
  function growRows(model, values, defaultSize) {
    const grown = new Set();
    values.forEach((v, k) => {
      const text = v && v.text;
      if (text === '' || text === undefined || text === null) return;
      const [r, c] = k.split(',').map(Number);
      const cell = model.cells.get(k);
      if (!cell || !cell.s || !cell.s.wrap || !(model.rowH[r] > 0)) return;
      const m = (model.merges || []).find((x) => r >= x.r0 && r <= x.r1 && c >= x.c0 && c <= x.c1);
      if (m && m.r1 > m.r0) return;
      let w = 0;
      for (let i = m ? m.c0 : c; i <= (m ? m.c1 : c); i++) w += model.colW[i] || 0;
      const need = needPx(String(text), w, cell.s, defaultSize);
      if (need > model.rowH[r]) { model.rowH[r] = need; grown.add(r); }
    });
    return grown.size;
  }

  CDB.rowGroup = { growRows, isGrouped, entriesOf, lineCount, needPx, paginate, natural };
})();
