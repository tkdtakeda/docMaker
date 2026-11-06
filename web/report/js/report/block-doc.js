/* =========================================================
   js/report/block-doc.js : 「ブロック」で作る帳票の中身と、その編集処理
   画面には依存しない。編集は blocks を直接書き換える（取り消しは呼び出し側が控えを取る）
   blocks = {
     page:   { paper, orientation, margin:{t,b,l,r}(mm), footer:'last'|'every', rows:0(自動) },
     header: [帯…]（毎ページの上端）  bands: [帯…]（本文）  footer: [帯…]（毎ページの下端）
   floats: [自由に置く物…]（帯・区画とは別の重ねる層。後ろほど手前。text・shape・table・image。anchor：'page'|'band'、位置 x・y・大きさ w は mm）
   }
   帯 band  = { id, zones:[区画…], used?(区画が使う幅の割合。1 未満なら右に空き), gap(下の余白 mm), h(高さ固定 px。0 は自動), align:'top', breakBefore?(この帯の前で改ページ。本文の帯のみ), show?('first'|'last'。ヘッダー・フッターの帯のみ) }
   区画 zone = { id, w(幅の比率), block: 表 | null, align?(区画ごとの位置。なければ帯の) }
   表 table  = { id, name, nRows, nCols, colW:[列幅の比率（合計 1）], rowH:[px], cells:{'r,c':{s:書式, t:中身, x:項目の設定}},
                 merges:[{r0,c0,r1,c1}], rep:{top,bottom}|null（板ごとに繰り返す行。全幅の帯の表だけ）,
                 repBy?:'' | 列ID（板の表の行のまとめ方。空は板ごとに 1 行。列を選ぶと、その列の値（検査番号など）が同じ板を 1 行にまとめ、昇順に並べる） }
   中身 t：ふつうの文字／{変数} を混ぜた文字／= で始まる式（同じ表の C3・C3:C12 も使える）
   表の中の書式・結合・行列の編集は sheet-doc.js（セル型の編集部品）をそのまま使う
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const SD = () => CDB.sheetDoc;
  const SP = () => CDB.sheetPages;

  const MIN_FR = 0.03; // 列の幅の最小（区画の幅に対する比率）
  const MAX_ZONES = 4;
  const ROW_PX = 28;
  const LINE = 'thin #111111';
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const key = (r, c) => r + ',' + c;
  const uid = (p) => U.uid(p || 'bd');

  /* ---------- 作る ---------- */
  function newTable(nRows, nCols, opts) {
    const o = opts || {};
    const t = {
      id: uid('tb'), name: o.name || '表', nRows, nCols,
      colW: Array(nCols).fill(1 / nCols), rowH: Array(nRows).fill(o.rowH || ROW_PX), cells: {}, merges: [], rep: null
    };
    if (o.border !== false) SD().setStyle(L(t), { r0: 0, c0: 0, r1: nRows - 1, c1: nCols - 1 }, { bt: LINE, br: LINE, bb: LINE, bl: LINE, v: 'middle' });
    return t;
  }

  function newBand(ratios, opts) {
    const o = opts || {};
    const list = (ratios && ratios.length ? ratios : [1]).slice(0, MAX_ZONES);
    return { id: uid('bn'), zones: list.map((w) => ({ id: uid('zn'), w, block: null })), gap: o.gap === undefined ? 2 : o.gap, h: 0, align: 'top' };
  }

  function newDoc() {
    return { page: SD().defaultPage(), header: [], bands: [], footer: [], floats: [] };
  }

  /** sheet-doc の編集部品に渡す形（表 1 つ = 1 つのセル型レイアウト。項目の配置はなし） */
  function L(t) {
    return { doc: t, places: [], get table() { return t.rep; }, set table(v) { t.rep = v; } };
  }

  /* ---------- 探す ---------- */
  const SECTIONS = ['header', 'bands', 'footer'];
  function allBands(B) { return SECTIONS.reduce((a, s) => a.concat(B[s].map((band) => ({ band, section: s }))), []); }
  function findBand(B, id) { return allBands(B).find((x) => x.band.id === id) || null; }
  function findZone(B, zoneId) {
    for (const { band, section } of allBands(B)) {
      const zone = band.zones.find((z) => z.id === zoneId);
      if (zone) return { band, section, zone };
    }
    return null;
  }
  /** ブロックを探す（表も画像も。画像は table.kind === 'image'） */
  function findTable(B, tableId) {
    for (const { band, section } of allBands(B)) {
      for (const zone of band.zones) if (zone.block && zone.block.id === tableId) return { band, section, zone, table: zone.block };
    }
    const fl = (B.floats || []).find((f) => f.block && f.block.id === tableId);
    return fl ? { band: null, section: 'float', zone: null, float: fl, table: fl.block } : null; // 自由に置く物の表（band・zone はなし）
  }
  const isImage = (b) => !!b && b.kind === 'image';
  /** 表のブロックだけ（画像は除く） */
  const tables = (B) => allBands(B).reduce((a, x) => a.concat(x.band.zones.filter((z) => z.block && !isImage(z.block)).map((z) => z.block)), []);
  const repTable = (B) => tables(B).find((t) => t.rep) || null;

  /**
   * 画像のブロック
   * @param {{src:string, w:number, h:number, name?:string}} img src は data URL、w・h は元の大きさ（px）
   * 幅 w（mm。0 は区画の幅）・位置 align は編集で変える。高さは縦横比から決まる
   */
  function newImage(img) {
    return { id: uid('im'), kind: 'image', name: img.name || '画像', src: img.src, ratio: img.h / Math.max(1, img.w), w: 0, align: 'left' };
  }

  /** 画像の大きさ（mm）。区画の幅 zoneMm に収める */
  function imageSizeMm(b, zoneMm) {
    const w = b.w > 0 ? Math.min(b.w, zoneMm) : zoneMm;
    return { w, h: w * b.ratio, off: b.align === 'right' ? zoneMm - w : b.align === 'center' ? (zoneMm - w) / 2 : 0 };
  }

  /* ---------- 自由に置く物 ---------- */
  const FLOAT_KINDS = ['text', 'shape', 'table', 'image'];
  const SHAPES = ['rect', 'ellipse', 'line', 'arrow'];
  const floatsOf = (B) => (B.floats || (B.floats = []));
  const findFloat = (B, id) => floatsOf(B).find((f) => f.id === id) || null;

  /**
   * 自由に置く物を作る（位置 x・y と大きさ w は mm。text・table は高さが行の高さの合計、image は縦横比で決まる）
   * @param {'text'|'shape'|'table'|'image'} kind
   * @param {{shape?:string, img?:object, x?:number, y?:number, w?:number, h?:number}} o
   */
  function newFloat(kind, o) {
    const x = o || {};
    const f = { id: uid('fl'), kind, anchor: 'page', bandId: null, show: 'all', x: x.x === undefined ? 20 : x.x, y: x.y === undefined ? 30 : x.y, w: x.w || 60, h: 0 };
    if (kind === 'text') { f.block = newTable(1, 1, { name: 'テキストボックス', border: false, rowH: 36 }); f.block.cells['0,0'] = { s: { v: 'top', wrap: 1 } }; }
    else if (kind === 'table') { f.block = newTable(Math.max(1, Math.min(30, x.rows || 3)), Math.max(1, Math.min(20, x.cols || 3)), { name: '表' }); f.w = x.w || 80; }
    else if (kind === 'image') { f.block = newImage(x.img); f.w = x.w || 40; f.block.w = 0; }
    else if (kind === 'shape') { f.shape = { type: SHAPES.includes(x.shape) ? x.shape : 'rect', stroke: '#1f4672', sw: 0.5, fill: '', fx: false, fy: false }; f.w = x.w || 40; f.h = x.h || (f.shape.type === 'line' || f.shape.type === 'arrow' ? 0 : 20); }
    else throw new Error('自由に置ける物の種類が正しくありません');
    return f;
  }

  /** 自由に置く物の大きさ（mm）。text・table は幅 w と行の高さの合計、image は幅と縦横比 */
  function floatSizeMm(f) {
    const k = SP().PX_PER_MM;
    if (f.kind === 'text' || f.kind === 'table') return { w: f.w, h: f.block.rowH.reduce((a, b) => a + b, 0) / k };
    if (f.kind === 'image') return { w: f.w, h: f.w * f.block.ratio };
    return { w: f.w, h: f.h };
  }

  function addFloat(B, f) { floatsOf(B).push(f); return f; }
  function removeFloat(B, id) { const l = floatsOf(B); const i = l.findIndex((f) => f.id === id); if (i >= 0) l.splice(i, 1); }
  /** 前後（重なり）の順序。list の後ろほど手前 */
  function floatZ(B, id, how) {
    const l = floatsOf(B);
    const i = l.findIndex((f) => f.id === id);
    if (i < 0) return;
    const [f] = l.splice(i, 1);
    const j = how === 'front' ? l.length : how === 'back' ? 0 : how === 'up' ? Math.min(l.length, i + 1) : Math.max(0, i - 1);
    l.splice(j, 0, f);
  }
  /** 位置と大きさ。text・table は幅を変えたら列の比率のまま、高さを変えたら行の高さを比例して変える。image は縦横比を保つ */
  function setFloatGeom(B, id, g) {
    const f = findFloat(B, id);
    if (!f) return;
    if (g.x !== undefined) f.x = g.x;
    if (g.y !== undefined) f.y = g.y;
    if (g.w !== undefined) f.w = Math.max(3, g.w);
    if (g.h !== undefined) {
      const cur = floatSizeMm(f).h;
      if (f.kind === 'text' || f.kind === 'table') {
        const target = Math.max(f.block.nRows * 3, g.h);
        const ratio = target / Math.max(0.1, cur);
        f.block.rowH = f.block.rowH.map((px) => Math.max(SD().MIN_ROW, px * ratio));
      } else if (f.kind === 'shape') f.h = Math.max(0, g.h);
    }
  }

  /* ---------- 帯・区画 ---------- */
  function addBand(B, section, index, ratios) {
    if (section !== 'bands' && section !== 'header' && section !== 'footer') throw new Error('帯を入れる場所が正しくありません');
    const band = newBand(ratios, { gap: section === 'bands' ? 2 : 0 }); // ヘッダー・フッターは上下にくっつける
    const list = B[section];
    list.splice(index === undefined ? list.length : Math.max(0, Math.min(index, list.length)), 0, band);
    return band;
  }

  function removeBand(B, bandId) {
    const f = findBand(B, bandId);
    if (!f) return;
    f.band.zones.forEach((z) => { if (z.block && z.block.rep) { /* 板の表ごと消える */ } });
    B[f.section].splice(B[f.section].indexOf(f.band), 1);
  }

  function moveBand(B, bandId, dir) {
    const f = findBand(B, bandId);
    if (!f) return;
    const list = B[f.section];
    const i = list.indexOf(f.band);
    const j = i + (dir < 0 ? -1 : 1);
    if (j < 0 || j >= list.length) return;
    list.splice(i, 1);
    list.splice(j, 0, f.band);
  }

  /** 区画の数・比率を変える（ratios の長さが区画の数）。減らすときは、後ろの区画のブロックが消える */
  function setZones(B, bandId, ratios) {
    const f = findBand(B, bandId);
    if (!f) return;
    const list = ratios.slice(0, MAX_ZONES).map((w) => Math.max(1, Number(w) || 1));
    const old = f.band.zones;
    const lostRep = old.slice(list.length).some((z) => z.block && z.block.rep);
    if (lostRep) throw new Error('板の表がある区画は消せません。先に板の表を解除するか、削除してください');
    if (list.length > 1 && old.some((z) => z.block && z.block.rep)) throw new Error('板の表は全幅の帯にだけ置けます。板の表を解除してから区画を分けてください');
    f.band.zones = list.map((w, i) => (old[i] ? Object.assign(old[i], { w }) : { id: uid('zn'), w, block: null }));
    delete f.band.used; // 比率で決め直したら、幅いっぱいに戻す
  }

  /** 一定間隔の罫線（表ごと）。which：'rows'（板の表：全体の N 行ごとに、その行の下に引く）／'cols'（N 列ごとに、その列の右に引く）。rule：{every, style}、null で解除 */
  const RULE_STYLES = ['hair', 'thin', 'dotted', 'dashed', 'medium', 'thick', 'double'];
  function setRule(B, tableId, which, rule) {
    const f = findTable(B, tableId);
    if (!f || (which !== 'rows' && which !== 'cols')) return;
    const t = f.table;
    const every = rule ? Math.max(1, Math.min(999, Math.round(Number(rule.every) || 0))) : 0;
    if (!rule || !every) { if (t.rules) { delete t.rules[which]; if (!Object.keys(t.rules).length) delete t.rules; } return; }
    t.rules = t.rules || {};
    t.rules[which] = { every, style: RULE_STYLES.includes(rule.style) ? rule.style : 'thin' };
  }
  const ruleSpec = (r) => `${r.style} #111111`;

  /** 帯の前で改ページ（本文の帯だけ。一番上の帯は不可）。v が偽なら解除 */
  function setBandBreak(B, bandId, v) {
    const f = findBand(B, bandId);
    if (!f) return;
    if (v && f.section !== 'bands') throw new Error('改ページにできるのは、本文の帯です');
    if (v && B.bands.indexOf(f.band) === 0) throw new Error('一番上の帯の前は、改ページにできません');
    if (v) f.band.breakBefore = true; else delete f.band.breakBefore;
  }
  /** ヘッダー・フッターの帯を出すページ（'all'|'first'|'last'） */
  function setBandShow(B, bandId, v) { const f = findBand(B, bandId); if (f) { if (['first', 'last'].includes(v) && f.section === 'bands') throw new Error('表示するページを選べるのは、ヘッダー・フッターの帯です'); if (['first', 'last'].includes(v)) f.band.show = v; else delete f.band.show; } }
  function setBandHeight(B, bandId, px) { const f = findBand(B, bandId); if (f) f.band.h = Math.max(0, Math.round(px)); }
  function setBandGap(B, bandId, mm) { const f = findBand(B, bandId); if (f) f.band.gap = Math.max(0, Math.min(30, Number(mm) || 0)); }
  function setBandAlign(B, bandId, align) {
    const f = findBand(B, bandId);
    if (!f) return;
    f.band.align = ['top', 'middle', 'bottom', 'stretch'].includes(align) ? align : 'top';
    f.band.zones.forEach((z) => { delete z.align; }); // 帯で決め直したら、区画ごとの指定は外す
  }
  /** 区画ごとの位置（同じ帯で背の低い表を、上・中央・下のどこに置くか。帯の指定より優先） */
  function setZoneAlign(B, zoneId, align) { const f = findZone(B, zoneId); if (f) f.zone.align = ['top', 'middle', 'bottom', 'stretch'].includes(align) ? align : 'top'; }

  /** 区画の境界を動かす（左の区画の右端を delta 比率だけ動かす。2 区画以上の帯） */
  function moveZoneEdge(B, bandId, idx, deltaRatio) {
    const f = findBand(B, bandId);
    if (!f || idx < 0 || idx >= f.band.zones.length - 1) return;
    const a = f.band.zones[idx];
    const b = f.band.zones[idx + 1];
    const sum = a.w + b.w;
    const min = sum * 0.08;
    const na = Math.max(min, Math.min(sum - min, a.w + deltaRatio * sum));
    a.w = na;
    b.w = sum - na;
  }

  /* ---------- ブロック ---------- */
  /** 区画にブロック（表）を置く。板の表にする表は、全幅の帯にだけ */
  function setBlock(B, zoneId, block) {
    const f = findZone(B, zoneId);
    if (!f) throw new Error('区画がありません');
    if (block && block.rep && f.band.zones.length > 1) throw new Error('板の表は全幅の帯にだけ置けます');
    f.zone.block = block || null;
    return block;
  }

  function removeBlock(B, zoneId) { const f = findZone(B, zoneId); if (f) f.zone.block = null; }

  /** 板の表にする（1 帳票に 1 つ。全幅の帯の表だけ）。row はその表の中の行 */
  function setRep(B, tableId, row, row2) {
    const f = findTable(B, tableId);
    if (!f) throw new Error('表がありません');
    if (!f.band) { if (row === null || row === undefined) return; throw new Error('自由に置いた表は板の表にできません'); }
    if (row === null || row === undefined) { if (!isImage(f.table)) { f.table.rep = null; delete f.table.repBy; } return; }
    if (isImage(f.table)) throw new Error('画像は板の表にできません');
    if (f.band.zones.length > 1) throw new Error('板の表は全幅の帯にだけ置けます（先に帯の区画を 1 つにしてください）');
    if (f.section === 'header' || f.section === 'footer') throw new Error('毎ページのヘッダー・フッターには板の表を置けません');
    const other = repTable(B);
    if (other && other !== f.table) throw new Error('板の表は 1 つの帳票に 1 つまでです（すでに別の表が板の表です）');
    SD().setTable(L(f.table), row, row2); // row〜row2 の連続する行（1 行でも複数行でも）
  }

  /** 板の表の行のまとめ方を決める（colId が空なら、板ごとに 1 行）。板の表の行がない表には決められない */
  function setRepBy(B, tableId, colId) {
    const f = findTable(B, tableId);
    if (!f || !f.table.rep) throw new Error('板の表の行を先に決めてください');
    if (colId) f.table.repBy = String(colId); else delete f.table.repBy;
  }

  /* ---------- 表の寸法 ---------- */
  const sumFr = (a) => a.reduce((x, y) => x + y, 0);
  const normalizeFr = (t) => { const s = sumFr(t.colW) || 1; t.colW = t.colW.map((x) => x / s); };

  /** 列の境界（c 列の右端）を動かす：c 列と次の列の幅を入れ替える（表全体の幅は変わらない） */
  function moveColEdge(t, c, deltaFr) {
    if (c < 0 || c >= t.nCols - 1) return;
    const sum = t.colW[c] + t.colW[c + 1];
    const a = Math.max(MIN_FR, Math.min(sum - MIN_FR, t.colW[c] + deltaFr));
    t.colW[c] = a;
    t.colW[c + 1] = sum - a;
  }

  /** 列幅を mm で決める。差は、ほかの列（右側から先に）で吸収し、表の幅（区画の幅）は変えない */
  function setColMm(t, c, mm, zoneMm) {
    if (t.nCols < 2) return;
    const want = Math.max(MIN_FR, Math.min(1 - MIN_FR * (t.nCols - 1), mm / zoneMm));
    const others = t.colW.map((x, i) => (i === c ? 0 : x));
    const rest = 1 - want;
    const sum = sumFr(others) || 1;
    t.colW = t.colW.map((x, i) => (i === c ? want : Math.max(MIN_FR, (x / sum) * rest)));
    normalizeFr(t);
  }

  /** 選んだ列の幅をそろえる（c0〜c1 の合計は変えず、均等にする） */
  function equalizeCols(t, c0, c1) {
    const a = Math.min(c0, c1);
    const b = Math.max(c0, c1);
    if (b <= a) return;
    let total = 0;
    for (let c = a; c <= b; c++) total += t.colW[c];
    for (let c = a; c <= b; c++) t.colW[c] = total / (b - a + 1);
  }

  /** 全部の列を均等にする */
  function equalizeAllCols(t) { t.colW = Array(t.nCols).fill(1 / t.nCols); }

  /** 選んだ列の幅を、1 つ目の列の幅にそろえる（表全体の幅に収まるよう按分） */
  function sameAsFirstCols(t, c0, c1) {
    const a = Math.min(c0, c1);
    const b = Math.max(c0, c1);
    const w = t.colW[a];
    for (let c = a + 1; c <= b; c++) t.colW[c] = w;
    normalizeFr(t);
  }

  /**
   * 選んだ列（cols）を、内容の幅（px）に合わせる。残りの列は、表全体の幅が変わらないよう比率で詰める／広げる
   * @param {number[]} cols 列番号
   * @param {number[]} px cols と同じ並びの、必要な幅（px）
   * @param {number} zonePx 表の幅（px）
   */
  function fitCols(t, cols, px, zonePx) {
    let want = cols.map((c, i) => Math.max(MIN_FR, px[i] / zonePx));
    const others = t.colW.map((_, i) => i).filter((i) => !cols.includes(i));
    if (!others.length) { const sum = want.reduce((a, b) => a + b, 0); cols.forEach((c, i) => { t.colW[c] = want[i] / sum; }); return; }
    let sumW = want.reduce((a, b) => a + b, 0);
    const room = 1 - others.length * MIN_FR;
    if (sumW > room) { const k = room / sumW; want = want.map((x) => x * k); sumW = room; }
    const o = others.reduce((a, i) => a + t.colW[i], 0) || 1;
    others.forEach((i) => { t.colW[i] = Math.max(MIN_FR, (t.colW[i] / o) * (1 - sumW)); });
    cols.forEach((c, i) => { t.colW[c] = want[i]; });
    normalizeFr(t);
  }

  /** セルの範囲をコピーする（中身・書式・セルの設定・範囲内の結合）。貼り付けのときに、式の参照をずらすため元の位置も持つ */
  function copyRange(t, rg) {
    const a = SD().norm(rg);
    const cells = [];
    for (let r = a.r0; r <= a.r1; r++) {
      const row = [];
      for (let c = a.c0; c <= a.c1; c++) {
        const cell = t.cells[key(r, c)];
        row.push(cell ? { t: cell.t, s: clone(cell.s || {}), x: cell.x ? clone(cell.x) : undefined } : null);
      }
      cells.push(row);
    }
    const merges = t.merges.filter((m) => m.r0 >= a.r0 && m.r1 <= a.r1 && m.c0 >= a.c0 && m.c1 <= a.c1).map((m) => ({ r0: m.r0 - a.r0, c0: m.c0 - a.c0, r1: m.r1 - a.r0, c1: m.c1 - a.c0 }));
    return { nRows: a.r1 - a.r0 + 1, nCols: a.c1 - a.c0 + 1, cells, merges, r0: a.r0, c0: a.c0 };
  }

  /** コピーしたセルを (r0, c0) から貼る。表の外ははみ出さない。式の参照は貼った位置の分だけずらす（Excel と同じ）。戻り値：貼った行数・列数と、切り捨てたか */
  function pasteRange(t, r0, c0, data, shiftRef) {
    const rows = Math.min(data.nRows, t.nRows - r0);
    const cols = Math.min(data.nCols, t.nCols - c0);
    const area = { r0, c0, r1: r0 + rows - 1, c1: c0 + cols - 1 };
    // コピー元に結合があるときだけ、貼り付け先の結合を置き換える。なければ結合は保ち、結合の中（左上以外）は飛ばす
    if (data.merges.length) t.merges = t.merges.filter((m) => !SD().hit(m, area));
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const src = data.cells[i][j];
        const k = key(r0 + i, c0 + j);
        const cover = t.merges.find((m) => r0 + i >= m.r0 && r0 + i <= m.r1 && c0 + j >= m.c0 && c0 + j <= m.c1);
        if (cover && (cover.r0 !== r0 + i || cover.c0 !== c0 + j)) continue;
        if (!src) { delete t.cells[k]; continue; }
        const cell = { s: clone(src.s || {}) };
        if (src.t !== undefined) cell.t = shiftRef && /^\s*[=＝]/.test(String(src.t)) ? shiftRef(String(src.t), r0 - data.r0, c0 - data.c0) : src.t;
        if (src.x) cell.x = clone(src.x);
        t.cells[k] = cell;
      }
    }
    data.merges.forEach((m) => { if (m.r1 < rows && m.c1 < cols) t.merges.push({ r0: m.r0 + r0, c0: m.c0 + c0, r1: m.r1 + r0, c1: m.c1 + c0 }); });
    return { rows, cols, cut: rows < data.nRows || cols < data.nCols };
  }

  /**
   * 外から来た文字（タブ区切り）を、値だけ貼る。セルの書式・結合は変えない。結合の中（左上以外）と、空の欄は飛ばす
   * @param {string[][]} rows 行 × 列の文字
   * @returns {{rows:number, cols:number, cut:boolean, skipped:number}}
   */
  function pasteValues(t, r0, c0, rows) {
    let cut = false;
    let skipped = 0;
    let maxC = 0;
    rows.forEach((row, i) => row.forEach((v, j) => {
      const r = r0 + i;
      const c = c0 + j;
      maxC = Math.max(maxC, j + 1);
      if (r >= t.nRows || c >= t.nCols) { cut = true; return; }
      const m = t.merges.find((x) => r >= x.r0 && r <= x.r1 && c >= x.c0 && c <= x.c1);
      if (m && (m.r0 !== r || m.c0 !== c)) { skipped++; return; }
      if (v === '') return; // 空の欄は、今の中身を消さない
      setText(t, r, c, v);
    }));
    return { rows: Math.min(rows.length, t.nRows - r0), cols: Math.min(maxC, t.nCols - c0), cut, skipped };
  }

  /** 帯を複製して、すぐ下に入れる（板の表がある帯は複製できない。ID は付け直す） */
  function duplicateBand(B, bandId) {
    const f = findBand(B, bandId);
    if (!f) return null;
    if (f.band.zones.some((z) => z.block && z.block.rep)) throw new Error('板の表がある帯は複製できません（板の表は 1 つの帳票に 1 つまでです）');
    const c = clone(f.band);
    const re = (x) => { if (x && typeof x === 'object') { if (x.id) x.id = uid('bd'); Object.keys(x).forEach((k) => { if (k !== 'cells') re(x[k]); }); } };
    re(c);
    const list = B[f.section];
    list.splice(list.indexOf(f.band) + 1, 0, c);
    return c;
  }

  const setRowHeight = (t, r, px) => { t.rowH[r] = Math.max(SD().MIN_ROW, Math.round(px)); };
  function equalizeRows(t, r0, r1) {
    const a = Math.min(r0, r1);
    const b = Math.max(r0, r1);
    let total = 0;
    for (let r = a; r <= b; r++) total += t.rowH[r];
    for (let r = a; r <= b; r++) t.rowH[r] = Math.round(total / (b - a + 1));
  }
  const tableHeightPx = (t) => sumFr(t.rowH);

  /* 行・列の挿入削除のあと、列幅を比率に戻す（sheet-doc は colW を px として扱うため、比率のまま使うと挿入列は 90 になる） */
  const ensureFr = (t) => {
    if (t.colW.length !== t.nCols) t.colW = Array(t.nCols).fill(1 / t.nCols);
    normalizeFr(t);
  };
  function insertCols(t, at, n) {
    const src = Math.max(0, Math.min(at - 1, t.nCols - 1));
    const w = t.colW[src] || 1 / t.nCols;
    SD().insertCols(L(t), at, n);
    for (let i = 0; i < n; i++) t.colW[at + i] = w; // sheet-doc が 90（px）を入れるので比率に直す
    ensureFr(t);
  }
  function deleteCols(t, c0, c1) { SD().deleteCols(L(t), c0, c1); ensureFr(t); }

  /** セルの中身を変える（空にすると中身を消す。書式は残る） */
  function setText(t, r, c, text) {
    const k = key(r, c);
    const cell = t.cells[k] || (t.cells[k] = { s: {} });
    if (text === '' || text === null || text === undefined) delete cell.t; else cell.t = String(text);
    if (!Object.keys(cell.s || {}).length && cell.t === undefined && !cell.x) delete t.cells[k];
  }

  /**
   * 中身に改行があるセルを整える：折り返しを自動でオンにし（オフだと出力で改行が出ない）、行の高さが足りなければ、行数ぶんに広げる
   * 結合したセルは、結合の最初の行だけ（全体の高さは変えない）。広げた行の高さ（px）を返す（変えなければ 0）
   */
  function fitMultiline(t, r, c) {
    const cell = t.cells[key(r, c)];
    if (!cell || cell.t === undefined || !/\n/.test(String(cell.t))) return 0;
    cell.s = cell.s || {};
    if (!cell.s.wrap) cell.s.wrap = 1;
    const m = t.merges.find((x) => r >= x.r0 && r <= x.r1 && c >= x.c0 && c <= x.c1);
    if (m && m.r1 > m.r0) return 0; // 行をまたぐ結合は、高さを触らない
    const lines = String(cell.t).split('\n').length;
    const need = Math.ceil(lines * (cell.s.sz || SD().DEFAULT_SIZE) * (96 / 72) * (cell.s.lh || 1.3) + 6);
    if ((t.rowH[r] || 0) < need) { t.rowH[r] = need; return need; }
    return 0;
  }

  /* ---------- 幅の計算（画面・変換で共通） ---------- */
  const ZONE_GAP_MM = 3; // 区画のあいだの既定の間隔（帯ごとに 0〜10mm で変えられる）
  const gapOk = (v) => typeof v === 'number' && v >= 0 && v <= 30;
  /** 区画のあいだの間隔（mm）の並び（区画の数 − 1 個）。帯に zgaps（1 つずつ）があればそれ、なければ zgap（全部同じ）、なければ既定 */
  function zoneGapsMm(band) {
    const base = gapOk(band.zgap) ? band.zgap : ZONE_GAP_MM;
    const a = band.zgaps || [];
    return Array.from({ length: Math.max(0, band.zones.length - 1) }, (_, i) => (gapOk(a[i]) ? a[i] : base));
  }
  const zoneGapSumMm = (band) => zoneGapsMm(band).reduce((x, y) => x + y, 0);
  const zoneGapMm = (band) => zoneGapsMm(band)[0] === undefined ? (gapOk(band.zgap) ? band.zgap : ZONE_GAP_MM) : zoneGapsMm(band)[0];
  /** 間隔を決める。idx を省くと、全部の間隔を同じ値にする。idx（0 から）を付けると、その間隔だけ変える */
  function setZoneGap(B, bandId, mm, idx) {
    const f = findBand(B, bandId);
    if (!f) return;
    const band = f.band;
    const v = Math.max(0, Math.min(30, Math.round((Number(mm) || 0) * 10) / 10));
    if (idx === undefined || idx === null) { delete band.zgaps; if (v === ZONE_GAP_MM) delete band.zgap; else band.zgap = v; return; }
    const cur = zoneGapsMm(band);
    cur[idx] = v;
    if (cur.every((x) => x === ZONE_GAP_MM)) { delete band.zgaps; delete band.zgap; } else { band.zgaps = cur; delete band.zgap; }
  }
  /** 印刷できる幅（mm） */
  const printWidthMm = (page) => SP().printable(page).w / SP().PX_PER_MM;
  /** 帯の区画の幅（mm）。間（3mm）を引いた残りを比率で分ける */
  function zoneWidthsMm(page, band) {
    const n = band.zones.length;
    const avail = printWidthMm(page) - zoneGapSumMm(band);
    const used = band.used > 0 && band.used < 1 ? band.used : 1; // 区画が使う幅の割合（1 未満なら、右に空きが残る）
    const sum = band.zones.reduce((a, z) => a + z.w, 0) || 1;
    return band.zones.map((z) => (avail * used * z.w) / sum);
  }

  /** いちばん右の区画の幅を mm で決める（右端のドラッグ）。短くすると右に空きが残る（区画は足さない）。戻した幅を返す */
  function setLastZoneWidth(B, bandId, mm, page) {
    const f = findBand(B, bandId);
    if (!f) return 0;
    const band = f.band;
    const n = band.zones.length;
    const cur = zoneWidthsMm(page, band);
    const availMm = printWidthMm(page) - zoneGapSumMm(band);
    const others = cur.slice(0, n - 1).reduce((a, b) => a + b, 0);
    const maxP = availMm - others;
    const P = Math.max(15, Math.min(maxP, mm));
    const widths = cur.slice();
    widths[n - 1] = P;
    band.zones.forEach((z, i) => { z.w = widths[i]; }); // 幅（mm）をそのまま重みにする
    if (P >= maxP - 0.5) delete band.used; else band.used = (others + P) / availMm;
    return P;
  }

  /** 右の空きに、空の区画を足す（ユーザーが決めたときだけ）。区画は 4 つまで */
  function addZoneRight(B, bandId, page) {
    const f = findBand(B, bandId);
    if (!f) return null;
    const band = f.band;
    if (band.zones.length >= MAX_ZONES) throw new Error(`区画は ${MAX_ZONES} つまでです`);
    const cur = zoneWidthsMm(page, band);
    const newGap = zoneGapsMm(band).slice(-1)[0] !== undefined ? zoneGapsMm(band).slice(-1)[0] : ZONE_GAP_MM;
    const availAfter = printWidthMm(page) - zoneGapSumMm(band) - newGap;
    const free = availAfter - cur.reduce((a, b) => a + b, 0);
    if (free < 10) throw new Error('右に空きがありません。先に、表の右端を左へ引いて短くしてください');
    band.zones.forEach((z, i) => { z.w = cur[i]; });
    const z = { id: uid('zn'), w: free, block: null };
    if (band.zgaps) band.zgaps = zoneGapsMm(band).concat([newGap]);
    band.zones.push(z);
    delete band.used;
    return z;
  }

  /* ---------- 帳票のひな形（検査成績書。中身は C 案のモックと同じ構成） ---------- */
  function skeleton() {
    const B = newDoc();
    const head = { b: 1, bg: '#dbe7f4', h: 'center', v: 'middle' };
    const setT = (t, r, c, text, patch) => {
      const k = key(r, c);
      t.cells[k] = t.cells[k] || { s: {} };
      t.cells[k].t = text;
      if (patch) Object.assign(t.cells[k].s, patch);
    };
    // docMaker：見出しは汎用のもの（CDB の検査成績書の見出し（注文番号・検査番号・板厚…）から差し替えた）
    // 帯 1：表題（1×1 の表）
    const b1 = addBand(B, 'bands', undefined, [1]);
    const title = newTable(1, 1, { name: '表題', border: false, rowH: 44 });
    setT(title, 0, 0, '帳　票', { sz: 18, b: 1, h: 'center', v: 'middle' });
    b1.zones[0].block = title;
    // 帯 2：ロットの情報（左）と承認欄（右）
    const b2 = addBand(B, 'bands', undefined, [60, 40]);
    const info = newTable(3, 4, { name: 'ロットの情報' });
    info.colW = [0.2, 0.3, 0.2, 0.3];
    // 値のセルは空（データの列は帳票ごとに違うので、利用者が {列名} を入れる）
    [['ロット番号', '', '品番', ''], ['品名', '', '数量', '']].forEach((row, r) => row.forEach((t, c) => { if (c % 2 === 0) setT(info, r, c, t, head); }));
    setT(info, 2, 0, '納入先', head);
    info.merges.push({ r0: 2, c0: 1, r1: 2, c1: 3 });
    b2.zones[0].block = info;
    const sign = newTable(2, 3, { name: '承認欄' });
    sign.rowH = [26, 56];
    ['承認', '確認', '作成'].forEach((t, c) => setT(sign, 0, c, t, head));
    b2.zones[1].block = sign;
    // 帯 3：明細の表（見出し 1 段・2 行目をロットの行ごとに繰り返す）
    const b3 = addBand(B, 'bands', undefined, [1]);
    b3.gap = 0;
    const plate = newTable(2, 6, { name: '明細' });
    plate.colW = [0.08, 0.18, 0.14, 0.2, 0.2, 0.2];
    plate.rowH = [28, 28];
    ['No.', '工程', '数量', '製造日', '担当者', '備考'].forEach((t, i) => setT(plate, 0, i, t, head));
    for (let c = 0; c < 6; c++) setT(plate, 1, c, c === 0 ? '{行番号}' : '', { h: c === 0 ? 'center' : c === 2 ? 'right' : 'left' });
    plate.rep = { top: 1, bottom: 1 };
    b3.zones[0].block = plate;
    // ヘッダー・フッター（毎ページ）
    const h = addBand(B, 'header', undefined, [1, 1]);
    h.gap = 2;
    h.zones.forEach((z, i) => {
      const t = newTable(1, 1, { name: i ? '発行日' : '見出し', border: false, rowH: 22 });
      setT(t, 0, 0, i ? '発行日 {出力日}' : '', { sz: 9, h: i ? 'right' : 'left', v: 'middle' });
      z.block = t;
    });
    const f = addBand(B, 'footer', undefined, [1, 1]);
    f.gap = 0;
    f.zones.forEach((z, i) => {
      const t = newTable(1, 1, { name: i ? 'ページ' : '会社名', border: false, rowH: 22 });
      setT(t, 0, 0, i ? '{ページ} / {総ページ}' : '', { sz: 9, h: i ? 'right' : 'left', v: 'middle' });
      z.block = t;
    });
    return B;
  }

  CDB.blockDoc = {
    MIN_FR, MAX_ZONES, ZONE_GAP_MM, zoneGapMm, zoneGapsMm, zoneGapSumMm, setZoneGap, RULE_STYLES, setRule, ruleSpec, ROW_PX, LINE, SECTIONS, clone, key,
    newTable, newBand, newDoc, skeleton, L, setText,
    allBands, findBand, findZone, findTable, tables, repTable, isImage, newImage, imageSizeMm,
    FLOAT_KINDS, SHAPES, floatsOf, findFloat, newFloat, floatSizeMm, addFloat, removeFloat, floatZ, setFloatGeom,
    addBand, removeBand, moveBand, setZones, setBandHeight, setBandGap, setBandAlign, setZoneAlign, setBandShow, setBandBreak, moveZoneEdge, setLastZoneWidth, addZoneRight, setBlock, removeBlock, setRep, setRepBy,
    fitMultiline, fitCols, copyRange, pasteRange, pasteValues, duplicateBand, moveColEdge, setColMm, equalizeCols, equalizeAllCols, sameAsFirstCols, setRowHeight, equalizeRows, tableHeightPx, insertCols, deleteCols,
    printWidthMm, zoneWidthsMm
  };
})();
