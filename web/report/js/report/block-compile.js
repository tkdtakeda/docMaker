/* =========================================================
   js/report/block-compile.js : ブロックの帳票 → セル型の帳票（既存の描画・ページ送り・Excel 出力が使う形）への変換
   ・帯・区画・表の縦横の境界をすべて合わせた 1 つの格子（列・行）に、結合セルで再現する（Excel 出力もこの格子）
     境界は 0.5mm 単位に丸める。0.5mm 以内に近い境界は 1 つにそろえる（細い列・行を作らない）
   ・セルの中身（文字・{変数}・式）は、項目（text／formula）と配置（places）に変える
   ・変換の結果は preset.doc / places / items / table に書く（保存される。元は preset.blocks）
   画面には依存しない
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const BD = () => CDB.blockDoc;
  const SD = () => CDB.sheetDoc;
  const SP = () => CDB.sheetPages;
  const RI = () => CDB.reportItems;

  const SNAP = 2; // 0.5mm の単位（u）で、この差（1mm）以内の境界は 1 つにする（細すぎる列・行を作らない）
  const MAX_UNIFIED = 400; // 変換後の行・列の数の目安（超えたら警告）

  /* ---------- {変数} ---------- */
  /** {変数名} → 式の部品。ツールの値（ページ・枚数など）以外は、データの列 [列名] */
  const VARS = {
    'ページ': 'PAGENO()', '総ページ': 'PAGECOUNT()', '出力日': 'TODAY()',
    '行番号': 'ROWNO()', 'ロット名': 'LOTNAME()' // docMaker：ロットごとに使うので、板の枚数（板数・b/a・行板数）は取り込んでいない
  };
  const varExpr = (name) => VARS[name] || `[${name}]`;
  const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;

  /** 中身の文字を式（または固定の文字）に変える。{…} がなければ null（固定の文字） */
  const halfBraces = (t) => String(t).replace(/｛/g, '{').replace(/｝/g, '}');

  /** 文字列（"…"）・[…]・(…) の外にある | で分ける（式の中の | を壊さない） */
  function splitTop(str) {
    const out = [];
    let cur = '';
    let q = false;
    let br = 0;
    let par = 0;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') { if (q && s[i + 1] === '"') { cur += '""'; i++; continue; } q = !q; }
      else if (!q && ch === '[') br++;
      else if (!q && ch === ']') br = Math.max(0, br - 1);
      else if (!q && ch === '(') par++;
      else if (!q && ch === ')') par = Math.max(0, par - 1);
      if (!q && br === 0 && par === 0 && (ch === '|' || ch === '｜')) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  /**
   * {…} の中身を、変数名（または式）とプロパティに分ける。{変数名|桁=2|区切り|前=約|後=mm|空=－|埋=3}（桁は {変数名|2} とも書ける）
   * 中身が = で始まれば式：{=[板厚]-[公差]|桁=2}（expr に式、name は '=式'）
   * @returns {{name:string, expr?:string, props:{digits?:number, comma?:boolean, round?:string, pre?:string, post?:string, blank?:string, pad?:number, range?:boolean}, bad:string[]}}
   */
  function parseVar(inner) {
    const parts = splitTop(String(inner)).map((x) => x.trim());
    const name = parts.shift();
    const props = {};
    const bad = [];
    parts.forEach((tok) => {
      if (tok === '') return;
      const m = tok.match(/^([^=＝:：]+?)\s*[=＝:：]\s*(.*)$/);
      const key = (m ? m[1] : tok).normalize('NFKC');
      const val = m ? m[2] : '';
      const num = /^\d{1,2}$/.test(val.normalize('NFKC')) ? Number(val.normalize('NFKC')) : null;
      if (!m && /^\d{1,2}$/.test(key)) props.digits = Math.min(15, Number(key));
      else if ((key === '桁' || key === '小数') && num !== null) props.digits = Math.min(15, num);
      else if (!m && (key === '区切り' || key === '桁区切り' || key === ',')) props.comma = true;
      else if ((key === '丸' || key === '丸め' || key === '規則') && m) { const mode = CDB.formula.ruleOf(val); if (mode) props.round = mode; else bad.push(tok); }
      else if (key === '前' && m) props.pre = val;
      else if ((key === '後' || key === '単位') && m) props.post = val;
      else if (key === '空' && m) props.blank = val;
      else if (key === '埋' && num !== null) props.pad = Math.min(10, num);
      // docMaker：|まとめ・|間・|行（検査番号ごとの連続まとめ）は CDB の特別な機能なので取り込んでいない（書けば「読めない書式」と知らせる）
      else if (key === '連続' && !m) props.runs = true; // 分けずに、全体を連続部まとめ
      else bad.push(tok);
    });
    const res = { name, props, bad };
    if (/^[=＝]/.test(name)) res.expr = name.replace(/^[=＝]/, '').trim();
    return res;
  }

  /** 変数名とプロパティを {…} の文字にする（画面の入力欄からの書き換え用） */
  function serializeVar(name, props) {
    const p = props || {};
    const out = [name];
    if (p.digits !== undefined && p.digits !== '' && p.digits !== null) out.push('桁=' + p.digits);
    if (p.comma) out.push('区切り');
    if (p.round) out.push('丸=' + (CDB.formula.RULE_CODE[p.round] || 'B'));
    if (p.pad) out.push('埋=' + p.pad);
    if (p.runs) out.push('連続');
    if (p.pre) out.push('前=' + p.pre);
    if (p.post) out.push('後=' + p.post);
    if (p.blank) out.push('空=' + p.blank);
    return '{' + out.join('|') + '}';
  }

  /** 文字の中の {…} を、位置つきで一覧にする（全角の ｛｝ も）。UI がプロパティを書き換えるのに使う */
  function tokensOf(text) {
    const out = [];
    const re = /[{｛]([^{}｛｝]+)[}｝]/g;
    let m;
    while ((m = re.exec(String(text)))) { const v = parseVar(m[1].trim()); out.push({ start: m.index, end: m.index + m[0].length, raw: m[0], name: v.name, props: v.props, bad: v.bad }); }
    return out;
  }

  /** プロパティつきの変数を、式にする。値が数値でなければ、元の値のまま（エラーにしない） */
  function formatExpr(v) {
    // （docMaker：「まとめ」＝検査番号ごとの連続まとめは取り込んでいない）
    // 連続：分けずに全体を 1 つにまとめる。表の行では、その行にまとめた板（検査番号ごとの行など）が対象
    const all = `ALL(${varExpr(v.name)})`;
    const base = v.expr !== undefined ? `(${v.expr})` : v.props.runs ? `RANGES(${all})` : varExpr(v.name); // 式は括弧で包む（前後の文字・桁の指定と混ざらないように）
    const p = v.props;
    let core = base;
    if (p.digits !== undefined && p.round) core = `IFERROR(FIXED(${CDB.formula.rawRefs(base)}, ${p.digits}, ${p.comma ? 'FALSE' : 'TRUE'}, "${CDB.formula.RULE_CODE[p.round]}"), ${base})`; // 規則を選んだら、データ側で丸める前の値から丸める
    else if (p.digits !== undefined) core = `IFERROR(FIXED(${base}, ${p.digits}${p.comma ? '' : ', TRUE'}), ${base})`;
    else if (p.comma) core = base; // 区切りは桁と一緒に指定する（警告は parseVar の呼び出し側で出す）
    if (p.pad) core = `IF(LEN(${core})>=${p.pad}, ${core}, RIGHT("${'0'.repeat(p.pad)}" & ${core}, ${p.pad}))`;
    const parts = [];
    if (p.pre) parts.push(quote(p.pre));
    parts.push(core);
    if (p.post) parts.push(quote(p.post));
    const inner = parts.join(' & ');
    return p.blank !== undefined || p.pre || p.post ? `IF(ISBLANK(${base}), ${quote(p.blank || '')}, ${inner})` : inner;
  }

  /** 中身の文字を式（または固定の文字）に変える。{…} がなければ null（固定の文字）。onWarn(v)：読めないプロパティ・桁なしの区切りがあったとき */
  function templateExpr(text, onWarn) {
    const parts = [];
    let rest = halfBraces(text);
    let any = false;
    for (;;) {
      const m = rest.match(/\{([^{}]+)\}/);
      if (!m) break;
      any = true;
      if (m.index > 0) parts.push(quote(rest.slice(0, m.index)));
      const v = parseVar(m[1].trim());
      if (v.expr !== undefined && onWarn) { const chk = CDB.formula.compile(convertRefs(v.expr, () => 'x')); /* C3 などは ITEM に直してから、式の書き方を確かめる */ if (chk.error) v.exprError = chk.error.message; }
      if (onWarn && (v.bad.length || v.exprError || (v.props.comma && v.props.digits === undefined) || (v.props.round && v.props.digits === undefined))) onWarn(v);
      parts.push(v.expr !== undefined ? (Object.keys(v.props).length ? formatExpr(v) : `(${v.expr})`) : Object.keys(v.props).length ? formatExpr(v) : varExpr(v.name));
      rest = rest.slice(m.index + m[0].length);
    }
    if (!any) return null;
    if (rest) parts.push(quote(rest));
    return parts.join(' & ');
  }

  const colNo = (letters) => letters.split('').reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const colName = (i) => U.colLetter(i);

  /**
   * 式の中の C3・C3:C12 を fn で置き換える（文字列・[列名]・{…} の中は触らない）
   * fn(a, b) … a・b は {r, c}（0 始まり）。b は範囲の終わり（単独なら null）。置き換えの文字列を返す（null なら そのまま）
   */
  function mapRefs(expr, fn) {
    let out = '';
    let i = 0;
    const s = String(expr);
    const word = /[A-Za-z0-9_.]/;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') { // 文字列
        let j = i + 1;
        while (j < s.length) { if (s[j] === '"') { if (s[j + 1] === '"') { j += 2; continue; } break; } j++; }
        out += s.slice(i, j + 1); i = j + 1; continue;
      }
      if (ch === '[' || ch === '{') { const close = ch === '[' ? ']' : '}'; const j = s.indexOf(close, i); const e = j < 0 ? s.length - 1 : j; out += s.slice(i, e + 1); i = e + 1; continue; }
      if (/[A-Za-z]/.test(ch) && (i === 0 || !word.test(s[i - 1]))) {
        const m = s.slice(i).match(/^([A-Za-z]{1,2})(\d+)(?::([A-Za-z]{1,2})(\d+))?(?![A-Za-z0-9_.(])/);
        if (m) {
          const a = { r: Number(m[2]) - 1, c: colNo(m[1].toUpperCase()) };
          const b = m[3] ? { r: Number(m[4]) - 1, c: colNo(m[3].toUpperCase()) } : null;
          const rep = fn(a, b);
          out += rep === null || rep === undefined ? m[0] : rep;
          i += m[0].length; continue;
        }
      }
      out += ch; i++;
    }
    return out;
  }

  /** 式の中の C3・C3:C12 を ITEM("…")・ITEMS("…") に直す。refOf(r,c) は項目の id か null */
  function convertRefs(expr, refOf) {
    return mapRefs(expr, (a, b) => {
      if (!b) { const id = refOf(a.r, a.c); return id ? `ITEM(${quote(id)})` : '""'; }
      const ids = [];
      for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) { const id = refOf(r, c); if (id) ids.push(quote(id)); }
      return ids.length ? `ITEMS(${ids.join(',')})` : '""';
    });
  }

  /**
   * 行・列の挿入／削除に合わせて、表の中の式（= で始まる中身）の C3・C3:C12 を書き換える
   * @param {object} t 表
   * @param {'row'|'col'} kind
   * @param {number} at 挿入する位置、または削除する最初の行・列
   * @param {number} n 挿入・削除した数
   * @param {boolean} deleted 削除なら true
   * @returns {number} 削除した行・列を参照していて、空にした参照の数
   */
  function shiftRefs(t, kind, at, n, deleted) {
    const k = kind === 'row' ? 'r' : 'c';
    let lost = 0;
    const end = at + n - 1;
    const move = (v) => (deleted ? (v < at ? v : v > end ? v - n : null) : (v >= at ? v + n : v));
    Object.keys(t.cells).forEach((key) => {
      const cell = t.cells[key];
      if (cell.t === undefined || !/^\s*[=＝]/.test(String(cell.t))) return;
      const at2 = (p, v) => Object.assign({}, p, { [k]: v });
      const label = (p) => colName(p.c) + (p.r + 1);
      cell.t = mapRefs(String(cell.t), (a, b) => {
        if (!b) {
          const v = move(a[k]);
          if (v === null) { lost++; return '""'; }
          return v === a[k] ? null : label(at2(a, v));
        }
        let lo = Math.min(a[k], b[k]);
        let hi = Math.max(a[k], b[k]);
        let nlo;
        let nhi;
        if (deleted) {
          nlo = lo < at ? lo : lo <= end ? at : lo - n;
          nhi = hi < at ? hi : hi <= end ? at - 1 : hi - n;
          if (nhi < nlo) { lost++; return '""'; }
        } else { nlo = lo >= at ? lo + n : lo; nhi = hi >= at ? hi + n : hi; }
        if (nlo === lo && nhi === hi) return null;
        const first = a[k] <= b[k] ? at2(a, nlo) : at2(a, nhi);
        const last = a[k] <= b[k] ? at2(b, nhi) : at2(b, nlo);
        return `${label(first)}:${label(last)}`;
      });
    });
    return lost;
  }

  /* ---------- 境界のそろえ ---------- */
  /** 数の並びを、SNAP 以内の近いもの同士 1 つにまとめる。返す関数 snap(x) は、まとめた代表の値 */
  function snapper(values) {
    const sorted = Array.from(new Set(values)).sort((a, b) => a - b);
    const map = new Map();
    const kept = [];
    sorted.forEach((v) => {
      if (kept.length && v - kept[kept.length - 1] <= SNAP) map.set(v, kept[kept.length - 1]);
      else { kept.push(v); map.set(v, v); }
    });
    return { kept, snap: (v) => map.get(v), index: (v) => kept.indexOf(map.get(v)) };
  }

  const uOfMm = (mm) => Math.round(mm * 2);
  const uOfPx = (px) => Math.round((px / SP().PX_PER_MM) * 2);
  const pxOfU = (u) => (u / 2) * SP().PX_PER_MM;

  /* ---------- 変換 ---------- */
  /**
   * @param {object} B blocks
   * @returns {{doc, places, items, table, warnings:string[]}}
   */
  function compile(B) {
    const warnings = [];
    const page = B.page;
    const W = uOfMm(BD().printWidthMm(page));
    const entries = [];
    BD().SECTIONS.forEach((sec) => B[sec].forEach((band) => entries.push({ band, sec })));

    /* 1) 各帯の区画の位置（u）と、表の列・行の境界 */
    entries.forEach((e) => {
      const n = e.band.zones.length;
      const gapsU = BD().zoneGapsMm(e.band).map(uOfMm);
      const gapSumU = gapsU.reduce((a, b) => a + b, 0);
      const used = e.band.used > 0 && e.band.used < 1 ? e.band.used : 1; // 1 未満なら、右に空きを残す
      const avail = Math.round((W - gapSumU) * used);
      const sum = e.band.zones.reduce((a, z) => a + z.w, 0) || 1;
      let x = 0;
      e.zones = e.band.zones.map((z, i) => {
        const wU = i === n - 1 ? (used === 1 ? W - x : Math.round((avail * z.w) / sum)) : Math.round((avail * z.w) / sum);
        const o = { z, x0: x, x1: x + wU, t: z.block };
        x += wU + (gapsU[i] || 0);
        if (o.t && BD().isImage(o.t)) {
          // 画像：区画の中の幅・位置から、列の境界と行の境界を決める（縦横比で高さが決まる）
          const zoneMm = (wU * 0.5);
          const sz = BD().imageSizeMm(o.t, zoneMm);
          o.cols = [o.x0 + uOfMm(sz.off), o.x0 + uOfMm(sz.off) + uOfMm(sz.w)];
          o.rows = [0, uOfMm(sz.h)];
          o.h = uOfMm(sz.h);
        } else if (o.t) {
          let acc = 0;
          o.cols = [o.x0].concat(o.t.colW.map((f, j) => { acc += f; return j === o.t.nCols - 1 ? o.x1 : o.x0 + Math.round(acc * wU); }));
          let y = 0;
          o.rows = [0].concat(o.t.rowH.map((h) => (y += uOfPx(h))));
          o.h = y;
        } else o.h = 0;
        return o;
      });
      const content = Math.max(0, ...e.zones.map((o) => o.h));
      e.hU = e.band.h > 0 ? uOfPx(e.band.h) : content;
      if (e.band.h > 0 && content > e.hU) warnings.push(`帯の高さを固定していますが、中の表が高さを超えています（${Math.round((content - e.hU) / 2)}mm）。下の帯に重ねず、表の高さで出します`);
      e.hU = Math.max(e.hU, content);
      // 「高さを合わせる」の区画：行の高さを比例して伸ばし、帯の高さに合わせる
      e.zones.forEach((o) => {
        if (o.rows && o.t && !BD().isImage(o.t) && (o.z.align || e.band.align) === 'stretch' && o.h > 0 && o.h < e.hU) {
          const f = e.hU / o.h;
          o.rows = o.rows.map((y) => Math.round(y * f));
          o.rows[o.rows.length - 1] = e.hU;
          o.h = e.hU;
        }
      });
      e.gapY = uOfMm(e.band.gap || 0);
    });

    /* 2) 列の境界を全部そろえる */
    const xs = [0, W];
    entries.forEach((e) => e.zones.forEach((o) => { xs.push(o.x0, o.x1); if (o.cols) xs.push(...o.cols); }));
    const X = snapper(xs);
    const nCols = X.kept.length - 1;
    const colU = [];
    for (let i = 0; i < nCols; i++) colU.push(X.kept[i + 1] - X.kept[i]);

    /* 3) 行：帯ごとに、帯の中の表の行の境界をそろえて積む */
    const rowU = [];
    const sections = []; // 本文の区間（改ページで分ける）：{r0, r1}
    let curSec = null;
    let headRows = null; // ヘッダーの帯の行数
    const rowShow = {}; // 行 → 'first'|'last'（ヘッダー・フッターの帯の表示ページ。なければ全ページ）
    const anchors = {}; // 帯 → 格子の最初の行（自由に置く物を帯に固定するときの基準）
    let rowBase = 0;
    let fixedFooter = 0;
    entries.forEach((e) => {
      const ys = [0, e.hU];
      e.zones.forEach((o) => {
        if (!o.rows) return;
        const al = o.z.align || e.band.align;
        const off = al === 'bottom' ? e.hU - o.h : al === 'middle' ? Math.round((e.hU - o.h) / 2) : 0;
        o.off = off;
        o.rows.forEach((y) => ys.push(y + off));
      });
      const Y = snapper(ys);
      e.Y = Y;
      e.base = rowBase;
      anchors[e.band.id] = { row: rowBase };
      if (e.sec !== 'header' && headRows === null) headRows = rowBase;
      if (e.sec === 'bands' && (!curSec || (e.band.breakBefore && curSec.r1 >= curSec.r0))) { // 最初の帯、または改ページの帯から、新しい区間
        if (curSec) sections.push(curSec);
        curSec = { r0: rowBase, r1: rowBase - 1 };
      }
      for (let i = 0; i < Y.kept.length - 1; i++) rowU.push(Y.kept[i + 1] - Y.kept[i]);
      rowBase += Y.kept.length - 1;
      e.spacer = null;
      if (e.gapY > 0) { rowU.push(e.gapY); e.spacer = rowBase; rowBase += 1; }
      if (e.sec !== 'bands' && e.band.show && e.band.show !== 'all') for (let r = e.base; r < rowBase; r++) rowShow[r] = e.band.show;
      if (e.sec === 'bands' && curSec) curSec.r1 = rowBase - 1;
      if (e.sec === 'footer') fixedFooter += Y.kept.length - 1 + (e.gapY > 0 ? 1 : 0);
    });
    const nRows = rowU.length;
    if (curSec) sections.push(curSec);
    if (headRows === null) headRows = nRows;
    if (!sections.length) sections.push({ r0: headRows, r1: headRows - 1 });
    if (nCols > MAX_UNIFIED || nRows > MAX_UNIFIED) warnings.push(`境界が多いため、Excel のセルが多くなります（${nRows} 行 × ${nCols} 列）。表の列の位置をそろえると減ります`);
    if (!nRows || !nCols) return { doc: SD().blank(1, 1).doc, places: [], items: [], table: null, warnings: ['帯がありません'], floats: compileFloats(B, warnings).floats, floatItems: [] };

    /* 4) 格子に、表のセルを置く */
    const doc = { nRows, nCols, colW: colU.map((u) => Math.max(2, pxOfU(u))), rowH: rowU.map((u) => Math.max(2, pxOfU(u))), cells: {}, merges: [], page: Object.assign({}, page) };
    const places = [];
    const items = [];
    let table = null;
    const key = BD().key;
    const edgeKeys = ['bt', 'br', 'bb', 'bl'];

    entries.forEach((e) => e.zones.forEach((o) => {
      const t = o.t;
      if (!t) return;
      if (BD().isImage(t)) { // 画像：境界で囲んだ 1 つの結合セルに、画像を載せる
        const R0 = e.base + e.Y.index(o.rows[0] + (o.off || 0));
        const R1 = e.base + e.Y.index(o.rows[1] + (o.off || 0)) - 1;
        const C0 = X.index(o.cols[0]);
        const C1 = X.index(o.cols[1]) - 1;
        if (R1 < R0 || C1 < C0) return;
        doc.cells[key(R0, C0)] = { s: {}, im: t.src };
        if (R1 > R0 || C1 > C0) doc.merges.push({ r0: R0, c0: C0, r1: R1, c1: C1 });
        return;
      }
      const mergeOf = (r, c) => t.merges.find((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) || null;
      const colAt = (j) => X.index(o.cols[j]);
      const rowAt = (i) => e.base + e.Y.index(o.rows[i] + (o.off || 0));
      const itemId = (r, c) => `bi_${t.id}_${r}_${c}`;
      const textOf = (r, c) => { const m = mergeOf(r, c); if (m && (m.r0 !== r || m.c0 !== c)) return ''; const cell = t.cells[key(r, c)]; return cell && cell.t !== undefined ? halfBraces(cell.t) : ''; };
      const refOf = (r, c) => (r >= 0 && c >= 0 && r < t.nRows && c < t.nCols && textOf(r, c) !== '' ? itemId(r, c) : null);

      for (let r = 0; r < t.nRows; r++) {
        for (let c = 0; c < t.nCols; c++) {
          const m = mergeOf(r, c);
          if (m && (m.r0 !== r || m.c0 !== c)) continue; // 結合の左上だけ見る
          const r1 = m ? m.r1 : r;
          const c1 = m ? m.c1 : c;
          const cell = t.cells[key(r, c)] || {};
          const style = Object.assign({}, cell.s || {});
          // 一定間隔の罫線（N 列ごと）：その列の右の線と、次の列の左の線に、同じ線を引く
          const cr = t.rules && t.rules.cols;
          if (cr) {
            if ((c1 + 1) % cr.every === 0 && c1 < t.nCols - 1) style.br = BD().ruleSpec(cr);
            if (c > 0 && c % cr.every === 0) style.bl = BD().ruleSpec(cr);
          }
          const text = textOf(r, c);
          // 「まとめ」の変数は長くなることがあるので、折り返しをオンにする（はみ出さないよう、行の高さは出力のときに広げる）
          if (/[|｜]\s*連続\s*[}｝|｜]/.test(text)) style.wrap = 1;
          const R0 = rowAt(r);
          const R1 = rowAt(r1 + 1) - 1;
          const C0 = colAt(c);
          const C1 = colAt(c1 + 1) - 1;
          if (R1 < R0 || C1 < C0) continue;
          const hasStyle = Object.keys(style).length > 0;
          const span = R1 > R0 || C1 > C0;
          if (!hasStyle && text === '' && !m && !(cell.x && cell.x.first)) continue;
          // 左上は全部の書式。結合の中の他のセルは、塗りと外側の罫線だけ（Excel が結合の枠線を引くため）
          doc.cells[key(R0, C0)] = { s: style };
          if (span) {
            doc.merges.push({ r0: R0, c0: C0, r1: R1, c1: C1 });
            for (let rr = R0; rr <= R1; rr++) {
              for (let cc = C0; cc <= C1; cc++) {
                if (rr === R0 && cc === C0) continue;
                const s = {};
                if (style.bg) s.bg = style.bg;
                if (rr === R0 && style.bt) s.bt = style.bt;
                if (rr === R1 && style.bb) s.bb = style.bb;
                if (cc === C0 && style.bl) s.bl = style.bl;
                if (cc === C1 && style.br) s.br = style.br;
                if (Object.keys(s).length) doc.cells[key(rr, cc)] = { s };
              }
            }
          }
          if (text !== '' || (t.rep && r >= t.rep.top && r <= t.rep.bottom && cell.x && cell.x.first)) {
            const item = buildItem(t, r, c, text, cell.x, refOf, itemId(r, c), warnings);
            items.push(item);
            places.push({ id: 'pl_' + item.id, r: R0, c: C0, item: item.id, show: 'value' });
          }
        }
      }
      if (t.rep) {
        const top = rowAt(t.rep.top);
        const bottom = rowAt(t.rep.bottom + 1) - 1;
        if (table) warnings.push('板の表が 2 つあります。最初の 1 つだけを使います');
        else if (bottom - top !== t.rep.bottom - t.rep.top) warnings.push('板の表の繰り返す行が、格子の行と合っていません（同じ帯に別の表があるため）');
        else { table = { top, bottom, by: t.repBy || '' }; if (t.rules && t.rules.rows) doc.rowRule = { every: t.rules.rows.every, spec: BD().ruleSpec(t.rules.rows) }; }
      }
    }));
    // 辺の重複を除く（結合の中の線が隣と食い違わないように、使わなかった key は残さない）
    edgeKeys.forEach(() => {});
    const prn = SP().printable(page);
    const sumH = (a, b) => { let x = 0; for (let r = a; r <= b; r++) x += doc.rowH[r] || 0; return x; };
    const fixedH = sumH(nRows - fixedFooter, nRows - 1);
    const headH = sumH(0, headRows - 1);
    sections.forEach((sc, i) => {
      const hasPlate = table && table.top >= sc.r0 && table.top <= sc.r1;
      const label = sections.length > 1 ? `${i + 1} つ目の区間` : '';
      if (hasPlate) {
        const body = sumH(table.top, table.bottom) || 1;
        const rest = prn.h - headH - sumH(sc.r0, table.top - 1) - sumH(table.bottom + 1, sc.r1) - fixedH;
        if (!(page.rows > 0) && rest < body) warnings.push(`${label ? label + 'は、' : ''}板の表より上と下の帯が、用紙の高さをほぼ使い切っています（1 ページに板が入りません）。帯の高さを減らすか、用紙・余白を見直してください`);
        else if (!(page.rows > 0) && Math.floor(rest / body) <= 2) warnings.push(`1 ページに入る板が ${Math.max(1, Math.floor(rest / body))} 枚だけです。帯の高さを減らすか、用紙を大きくしてください`);
      } else {
        const over = headH + sumH(sc.r0, sc.r1) + fixedH - prn.h;
        if (over > 2) warnings.push(`${label ? label + 'の' : ''}内容が用紙の高さを ${Math.round(over / SP().PX_PER_MM)}mm 超えています。印刷・Excel では縮小されます（帯の高さを減らすか、用紙を大きくしてください）`);
      }
    });
    doc.anchors = anchors;
    doc.sections = sections;
    doc.headRows = headRows;
    doc.rowShow = rowShow;
    doc.page.fixedFooter = fixedFooter;
    if (table && fixedFooter && table.top >= nRows - fixedFooter) warnings.push('板の表がフッターにあります');
    if (!table) doc.page.fixedFooter = 0;
    const fl = compileFloats(B, warnings);
    return { doc, places, items, table, warnings, floats: fl.floats, floatItems: fl.items };
  }

  /** 自由に置く物（text・table は中身を項目にする。値の計算は帯の表と同じ）。位置・大きさ・描き方を、描画側が使う形にする */
  function compileFloats(B, warnings) {
    const floats = [];
    const items = [];
    const key = BD().key;
    (B.floats || []).forEach((f) => {
      const sz = BD().floatSizeMm(f);
      const o = { id: f.id, kind: f.kind, anchor: f.anchor || 'page', bandId: f.bandId || null, show: f.show || 'all', x: f.x, y: f.y, w: sz.w, h: sz.h, cells: [] };
      if (f.kind === 'shape') o.shape = f.shape;
      if (f.kind === 'image') o.src = f.block.src;
      if (f.kind === 'text' || f.kind === 'table') {
        const t = f.block;
        o.table = t;
        const mergeOf = (r, c) => t.merges.find((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) || null;
        const textOf = (r, c) => { const m = mergeOf(r, c); if (m && (m.r0 !== r || m.c0 !== c)) return ''; const cell = t.cells[key(r, c)]; return cell && cell.t !== undefined ? halfBraces(cell.t) : ''; };
        const itemId = (r, c) => `bi_${t.id}_${r}_${c}`;
        const refOf = (r, c) => (r >= 0 && c >= 0 && r < t.nRows && c < t.nCols && textOf(r, c) !== '' ? itemId(r, c) : null);
        for (let r = 0; r < t.nRows; r++) for (let c = 0; c < t.nCols; c++) {
          const text = textOf(r, c);
          if (text === '') continue;
          const item = buildItem(t, r, c, text, (t.cells[key(r, c)] || {}).x, refOf, itemId(r, c), warnings);
          items.push(item);
          o.cells.push({ r, c, item: item.id });
        }
      }
      if (o.anchor === 'band' && !BD().findBand(B, o.bandId)) o.anchor = 'page'; // 帯がなくなったら、ページ基準に戻す
      floats.push(o);
    });
    return { floats, items };
  }

  /** 1 つのセルの中身から項目を作る。= で始まれば式、{変数} があれば式、なければ固定の文字 */
  function buildItem(t, r, c, text, extra, refOf, id, warnings) {
    const label = `${t.name} ${U.cellAddr(r, c)}`;
    let item;
    if (/^\s*[=＝]/.test(text)) {
      item = RI().create('formula', { label, expr: convertRefs(text.replace(/^\s*[=＝]/, ''), refOf) });
    } else {
      const expr = templateExpr(text, (v) => warnings.push(v.exprError ? `${label}：式「${v.expr}」を読めません（${v.exprError}）` : v.bad.length ? `${label}：変数「${v.name}」の書式「${v.bad.join('・')}」は読めません（桁=2・区切り・前=約・後=mm・空=－・埋=3 が使えます）` : v.props.round && v.props.digits === undefined ? `${label}：変数「${v.name}」の「丸=」は、桁も一緒に指定してください（例：{${v.name}|桁=2|丸=A}）` : `${label}：変数「${v.name}」の「区切り」は、桁も一緒に指定してください（例：{${v.name}|桁=0|区切り}）`));
      item = expr === null ? RI().create('text', { label, text }) : RI().create('formula', { label, expr: convertRefs(expr, refOf) });
    }
    item.id = id;
    // 板の表の行だけ：「1 行目だけ」「2 行目以降だけ」「1 行目だけ別の値」（式 IF(ROWNO()=1, …) に直す。手で書いた式と同じ）
    const inRep = !!(t.rep && r >= t.rep.top && r <= t.rep.bottom);
    const first = inRep && extra && extra.first !== undefined ? String(extra.first) : '';
    const rows = inRep && extra ? extra.rows : '';
    if (inRep && (rows === 'first' || rows === 'rest' || first !== '')) {
      const raw = (txt) => {
        if (txt === '') return '""';
        if (/^\s*[=＝]/.test(txt)) return `(${txt.replace(/^\s*[=＝]/, '')})`;
        const e = templateExpr(txt, (v) => warnings.push(`${label}：${v.exprError ? `式「${v.expr}」を読めません（${v.exprError}）` : `変数「${v.name}」の書式を読めません`}`));
        return e === null ? quote(txt) : `(${e})`;
      };
      const rest = raw(text);
      const head = first !== '' ? raw(first) : rest;
      const e = rows === 'first' ? `IF(ROWNO()=1,${head},"")` : rows === 'rest' ? `IF(ROWNO()=1,"",${rest})` : `IF(ROWNO()=1,${head},${rest})`;
      item = RI().create('formula', { label, expr: convertRefs(e, refOf) });
      item.id = id;
    }
    if (extra) Object.keys(extra).forEach((k) => { if (k !== 'rows' && k !== 'first') item[k] = extra[k]; }); // blank・fmt・pre・post・map など
    return item;
  }

  /** プリセットに変換結果を書く（doc・places・items・table）。warnings を返す */
  function apply(preset) {
    const res = compile(preset.blocks);
    preset.doc = res.doc;
    preset.places = res.places;
    preset.items = res.items;
    preset.table = res.table;
    preset.floats = res.floats;
    preset.floatItems = res.floatItems;
    preset.warnings = res.warnings;
    return res.warnings;
  }

  /** 中身の文字が使う列名（{列名}・[列名]）。点検用 */
  function refsOf(text) {
    const out = [];
    String(text).replace(/\{([^{}]+)\}/g, (m, n) => { const v = parseVar(n.trim()); if (v.expr !== undefined) { CDB.formula.refs(v.expr).forEach((x) => out.push(x)); return m; } n = v.name; if (!VARS[n]) out.push(n); return m; });
    return out;
  }

  CDB.blockCompile = { compile, apply, templateExpr, splitTop, parseVar, serializeVar, tokensOf, convertRefs, mapRefs, shiftRefs, refsOf, VARS, snapper };
})();
