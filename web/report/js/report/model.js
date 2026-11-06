/* =========================================================
   js/report/model.js : 帳票プリセットの保存と、ロット → ページ → セルの値の組み立て
   プリセット preset = {
     id, name, templateId, sheet,               … 使うテンプレートとシート
     items: [項目]                               … 変換表（report-items.js）
     places: [{ id, r, c, item, show, sep }]     … 配置（0 始まりの行・列）
         show: 'value'（値）| 'label'（表示名）| 'both'（表示名＋区切り＋値）
     table: { top, bottom } | null               … 板の表の範囲（0 始まり・両端を含む）
         top の行にある配置は、板 1 枚ごとに下の行へ繰り返す
     groupBy: '' | 列ID（'m:ロット番号' / 'p:注文番号' など） … 1 枚にまとめる単位
         '' は元データの行ごと（引当番号ごと）。列を選ぶと、その列の値が同じ板を 1 枚にまとめる
         表の外のセルで、まとめた中に値が複数あるものは空欄にする（帳票には出さない）
     sample
   }
   画面には依存しない
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const F = CDB.formula;
  const RI = CDB.reportItems;
  const RG = () => CDB.rowGroup;

  const STORE_PRESET = 'reports';
  const STORE_TEMPLATE = 'templates';
  const SHOW = [
    { value: 'value', label: '値' },
    { value: 'label', label: '表示名' },
    { value: 'both', label: '表示名＋値' }
  ];

  /* ---------- 保存 ---------- */
  const listPresets = async () => (await CDB.db.getAll(STORE_PRESET)).sort((a, b) => (a.sample === b.sample ? String(a.name).localeCompare(b.name, 'ja') : a.sample ? 1 : -1));
  const listTemplates = async () => (await CDB.db.getAll(STORE_TEMPLATE)).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  const getTemplate = (id) => (id ? CDB.db.get(STORE_TEMPLATE, id) : Promise.resolve(null));

  function newPreset(name, templateId, sheet) {
    return { id: U.uid('rp'), name: name || '新しい帳票', templateId: templateId || '', sheet: sheet || '', items: [], places: [], table: null, updatedAt: Date.now() };
  }

  async function savePreset(p) {
    p.updatedAt = Date.now();
    await CDB.db.put(STORE_PRESET, JSON.parse(JSON.stringify(p)));
    return p;
  }

  async function removePreset(id) {
    const old = await CDB.db.get(STORE_PRESET, id);
    await CDB.db.deleteMany(STORE_PRESET, [id]);
    return { undo: () => CDB.db.put(STORE_PRESET, old) };
  }

  /** プリセットを複製（項目・配置の ID は付け直す） */
  function duplicate(p) {
    const copy = JSON.parse(JSON.stringify(p));
    const idMap = {};
    copy.id = U.uid('rp');
    copy.name = p.name + ' のコピー';
    copy.sample = false;
    if (copy.blocks) { // ブロックの帳票：項目は blocks から作り直す（式が項目の ID を使うので、付け替えない）
      const re = (x) => { if (x && typeof x === 'object') { if (x.id) x.id = U.uid('bd'); Object.keys(x).forEach((k) => { if (k !== 'cells') re(x[k]); }); } };
      re(copy.blocks);
      CDB.blockCompile.apply(copy);
      return copy;
    }
    copy.items.forEach((it) => { const nid = U.uid('it'); idMap[it.id] = nid; it.id = nid; });
    copy.places.forEach((pl) => { pl.id = U.uid('pl'); pl.item = idMap[pl.item] || pl.item; });
    return copy;
  }

  async function saveTemplate(t) {
    await CDB.db.put(STORE_TEMPLATE, t);
    return t;
  }

  async function removeTemplate(id) {
    const old = await CDB.db.get(STORE_TEMPLATE, id);
    await CDB.db.deleteMany(STORE_TEMPLATE, [id]);
    return { undo: () => CDB.db.put(STORE_TEMPLATE, old) };
  }

  /* ---------- 1 枚ごとのまとまりの組み立て ---------- */
  /**
   * 表示中の行（絞り込み・並べ替え後）から、帳票 1 枚ごとのまとまりの一覧を作る。元データにない板（未一致）は除く
   * 呼び名は互換のため「ロット」のまま（lot = 1 枚分）
   * @param {object[]} rows join の行
   * @param {object[]} masters 元データ（名前の取得用）
   * @param {string} [groupBy] まとめる列ID（空なら元データの行ごと）。その列が空の行は出さない
   * @returns {{gkey, mid, name, lead, leads:object[], plates:object[]}[]} leads：まとめた元データの行（行ごとに 1 つ）
   */
  /** まとめる列の一覧（文字列 1 つでも、列の配列でもよい。空は除く） */
  const groupCols = (groupBy) => (Array.isArray(groupBy) ? groupBy : [groupBy]).filter(Boolean);

  /** 1 枚の名前（まとめる列の値を「＋」でつなぐ）。どれかの値が空欄なら ''（その行は帳票に出さない） */
  function groupName(row, groupBy) {
    const vals = groupCols(groupBy).map((id) => U.normValue(row.v[id]));
    return vals.length && vals.every((v) => v !== '') ? vals.join('＋') : '';
  }

  /** 1 行が入る「1 枚」のキー（まとめる列の値が同じなら同じキー。空欄・列なしは ''）。列が 1 つのときのキーは従来と同じ */
  function groupKey(row, groupBy) {
    const cols = groupCols(groupBy);
    if (!cols.length) return row.gkey;
    const vals = cols.map((id) => U.normValue(row.v[id]));
    if (vals.some((v) => v === '')) return '';
    return 'g:' + vals.map(U.normKey).join('\u0001');
  }

  function buildLots(rows, masters, groupBy) {
    const byId = new Map(masters.map((m) => [m.id, m]));
    const map = new Map();
    const out = [];
    rows.forEach((r) => {
      if (r.status === 'orphan' || r.mid === null) return;
      const key = groupKey(r, groupBy);
      if (key === '') return;
      const name = groupCols(groupBy).length ? groupName(r, groupBy) : '';
      let lot = map.get(key);
      if (!lot) {
        const m = byId.get(r.mid) || {};
        lot = { gkey: key, mid: r.mid, name: name || m.lot || m.insp || r.gkey, lead: r, leads: [], plates: [] };
        map.set(key, lot);
        out.push(lot);
      }
      if (!lot.leads.some((x) => x.mid === r.mid)) lot.leads.push(r);
      if (r.status === 'linked') lot.plates.push(r);
    });
    return out;
  }

  /** まとめる単位の呼び名（画面の「〇 ロット」の「ロット」） */
  function unitName(groupBy, columns) {
    const cols = groupCols(groupBy);
    if (!cols.length) return 'ロット';
    return cols.map((id) => { const c = (columns || []).find((x) => x.id === id); return c ? c.label : id.slice(2); }).join('＋');
  }

  /** ツールで作った帳票（ひな形の Excel を使わない）か */
  const isNative = (preset) => !!(preset && preset.doc);
  /** ブロックで作った帳票（帯・区画・表）か。doc・places・items は blocks から作った結果 */
  const isBlock = (preset) => !!(preset && preset.blocks);

  /** 1 ページに入る板の数（板の表が未指定なら全部 1 ページ。ツールで作った帳票は用紙の大きさから決める） */
  const rowsPerPage = (preset) => {
    if (!preset.table) return Infinity;
    if (isNative(preset)) return CDB.sheetPages.capacity(preset.doc, preset.table);
    return preset.table.bottom - preset.table.top + 1;
  };

  /**
   * 板の表の行を「列ごと」にまとめる帳票か（検査番号ごとに 1 行など）。ツールで作った帳票だけ
   */
  const isGrouped = (preset) => isNative(preset) && RG().isGrouped(preset);

  /* 列ごとの行：行の一覧・行ごとの高さ・ページの分け方。ロット・帳票が変わらないあいだは使い回す（ページごとに何度も呼ばれるため） */
  const GROUP_CACHE = new WeakMap();
  function groupLayout(preset, lot, columns) {
    const hit = GROUP_CACHE.get(lot);
    if (hit && hit.doc === preset.doc && hit.places === preset.places && hit.items === preset.items && hit.table === preset.table && hit.withCols === !!columns) return hit.res;
    const t = preset.table;
    const doc = preset.doc;
    const entries = RG().entriesOf(preset, lot);
    const base = [];
    for (let r = t.top; r <= t.bottom; r++) base.push(doc.rowH[r] || 28);
    // 折り返して長くなる行を広げる（値を計算して、文字の長さから行数を見積もる）。列の情報がなければ広げない
    const heights = columns ? growHeights(preset, lot, entries, base, columns) : entries.map(() => base.slice());
    const manual = doc.page.rows > 0 ? Math.floor(doc.page.rows) : 0;
    const pages = RG().paginate(heights.map((a) => a.reduce((x, y) => x + y, 0)), CDB.sheetPages.bodyAvail(doc, t), manual);
    const res = { entries, heights, pages };
    GROUP_CACHE.set(lot, { doc, places: preset.places, items: preset.items, table: preset.table, withCols: !!columns, res });
    return res;
  }

  /** 列ごとの行：各行の各セルの値から、必要な高さ（px）を出す。結果は行ごとの、繰り返す行（table.top〜bottom）の高さの並び */
  function growHeights(preset, lot, entries, base, columns) {
    const doc = preset.doc;
    const t = preset.table;
    const env = evaluator(preset, columns);
    const D = CDB.sheetDoc;
    const widthOf = (r, c) => {
      const m = doc.merges.find((x) => r >= x.r0 && r <= x.r1 && c >= x.c0 && c <= x.c1);
      if (m && m.r1 > m.r0) return -1; // 行をまたぐ結合は、高さを触らない
      let w = 0;
      for (let k = m ? m.c0 : c; k <= (m ? m.c1 : c); k++) w += doc.colW[k] || 0;
      return w;
    };
    const cellsOf = preset.places.filter((pl) => pl.r >= t.top && pl.r <= t.bottom && pl.show !== 'label');
    return entries.map((en, idx) => {
      const hs = base.slice();
      cellsOf.forEach((pl) => {
        const item = env.items.get(pl.item);
        const w = widthOf(pl.r, pl.c);
        if (!item || w < 0) return;
        const style = (doc.cells[pl.r + ',' + pl.c] || {}).s;
        if (!style || !style.wrap) return; // 折り返さないセルは、高さを変えない
        const rc = context({ lot, row: en.row, rowPlates: en.plates, rowIndex: idx, page: { no: 1, count: 1, plates: en.plates.length }, resolve: env.resolve, itemValue: env.itemValue });
        const out = RI.resolve(item, rc);
        const text = rc.multi.size ? '' : out.text;
        const k = pl.r - t.top;
        hs[k] = Math.max(hs[k], RG().needPx(text, w, style, D.DEFAULT_SIZE));
      });
      return hs;
    });
  }

  /** 板の表がある区間のページ数（板の数 ÷ 1 ページの板の数。最低 1。列ごとの行は、行の高さで分けたページ数） */
  function plateTotal(preset, lot, columns) {
    if (isGrouped(preset)) return Math.max(1, groupLayout(preset, lot, columns).pages.length);
    const n = rowsPerPage(preset);
    return n === Infinity ? 1 : Math.max(1, Math.ceil(lot.plates.length / n));
  }

  /**
   * 総ページ数。ツールで作った帳票は、改ページで分けた区間の順に、板の表がある区間は板の数ぶん、ほかの区間は 1 ページずつ
   */
  function pageCount(preset, lot, columns) {
    if (!isNative(preset)) return plateTotal(preset, lot, columns);
    const { secs } = CDB.sheetPages.sectionsOf(preset.doc);
    const ps = CDB.sheetPages.plateSection(preset.doc, preset.table);
    return secs.reduce((a, _, i) => a + (i === ps ? plateTotal(preset, lot, columns) : 1), 0) || 1;
  }

  /** ページ番号（0 始まり）→ どの区間の何ページ目か。{sec, plateIdx, isPlate} */
  function pageSpec(preset, lot, pageIdx, columns) {
    if (!isNative(preset)) return { sec: 0, plateIdx: pageIdx, isPlate: !!preset.table };
    const { secs } = CDB.sheetPages.sectionsOf(preset.doc);
    const ps = CDB.sheetPages.plateSection(preset.doc, preset.table);
    let at = 0;
    for (let i = 0; i < secs.length; i++) {
      const n = i === ps ? plateTotal(preset, lot, columns) : 1;
      if (pageIdx < at + n) return { sec: i, plateIdx: i === ps ? pageIdx - at : 0, isPlate: i === ps };
      at += n;
    }
    return { sec: secs.length - 1, plateIdx: 0, isPlate: secs.length - 1 === ps };
  }

  /* ---------- 列名の解決 ---------- */
  /**
   * 列の一覧から、式の [列名] を列ID に直す仕組みを作る
   * [元:列名] / [板:列名] で明示。無印は、表の行では板→元、それ以外では元→板の順に探す
   */
  function nameResolver(columns) {
    const master = new Map();
    const plate = new Map();
    const masterIds = new Set();
    columns.forEach((c) => {
      if (c.side === 'master') { master.set(U.normKey(c.label), c.id); masterIds.add(c.id); }
      if (c.side === 'plate') plate.set(U.normKey(c.label), c.id);
    });
    const resolve = (name, inRow) => {
      const s = U.normValue(name);
      const m = s.match(/^(元|板)\s*[:：]\s*(.+)$/);
      if (m) return (m[1] === '元' ? master : plate).get(U.normKey(m[2])) || null;
      const k = U.normKey(s);
      return inRow ? plate.get(k) || master.get(k) || null : master.get(k) || plate.get(k) || null;
    };
    /** 名前が re に合う列の ID（板の側を先に。なければ null）。検査番号の列を、列名の違い（検査番号・検査No・検番）を問わず探すのに使う */
    resolve.find = (re, plateFirst = true) => {
      const hit = (side) => columns.find((c) => c.side === side && re.test(U.normValue(c.label)));
      const c = (plateFirst ? hit('plate') || hit('master') : hit('master') || hit('plate'));
      return c ? c.id : null;
    };
    /** 元データ側の列か（作った列〔js/domain/calc.js〕は ID の頭が c: なので、列の側で見る） */
    resolve.isMaster = (id) => masterIds.has(id) || String(id).startsWith('m:');
    return resolve;
  }

  /**
   * 計算の文脈（式の ref・all、DB の列 get、ツールの値）
   * @param {{lot, row, rowIndex, page, resolve}} o row は表の行の板（表の外では null）
   */
  function context(o) {
    const leads = o.lot.leads && o.lot.leads.length ? o.lot.leads : [o.lot.lead];
    const live = o.lot.live || o.lot.plates;
    const plates = live.length ? live : [o.lot.lead];
    const rowPlates = o.row && o.rowPlates && o.rowPlates.length ? o.rowPlates : null; // 列ごとの行：この行にまとめた板
    const multi = new Set(); // 1 枚の中で値が複数あったため空欄にした列
    /** 1 枚の中の値を 1 つにする。空欄は除き、値が複数なら空欄（帳票には出さない） */
    const one = (colId, list, raw) => {
      // raw：データ側の丸め（判定設定）の前の値。丸めの設定がなければ raw はなく、v と同じ
      const vals = list.map((x) => (raw && x.raw ? x.raw : x.v)[colId]).filter((v) => U.normValue(v) !== '');
      const kinds = new Set(vals.map((v) => U.normKey(v)));
      if (kinds.size > 1) { multi.add(colId); return ''; }
      return vals.length ? vals[0] : '';
    };
    const valueOf = (colId, inRow, raw) => {
      if (!colId) return '';
      // 表の行では、その板の行の値（元データの値も板の行が持っている）
      if (inRow && o.row) {
        if (rowPlates && !o.resolve.isMaster(colId)) return one(colId, rowPlates, raw); // まとめた板で値が違えば空欄（表の外と同じ決まり）
        const src = raw && o.row.raw ? o.row.raw : o.row.v;
        return src[colId] !== undefined ? src[colId] : o.resolve.isMaster(colId) ? (raw && o.lot.lead.raw ? o.lot.lead.raw : o.lot.lead.v)[colId] : '';
      }
      return one(colId, o.resolve.isMaster(colId) ? leads : plates, raw);
    };
    /** 列名の頭の「生:」（データ側で丸める前の値を使う）を外す */
    const RAW_PREFIX = /^\s*生\s*[:：]\s*/;
    const idOf = (name) => {
      const id = o.resolve(name, !!o.row);
      if (!id) throw new F.FormulaError('#REF!', `列「${name}」がありません（[元:列名] [板:列名] で指定できます）`);
      return id;
    };
    const rc = {
      multi,
      lot: o.lot,
      row: o.row,
      rowIndex: o.rowIndex,
      page: o.page,
      rowPlates,
      /** 値の列と、分ける列（検査番号など）の対。まとめた行ならその行の板、そうでなければ 1 枚の全部の板 */
      pairs: (valName, keyName) => {
        const vid = idOf(valName);
        // 分ける列：名前を指定しなければ、検査番号の列を探す（列名は 検査番号・検査No・検番 のどれでも）。板の側の列を先に探す（板ごとに値を持つため）
        const kid = keyName ? o.resolve(keyName, true) : o.resolve.find(/^検査(番号|no\.?)$|^検番$/i);
        if (!kid) throw new F.FormulaError('#REF!', keyName ? `列「${keyName}」がありません（[元:列名] [板:列名] で指定できます）` : '検査番号の列がありません（まとめ=列名 で、分ける列を指定できます）');
        return (rowPlates || o.lot.live || o.lot.plates).map((p) => ({ v: p.v[vid], k: p.v[kid] !== undefined ? p.v[kid] : o.lot.lead.v[kid] }));
      },
      itemValue: o.itemValue ? (id) => o.itemValue(id, rc) : undefined,
      get: (colId) => {
        if (colId && !o.resolve.has(colId)) throw new F.FormulaError('#REF!', `列「${RI.colText(colId)}」が表示中のデータにありません`);
        return valueOf(colId, !!o.row);
      },
      /** データ側の丸めの前の値（帳票で丸める規則を選んだ項目が使う。二重に丸めない） */
      getRaw: (colId) => {
        if (colId && !o.resolve.has(colId)) throw new F.FormulaError('#REF!', `列「${RI.colText(colId)}」が表示中のデータにありません`);
        return valueOf(colId, !!o.row, true);
      },
      ref: (name) => (RAW_PREFIX.test(name) ? valueOf(idOf(name.replace(RAW_PREFIX, '')), !!o.row, true) : valueOf(idOf(name), !!o.row)),
      all: (name) => {
        const id = idOf(name);
        return (o.resolve.isMaster(id) ? leads : rowPlates || o.lot.live || o.lot.plates).map((p) => p.v[id]);
      }
    };
    return rc;
  }

  /**
   * 1 ページの板の行数などを決める
   * ツールで作った帳票：板の表の行数は このページの板の数。フッターは最後のページのみ（設定で毎ページ）
   * @returns {{per, count, nHere, plates, showFooter, shift}} plates：このページに載る板の数（外した板は数えない）
   */
  function pageInfo(preset, lot, pageIdx, columns) {
    const per = rowsPerPage(preset);
    const count = pageCount(preset, lot, columns);
    const t = preset.table;
    const native = isNative(preset);
    const spec = pageSpec(preset, lot, pageIdx, columns);
    const pIdx = spec.plateIdx;
    const grouped = isGrouped(preset);
    let entries = [];
    let start = 0;
    let repH = null;
    if (spec.isPlate && grouped) { // 列ごとの行：ページごとの分かれ目（行の高さで決める）
      const gl = groupLayout(preset, lot, columns);
      const pg = gl.pages[pIdx] || [0, 0];
      start = pg[0];
      entries = gl.entries.slice(pg[0], pg[1]);
      repH = gl.heights.slice(pg[0], pg[1]);
    } else if (spec.isPlate) {
      start = per === Infinity ? 0 : pIdx * per;
      entries = (per === Infinity ? lot.plates : lot.plates.slice(pIdx * per, (pIdx + 1) * per)).map((r) => ({ row: r, plates: [r] }));
    }
    const live = grouped ? (lot.live || lot.plates).length : lot.skip ? lot.plates.filter((r) => !lot.skip.has(r)).length : lot.plates.length;
    const plates = !spec.isPlate ? live : grouped ? entries.reduce((a, e) => a + e.plates.length, 0) : lot.skip ? entries.filter((e) => !lot.skip.has(e.row)).length : entries.length;
    const nHere = native ? (spec.isPlate && per !== Infinity ? entries.length : 0) : per;
    // 板の表より下の帯：板の表の最後のページだけ（設定で毎ページ）
    const showFooter = !native || !t || preset.doc.page.footer === 'every' || pIdx >= plateTotal(preset, lot, columns) - 1;
    return { per, count, nHere, plates, showFooter, shift: native && t ? nHere - 1 : 0, sec: spec.sec, plateIdx: pIdx, isPlate: spec.isPlate, entries, start, repH, grouped };
  }

  /** 値の計算の道具（列の名前の解決・項目の登録簿・別のセルの参照）。renderPage と、行の高さの見積もりで同じものを使う */
  function evaluator(preset, columns) {
    const resolve = nameResolver(columns);
    const ids = new Set(columns.map((c) => c.id));
    resolve.has = (id) => ids.has(id);
    const items = new Map(preset.items.concat(preset.floatItems || []).map((it) => [it.id, it]));
    // 同じ表の別のセルの値（C3 など）。自分に戻ってきたら循環
    const guard = new Set();
    const itemValue = (id, rc) => {
      const it = items.get(id);
      if (!it) return '';
      if (guard.has(id)) throw new F.FormulaError('#REF!', 'セルの参照が循環しています');
      guard.add(id);
      try {
        const out = RI.resolve(it, rc);
        if (out.error) throw new F.FormulaError(out.error.code, out.error.message);
        if (out.blank) return ''; // 空欄は空欄のまま渡す（「－」などの空欄時の文字を、計算に使わない）
        return out.num !== undefined ? out.num : out.text;
      } finally { guard.delete(id); }
    };
    return { resolve, items, itemValue };
  }

  /**
   * 1 ページ分のセルの値を作る
   * @returns {{cells: Map<string, {text, num?, numFmt?, error?, place, item}>, errors: {label, message}[]}}
   */
  function renderPage(preset, lot, pageIdx, columns) {
    const { resolve, items, itemValue } = evaluator(preset, columns);
    const cells = new Map();
    const errors = [];
    const t = preset.table;
    const native = isNative(preset);
    const info = pageInfo(preset, lot, pageIdx, columns);
    const { per, nHere, showFooter } = info;
    const plan = native ? CDB.sheetPages.plan(preset.doc, t, info.sec, info.isPlate ? nHere : 0, showFooter) : null; // このページの行の計画（区間・繰り返し・フッター）
    // ページ番号の開始（ブロックの帳票：ページ設定の「開始番号」。総ページ数はそのまま）
    const page = { no: pageIdx + 1 + (preset.blocks && preset.blocks.page.pageStart > 1 ? preset.blocks.page.pageStart - 1 : 0), count: info.count, plates: info.plates };

    const multi = new Set();
    const put = (r, c, pl, item, rc) => {
      let out;
      if (pl.show === 'label') out = { text: item.label };
      else {
        out = RI.resolve(item, rc);
        // 値が複数のため空欄にした（表示しない）。空欄時の文字・書式も当てない
        if (rc.multi.size) {
          rc.multi.forEach((id) => multi.add(id));
          out = { text: '', multi: Array.from(rc.multi) };
        }
        if (out.error) errors.push({ label: item.label, message: out.error.message });
        if (pl.show === 'both') out = { text: item.label + (pl.sep === undefined ? '：' : pl.sep) + out.text, error: out.error };
      }
      cells.set(r + ',' + c, Object.assign(out, { place: pl, item }));
    };

    preset.places.forEach((pl) => {
      const item = items.get(pl.item);
      if (!item) return;
      if (native && !CDB.sheetPages.rowVisible(preset.doc, pl.r, { idx: pageIdx, count: info.count })) return; // このページに出さない帯
      if (native) {
        if (t && pl.r >= t.top && pl.r <= t.bottom) { // 板の表の繰り返す行（複数行もある）。ほかの区間のページには出さない
          if (!info.isPlate || per === Infinity) return;
          const h = t.bottom - t.top + 1;
          const start = plan.rowOf(t.top);
          for (let i = 0; i < nHere; i++) {
            const idx = info.start + i;
            const en = info.entries[i];
            const row = en && en.row;
            const to = start + i * h + (pl.r - t.top);
            // 板のない行は空にする（空欄時の文字では埋めない）。列ごとの行は、外した板を最初から含めない
            if (!row || (!info.grouped && lot.skip && lot.skip.has(row))) { cells.set(to + ',' + pl.c, { text: '', place: pl, item, empty: true, skipped: !!row }); continue; }
            put(to, pl.c, pl, item, context({ lot, row, rowPlates: info.grouped ? en.plates : null, rowIndex: idx, page, resolve, itemValue }));
          }
          return;
        }
        const to = plan.rowOf(pl.r); // このページに出さない行（別の区間・フッターを出さないページ）は null
        if (to === null) return;
        put(to, pl.c, pl, item, context({ lot, row: null, rowIndex: -1, page, resolve, itemValue }));
        return;
      }
      // ひな形（Excel）の帳票：板の表の行はテンプレートの行そのまま
      if (t && pl.r === t.top && per !== Infinity) {
        for (let i = 0; i < nHere; i++) {
          const idx = pageIdx * per + i;
          const row = lot.plates[idx];
          if (!row || (lot.skip && lot.skip.has(row))) { cells.set((t.top + i) + ',' + pl.c, { text: '', place: pl, item, empty: true, skipped: !!row }); continue; }
          put(t.top + i, pl.c, pl, item, context({ lot, row, rowIndex: idx, page, resolve, itemValue }));
        }
        return;
      }
      put(pl.r, pl.c, pl, item, context({ lot, row: null, rowIndex: -1, page, resolve, itemValue }));
    });
    // 自由に置く物（テキストボックス・表）の値。キーは「物の ID|行,列」
    const floatCells = new Map();
    (preset.floats || []).forEach((f) => (f.cells || []).forEach((c) => {
      const item = items.get(c.item);
      if (!item) return;
      const out = RI.resolve(item, context({ lot, row: null, rowIndex: -1, page, resolve, itemValue }));
      if (out.error) errors.push({ label: item.label, message: out.error.message });
      floatCells.set(f.id + '|' + c.r + ',' + c.c, out);
    }));
    return { cells, errors, page, multi: Array.from(multi), rows: nHere, showFooter, floatCells };
  }

  /**
   * 1 つの項目を、指定のロットで試しに計算する（変換表の「このロットでは」表示用）
   * 板の表に配置されていれば 1 枚目の板、それ以外はロットの値で計算する
   */
  function previewItem(preset, item, lot, columns) {
    if (!lot) return null;
    const resolve = nameResolver(columns);
    const ids = new Set(columns.map((c) => c.id));
    resolve.has = (id) => ids.has(id);
    const inTable = !!preset.table && preset.places.some((p) => p.item === item.id && p.r === preset.table.top);
    const row = inTable ? lot.plates[0] || null : null;
    const rc = context({ lot, row, rowIndex: row ? 0 : -1, page: { no: 1, count: pageCount(preset, lot, columns) }, resolve, rowPlates: row && isGrouped(preset) ? (RG().entriesOf(preset, lot)[0] || {}).plates : null });
    return Object.assign(RI.resolve(item, rc), { inTable, row: !!row });
  }

  /** 式で使う列名（元データと板で同じ名前があるときは 元: / 板: を付ける） */
  function refName(col, columns) {
    const dup = columns.some((c) => c.id !== col.id && (c.side === 'master' || c.side === 'plate') && U.normKey(c.label) === U.normKey(col.label));
    return dup ? (col.side === 'master' ? '元:' : '板:') + col.label : col.label;
  }

  /* ---------- 点検 ---------- */
  /**
   * 出力できない理由と、注意を返す
   * @returns {{blockers:string[], warnings:string[]}}
   */
  function check(preset, template, lots, columns) {
    const blockers = [];
    const warnings = [];
    if (!preset) { blockers.push('帳票プリセットを選ぶか、新しく作ってください'); return { blockers, warnings }; }
    if (isNative(preset)) { /* ツールで作った帳票にはひな形の Excel がない */ }
    else if (!template) blockers.push('テンプレート（Excel ファイル）を登録してください');
    else if (!template.sheets.includes(preset.sheet)) blockers.push(`テンプレートにシート「${preset.sheet}」がありません。シートを選び直してください`);
    if (!preset.places.length) blockers.push(isBlock(preset) ? '表のセルに、文字や {列名} を 1 つ以上入れてください' : isNative(preset) ? 'この帳票は旧形式です。新しい帳票を作ってください' : 'プレビューのセルをクリックして、項目を 1 つ以上配置してください');
    if (!lots.length) blockers.push('出力する対象がありません（絞り込み・フォルダ・1 枚にまとめる単位を見直してください）');
    const resolve = nameResolver(columns);
    const ids = new Set(columns.map((c) => c.id));
    preset.items.forEach((it) => {
      RI.kindOf(it).refs(it).forEach((ref) => {
        const ok = /^[mp]:/.test(ref) ? ids.has(ref) : !!resolve(ref, true);
        if (!ok) warnings.push(`「${it.label}」が使う列「${/^[mp]:/.test(ref) ? RI.colText(ref) : ref}」が表示中のデータにありません`);
      });
    });
    // 板ごとの行に「まとめ」を置くと、全部の行にロット全体のまとめが出る（検査番号ごとの行にしたいことが多い）
    if (preset.table && !preset.table.by && isNative(preset)) {
      const inRep = (id) => preset.places.some((pl) => pl.item === id && pl.r >= preset.table.top && pl.r <= preset.table.bottom);
      if (preset.items.some((it) => it.kind === 'formula' && /RANGES(BY)?\(/.test(it.expr || '') && inRep(it.id))) warnings.push('板の表の行が「板ごと」のため、「連続まとめ」の板番号は、全部の行にロット全体のまとめが出ます。検査番号ごとに出すときは、操作バーの「行のまとめ」で列を選んでください');
    }
    if (preset.table && preset.table.by && !ids.has(preset.table.by)) warnings.push(`板の表の行をまとめる列「${RI.colText(preset.table.by)}」が表示中のデータにありません（板ごとに 1 行でなく、空の列でまとめます）`);
    if (preset.table) {
      const rowItems = preset.places.filter((p) => p.r === preset.table.top);
      if (!rowItems.length) warnings.push('板の表の 1 行目に項目が配置されていません');
    } else if (preset.places.some((p) => {
      const it = preset.items.find((x) => x.id === p.item);
      return it && it.kind === 'field' && /^p:/.test(it.col);
    })) warnings.push('板の列を板の表の外に配置しています。1 枚の中で板ごとに値が違うときは空欄にします');
    return { blockers, warnings: Array.from(new Set(warnings)) };
  }

  /** 項目が配置されている数 */
  const placeCount = (preset, itemId) => preset.places.filter((p) => p.item === itemId).length;

  /** ツールで作った帳票の 1 ページ分の見た目（板の表を行数分に増やしたモデル）。値は renderPage の cells を重ねる */
  function pageLayout(preset, lot, pageIdx, name, columns) {
    const info = pageInfo(preset, lot, pageIdx, columns);
    const lay = Object.assign(CDB.sheetPages.pageModel(preset.doc, preset.table, info.nHere, info.showFooter, name, { idx: pageIdx, count: info.count }, info.sec, info.start, info.repH), { rows: info.nHere, showFooter: info.showFooter });
    // 改行・長い文字で、はみ出すセルの行を広げる（検査番号ごとの板番号を 1 つのセルに並べるときなど）。列の情報がなければ広げない
    if (columns && isNative(preset)) RG().growRows(lay.model, renderPage(preset, lot, pageIdx, columns).cells, CDB.sheetDoc.DEFAULT_SIZE);
    return lay;
  }

  /** ツールで作る帳票の新しいプリセット（ブロックの骨組み：表題・注文情報・承認欄・板の表・ヘッダー・フッター） */
  function newNativePreset(name) {
    const p = Object.assign(newPreset(name || '新しい帳票', '', ''), { blocks: CDB.blockDoc.skeleton() });
    CDB.blockCompile.apply(p);
    return p;
  }

  /** Excel のシート名に使えるようにする（31 文字・使えない記号を除く） */
  function sheetName(base, used) {
    let s = String(base || 'Sheet').replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'Sheet';
    let n = 2;
    const stem = s;
    while (used.has(s.toUpperCase())) { const suf = ` (${n++})`; s = stem.slice(0, 31 - suf.length) + suf; }
    used.add(s.toUpperCase());
    return s;
  }

  /** ファイル名（帳票名_yyyymmdd_hhmm） */
  function fileName(preset, ext) {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    const base = String(preset.name || '帳票').replace(/[\\/:*?"<>|]/g, '_');
    return `${base}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
  }

  CDB.reportModel = {
    SHOW, listPresets, listTemplates, getTemplate, newPreset, savePreset, removePreset, duplicate,
    saveTemplate, removeTemplate, buildLots, groupKey, groupName, groupCols, unitName, rowsPerPage, pageCount, pageSpec, isGrouped, groupLayout, nameResolver, renderPage, previewItem, refName, check,
    placeCount, sheetName, fileName, isNative, isBlock, pageInfo, pageLayout, newNativePreset
  };
})();
