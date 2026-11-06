/* =========================================================
   js/report/items.js : 帳票の項目（変換表の 1 行）の種類と、値の変換の流れ
   項目 item = {
     id, label: 表示名, kind: 'field' | 'formula' | 'tolerance' | 'text' | 'system',
     col:  'm:列名' | 'p:列名'                         … field（DB の列そのまま）
     expr: 'FIXED([板厚],3) & "mm"'                    … formula（Excel と同じ書き方）
     tol:  { base, minus, plus, tolRound, tolDigits, digits, unit, sep, comma } … tolerance
           base/minus/plus = { src:'col'|'num', v }（列名 or 数値）
     text: '固定の文字'                                 … text
     sys:  'today' | 'page' | ...                       … system
     fmt:  { type:'auto'|'number'|'date'|'text', digits, comma, date, round }  round は丸めの方法（half_up｜half_even｜ceil｜floor。空は従来どおり四捨五入）。選ぶと、データ側で丸める前の値から丸める
     blank: '空欄のときに出す文字'
     map:  [{ from, to }]                               … 値の置き換え（from='*' はほかの値すべて）
   }
   値の流れ：中身を計算 → 空欄なら「空欄時」→ 置き換え → 書式
   種類は register() で足せる（既存のコードは変えない）。画面には依存しない
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const F = CDB.formula;

  /* ---------- 種類の登録簿 ---------- */
  const KINDS = {};
  const ORDER = [];
  /**
   * @param {string} kind
   * @param {{label:string, icon:string, desc:string, create:Function, compute:Function, summary:Function, refs?:Function}} def
   *   compute(item, rc) … rc は report-model の計算文脈（get・ref・all・sys）。値を返すか FormulaError を投げる
   */
  function register(kind, def) {
    if (!KINDS[kind]) ORDER.push(kind);
    KINDS[kind] = Object.assign({ refs: () => [] }, def, { kind });
  }
  const kinds = () => ORDER.map((k) => KINDS[k]);
  const kindOf = (item) => KINDS[item.kind] || KINDS.text;

  /** 列ID（m:材質 / p:幅）→ 画面に出す名前 */
  function colText(colId) {
    if (!colId) return '（未選択）';
    const side = colId.slice(0, 2) === 'm:' ? '元' : colId.slice(0, 2) === 'p:' ? '板' : colId.slice(0, 2) === 'c:' ? '作った列' : '';
    return `${colId.slice(2)}（${side}）`;
  }

  /** 公差の値の参照（列 or 数値）を式の断片にする */
  function operand(o, raw) {
    if (!o || U.normValue(o.v) === '') return '0';
    return o.src === 'col' ? `[${raw ? '生:' : ''}${o.v}]` : String(U.toNumber(o.v));
  }

  /** 丸める規則を選んだ数値の書式か（選ぶと、データ側の丸めの前の値から丸める） */
  const wantsRaw = (item) => !!(item.fmt && item.fmt.type === 'number' && item.fmt.round && U.normValue(item.fmt.digits) !== '');

  /* ---------- 標準の種類 ---------- */
  register('field', {
    label: 'DB の列', icon: 'fa-database', desc: 'DB の列の値をそのまま出します',
    create: (o) => ({ col: (o && o.col) || '' }),
    compute: (item, rc) => (wantsRaw(item) && rc.getRaw ? rc.getRaw(item.col) : rc.get(item.col)),
    summary: (item) => colText(item.col),
    refs: (item) => (item.col ? [item.col] : [])
  });

  register('formula', {
    label: '計算式', icon: 'fa-square-root-variable', desc: 'Excel と同じ書き方の式で値を作ります（列は [列名]）',
    create: (o) => ({ expr: (o && o.expr) || '' }),
    compute: (item, rc) => {
      const r = F.evaluate(wantsRaw(item) ? F.rawRefs(item.expr) : item.expr, rc);
      if (r.error) throw new F.FormulaError(r.error.code, r.error.message);
      return r.value;
    },
    summary: (item) => (U.normValue(item.expr) ? '=' + item.expr : '（式が空です）'),
    refs: (item) => F.refs(item.expr)
  });

  register('tolerance', {
    label: '公差範囲', icon: 'fa-arrows-left-right-to-line', desc: '基準値と ± の公差から「下限値 ～ 上限値」を作ります',
    create: () => ({
      tol: {
        base: { src: 'col', v: '' }, minus: { src: 'col', v: '' }, plus: { src: 'col', v: '' },
        tolRound: '', tolDigits: 1, digits: 3, unit: 'mm', sep: ' ～ ', comma: false
      }
    }),
    /** 公差の設定を式に直して計算する（式の画面に移しても同じ結果になる） */
    compute: (item, rc) => {
      const expr = toleranceExpr(item.tol);
      if (!expr) return '';
      const r = F.evaluate(expr, rc);
      if (r.error) throw new F.FormulaError(r.error.code, r.error.message);
      return r.value;
    },
    summary: (item) => {
      const t = item.tol || {};
      const s = (o) => (o && o.src === 'col' ? `[${o.v || '?'}]` : (o && o.v) || '0');
      return `${s(t.base)} −${s(t.minus)} ～ +${s(t.plus)}（小数${t.digits}桁${t.unit ? '・' + t.unit : ''}）`;
    },
    refs: (item) => ['base', 'minus', 'plus'].map((k) => item.tol && item.tol[k]).filter((o) => o && o.src === 'col' && o.v).map((o) => o.v)
  });

  register('text', {
    label: '固定の文字', icon: 'fa-font', desc: '決まった文字を出します（見出しの書き換えなど）',
    create: (o) => ({ text: (o && o.text) || '' }),
    compute: (item) => item.text || '',
    summary: (item) => `「${item.text || ''}」`
  });

  const SYSTEM = [
    { value: 'today', label: '出力日', get: (rc) => F.formatDate(Date.now(), 'yyyy/mm/dd') },
    { value: 'page', label: 'ページ（1/2）', get: (rc) => `${rc.page.no}/${rc.page.count}` },
    { value: 'pageNo', label: 'ページ番号', get: (rc) => rc.page.no },
    { value: 'pageCount', label: '総ページ数', get: (rc) => rc.page.count },
    { value: 'plateCount', label: '板の枚数（ロット）', get: (rc) => (rc.lot.live || rc.lot.plates).length },
    { value: 'platePage', label: '板の枚数（このページ）b', get: (rc) => (rc.page.plates === undefined ? '' : rc.page.plates) },
    { value: 'plateBA', label: '板の枚数（このページ／全体）b/a', get: (rc) => `${rc.page.plates === undefined ? '' : rc.page.plates}/${(rc.lot.live || rc.lot.plates).length}` },
    { value: 'rowNo', label: '行番号（表の中）', get: (rc) => (rc.rowIndex >= 0 ? rc.rowIndex + 1 : '') },
    { value: 'lot', label: 'ロットの名前', get: (rc) => rc.lot.name }
    // docMaker：CDB の「フォルダ」は無いので外した
  ];
  register('system', {
    label: 'ツールの値', icon: 'fa-gear', desc: '出力日・ページ番号・板の枚数など、ツールが数える値を出します',
    create: () => ({ sys: 'today' }),
    compute: (item, rc) => { const s = SYSTEM.find((x) => x.value === item.sys); return s ? s.get(rc) : ''; },
    summary: (item) => { const s = SYSTEM.find((x) => x.value === item.sys); return s ? s.label : '?'; }
  });

  /** 公差範囲 → 式。基準値が未設定なら空 */
  function toleranceExpr(t) {
    if (!t || !t.base || U.normValue(t.base.v) === '') return '';
    // 規則 A（偶数丸め）か、表示の桁の規則を選んだときは、データ側で丸める前の値から計算する（二重に丸めない）。選ばなければ従来どおり
    const raw = !!t.round || t.tolRound === 'half_even';
    const base = operand(t.base, raw);
    const tolOf = (o) => {
      const x = `ABS(${operand(o, raw)})`;
      if (t.tolRound === 'floor') return `ROUNDDOWN(${x}, ${t.tolDigits | 0})`;
      if (t.tolRound === 'ceil') return `ROUNDUP(${x}, ${t.tolDigits | 0})`;
      if (t.tolRound === 'half_up') return `ROUND(${x}, ${t.tolDigits | 0})`;
      if (t.tolRound === 'half_even') return `ROUNDEVEN(${x}, ${t.tolDigits | 0})`;
      return x;
    };
    const rule = t.round ? `"${F.RULE_CODE[t.round] || 'B'}"` : '';
    const fix = (x) => `FIXED(${x}, ${t.digits | 0}, ${t.comma ? 'FALSE' : 'TRUE'}${rule ? ', ' + rule : ''})`;
    const unit = (t.unit || '').replace(/"/g, '""');
    const sep = (t.sep === undefined ? ' ～ ' : t.sep).replace(/"/g, '""');
    return `IF(ISBLANK(${base}), "", ${fix(`${base}-${tolOf(t.minus)}`)} & "${unit}${sep}" & ${fix(`${base}+${tolOf(t.plus)}`)} & "${unit}")`;
  }

  /* ---------- 書式 ---------- */
  const FMT_TYPES = [
    { value: 'auto', label: 'そのまま' },
    { value: 'number', label: '数値' },
    { value: 'date', label: '日付' },
    { value: 'text', label: '文字' }
  ];
  const DATE_PATTERNS = ['yyyy/mm/dd', 'yyyy-mm-dd', 'yyyy年m月d日', 'yyyy.mm.dd', 'mm/dd', 'yy/mm/dd'];
  const PLAIN_NUM = /^-?(0|[1-9]\d*)(\.\d+)?$/;

  /**
   * 値を帳票に出す形にする
   * @returns {{text:string, num?:number, numFmt?:string, blank?:boolean, mapped?:boolean}}
   */
  function finalize(item, raw) {
    const fmt = item.fmt || { type: 'auto' };
    if (F.isBlank(raw)) return { text: item.blank || '', blank: true };
    const str = F.toStr(raw);
    // 「この値も空欄とみなす」（例：「-」）。0 などの本当の値は、指定しない限り空欄にしない
    if ((item.blankAs || []).some((v) => U.normValue(v) !== '' && U.normKey(v) === U.normKey(str))) return { text: item.blank || '', blank: true };
    const rule = (item.map || []).find((m) => U.normValue(m.from) !== '' && (U.normKey(m.from) === U.normKey(str) || m.from === '*'));
    const exact = (item.map || []).find((m) => U.normValue(m.from) !== '' && m.from !== '*' && U.normKey(m.from) === U.normKey(str));
    const hit = exact || rule;
    if (hit) return { text: hit.to || '', mapped: true };

    if (fmt.type === 'number') {
      const n = U.toNumber(str);
      if (!Number.isFinite(n)) return { text: str };
      const digits = U.normValue(fmt.digits) === '' ? null : Number(fmt.digits);
      const s = digits === null ? F.numToStr(n) : F.roundDec(n, digits, fmt.round || 'half_up');
      const zeros = digits ? '.' + '0'.repeat(digits) : '';
      return { text: fmt.comma ? F.withCommas(s) : s, num: Number(s), numFmt: (fmt.comma ? '#,##0' : '0') + zeros };
    }
    if (fmt.type === 'date') return { text: F.formatDate(str, fmt.date || 'yyyy/mm/dd') };
    if (fmt.type === 'text') return { text: str };
    // そのまま：ふつうの数値（先頭の 0 なし）は数値として出し、小数の桁数を保つ
    if (typeof raw === 'number' || PLAIN_NUM.test(str)) {
      const dec = (str.split('.')[1] || '').length;
      return { text: str, num: Number(str), numFmt: dec ? '0.' + '0'.repeat(dec) : 'General' };
    }
    return { text: str };
  }

  /** 前の文字・後ろの文字（単位など）を値につける。空欄・エラーのときはつけない。つけたら文字として出す */
  function decorate(item, out) {
    if (!out || out.blank || out.error || (!item.pre && !item.post)) return out;
    return { text: (item.pre || '') + out.text + (item.post || ''), mapped: out.mapped };
  }

  /**
   * 項目の値を計算して整える
   * @returns {{text:string, num?:number, numFmt?:string, error?:{code,message}}}
   */
  function resolve(item, rc) {
    try {
      return decorate(item, finalize(item, kindOf(item).compute(item, rc)));
    } catch (err) {
      if (err instanceof F.FormulaError) return { text: err.code, error: { code: err.code, message: err.message } };
      throw err;
    }
  }

  /** 新しい項目 */
  function create(kind, opts) {
    const o = opts || {};
    const def = KINDS[kind] || KINDS.text;
    return Object.assign({
      id: U.uid('it'),
      label: o.label || def.label,
      kind: def.kind,
      fmt: { type: 'auto', digits: '', comma: false, date: 'yyyy/mm/dd' },
      blank: o.blank === undefined ? '' : o.blank,
      map: []
    }, def.create(o));
  }

  CDB.reportItems = {
    register, kinds, kindOf, create, resolve, finalize, colText, toleranceExpr,
    SYSTEM, FMT_TYPES, DATE_PATTERNS
  };
})();
