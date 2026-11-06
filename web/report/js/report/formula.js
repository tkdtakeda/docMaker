/* =========================================================
   js/report/formula.js : 帳票の計算式（Excel と同じ書き方の式を解釈・計算する）
   ・列の参照は [列名]。元データと板の両方に同じ名前があるときは [元:列名] / [板:列名]
   ・演算子：+ - * / ^ &（文字の連結）= <> < > <= >=
   ・関数は register() で足せる（既存のコードは変えない）。取扱説明書の一覧も登録内容から作る
   ・丸め（FIXED・ROUND など）は小数を文字列のまま計算する（2進数の誤差を出さない）
   画面には依存しない
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;

  /* ---------- エラー ---------- */
  class FormulaError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const fail = (code, msg) => { throw new FormulaError(code, msg); };

  /* ---------- 数値と文字の変換 ---------- */
  /** 数値 → 文字（2進数の誤差を除き、指数表記にしない） */
  function numToStr(n) {
    if (!Number.isFinite(n)) return '';
    const x = Number(n.toPrecision(15));
    let s = String(x);
    if (/e/i.test(s)) s = x.toFixed(12).replace(/\.?0+$/, '');
    return s;
  }

  function toNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (Array.isArray(v)) return toNum(v.length ? v[0] : '');
    const s = U.normValue(v).replace(/,/g, '');
    if (s === '') return 0; // Excel と同じく空欄は 0
    const n = Number(s);
    if (!Number.isFinite(n)) fail('#VALUE!', `「${v}」は数値ではありません`);
    return n;
  }

  function toStr(v) {
    if (typeof v === 'number') return numToStr(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (Array.isArray(v)) return v.map(toStr).join(', ');
    return v === undefined || v === null ? '' : String(v);
  }

  function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    const s = U.normValue(v).toUpperCase();
    if (s === 'TRUE') return true;
    if (s === 'FALSE' || s === '') return false;
    return toNum(s) !== 0;
  }

  const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && U.normValue(v) === '') || (Array.isArray(v) && !v.length);

  /**
   * 丸め規則の呼び名 → 丸めの方法。規則 B＝四捨五入（JIS Z 8401）、規則 A＝偶数丸め（銀行丸め）。
   * 切り上げ・切り捨ては Excel と同じ向き（切り上げ＝0 から離れる、切り捨て＝0 に近づく）
   */
  const RULE_NAMES = {
    B: 'half_up', 規則B: 'half_up', 四捨五入: 'half_up',
    A: 'half_even', 規則A: 'half_even', 偶数: 'half_even', 偶数丸め: 'half_even', 銀行: 'half_even', 銀行丸め: 'half_even',
    上: 'ceil', 切上: 'ceil', 切り上げ: 'ceil', UP: 'ceil',
    下: 'floor', 切捨: 'floor', 切り捨て: 'floor', DOWN: 'floor'
  };
  /** 呼び名 → 丸めの方法（読めなければ ''） */
  const ruleOf = (v) => RULE_NAMES[String(v === undefined || v === null ? '' : v).normalize('NFKC').replace(/[()（）\s]/g, '').toUpperCase()] || '';
  /** 丸めの方法 → 式・変数に書く短い呼び名 */
  const RULE_CODE = { half_up: 'B', half_even: 'A', ceil: '切上', floor: '切捨' };

  /**
   * 式の中の [列名] を、元の値（データ側で丸める前の値）の参照 [生:列名] に直す（文字列の中は触らない）
   * 帳票で丸める規則を選んだとき、データ側の丸めと二重に丸めないために使う
   */
  function rawRefs(src) {
    const parts = String(src).split(/("(?:[^"]|"")*")/); // 奇数番目が文字列
    return parts.map((p, i) => (i % 2 ? p : p.replace(/\[(?!\s*生\s*[:：])([^\]]+)\]/g, (m, n) => `[生:${n}]`))).join('');
  }

  /** 小数の丸め（judge.round を使う）。mode: half_up | ceil | floor | half_even */
  function roundDec(x, digits, mode) {
    const d = Math.max(0, Math.min(15, Math.trunc(digits)));
    return CDB.judge.round(numToStr(x), mode, d);
  }

  /** 桁区切り（1234567.5 → 1,234,567.5） */
  function withCommas(s) {
    const m = String(s).match(/^(-?)(\d+)(\.\d+)?$/);
    if (!m) return s;
    return m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (m[3] || '');
  }

  /** 配列を平らにして数値だけを取り出す（集計関数用） */
  function numbersOf(args) {
    const out = [];
    args.forEach((a) => {
      if (Array.isArray(a)) {
        a.forEach((x) => { const n = U.toNumber(x); if (!isBlank(x) && Number.isFinite(n)) out.push(n); });
      } else if (!isBlank(a)) out.push(toNum(a));
    });
    return out;
  }

  /* ---------- 日付の書式 ---------- */
  /** yyyy / yy / mm / m / dd / d を置き換える。日付として読めなければ元の値 */
  function formatDate(v, pattern) {
    // 時刻（ミリ秒）・Date はそのまま、それ以外は日付の文字や Excel のシリアル値として読む
    const t = v instanceof Date ? v.getTime() : typeof v === 'number' && v > 1e10 ? v : U.toDateNum(v);
    if (!Number.isFinite(t)) return toStr(v);
    const d = new Date(t);
    const p2 = (x) => String(x).padStart(2, '0');
    const parts = { yyyy: d.getFullYear(), yy: p2(d.getFullYear() % 100), mm: p2(d.getMonth() + 1), m: d.getMonth() + 1, dd: p2(d.getDate()), d: d.getDate() };
    return String(pattern).replace(/yyyy|yy|mm|m|dd|d/gi, (k) => parts[k.toLowerCase()]);
  }

  /** TEXT 関数の数値書式（"0.000" / "#,##0.0" / "0%"） */
  function formatNumber(v, pattern) {
    const n = toNum(v);
    const pct = /%$/.test(pattern);
    const m = String(pattern).match(/\.([0#]+)/);
    const digits = m ? m[1].length : 0;
    let s = roundDec(pct ? n * 100 : n, digits, 'half_up');
    if (/,/.test(pattern)) s = withCommas(s);
    return s + (pct ? '%' : '');
  }

  /* ---------- 字句解析 ---------- */
  const OPS2 = ['<=', '>=', '<>'];
  const OPS1 = '+-*/^&=<>';

  function tokenize(src) {
    const out = [];
    const s = String(src || '').replace(/^\s*[=＝]/, ''); // 先頭の = は Excel の癖として許す
    let i = 0;
    while (i < s.length) {
      const raw = s[i];
      const ch = raw.normalize('NFKC'); // 全角の記号・数字も受け付ける
      if (/\s/.test(ch)) { i++; continue; }
      if (raw === '"' || raw === '“' || raw === '”' || raw === '＂') {
        let j = i + 1;
        let v = '';
        while (j < s.length) {
          if (/["“”＂]/.test(s[j])) {
            if (s[j + 1] === '"') { v += '"'; j += 2; continue; }
            break;
          }
          v += s[j++];
        }
        if (j >= s.length) fail('#構文', '文字列の " が閉じていません');
        out.push({ t: 'str', v });
        i = j + 1;
        continue;
      }
      if (ch === '[') {
        let k = i + 1;
        while (k < s.length && s[k] !== ']' && s[k] !== '］') k++;
        if (k >= s.length) fail('#構文', '列の参照の ] が閉じていません');
        out.push({ t: 'ref', v: s.slice(i + 1, k).trim() });
        i = k + 1;
        continue;
      }
      if (/[0-9.]/.test(ch)) {
        let j = i;
        while (j < s.length && /[0-9.]/.test(s[j].normalize('NFKC'))) j++;
        const text = s.slice(i, j).normalize('NFKC');
        if (!/^\d*\.?\d+$|^\d+\.$/.test(text)) fail('#構文', `数値「${text}」を読めません`);
        out.push({ t: 'num', v: Number(text) });
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9_.]/.test(s[j].normalize('NFKC'))) j++;
        out.push({ t: 'id', v: s.slice(i, j).normalize('NFKC').toUpperCase() });
        i = j;
        continue;
      }
      const two = (ch + (s[i + 1] || '').normalize('NFKC'));
      if (OPS2.includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
      if (OPS1.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
      if (ch === '(') { out.push({ t: '(' }); i++; continue; }
      if (ch === ')') { out.push({ t: ')' }); i++; continue; }
      if (ch === ',' || raw === '、') { out.push({ t: ',' }); i++; continue; }
      fail('#構文', `「${raw}」は式に使えません`);
    }
    return out;
  }

  /* ---------- 構文解析（優先順位：比較 < & < 加減 < 乗除 < 累乗 < 単項） ---------- */
  const PREC = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };

  function parse(src) {
    const toks = tokenize(src);
    let pos = 0;
    const peek = () => toks[pos];
    const take = () => toks[pos++];

    function primary() {
      const t = take();
      if (!t) fail('#構文', '式が途中で終わっています');
      if (t.t === 'num') return { t: 'num', v: t.v };
      if (t.t === 'str') return { t: 'str', v: t.v };
      if (t.t === 'ref') return { t: 'ref', name: t.v };
      if (t.t === 'op' && (t.v === '-' || t.v === '+')) {
        const x = binary(6);
        return t.v === '-' ? { t: 'neg', x } : x;
      }
      if (t.t === '(') {
        const x = binary(0);
        if (!peek() || take().t !== ')') fail('#構文', '「(」に対応する「)」がありません');
        return x;
      }
      if (t.t === 'id') {
        if (t.v === 'TRUE' || t.v === 'FALSE') return { t: 'bool', v: t.v === 'TRUE' };
        if (!peek() || peek().t !== '(') fail('#構文', `「${t.v}」の後に ( が必要です`);
        take();
        const args = [];
        if (peek() && peek().t === ')') { take(); return { t: 'call', name: t.v, args }; }
        for (;;) {
          args.push(binary(0));
          const n = take();
          if (!n) fail('#構文', `${t.v}( の ) が閉じていません`);
          if (n.t === ')') break;
          if (n.t !== ',') fail('#構文', `${t.v} の引数の区切りは , です`);
        }
        return { t: 'call', name: t.v, args };
      }
      fail('#構文', '式の書き方が正しくありません');
      return null;
    }

    function binary(minPrec) {
      let left = primary();
      for (;;) {
        const t = peek();
        if (!t || t.t !== 'op' || !(t.v in PREC) || PREC[t.v] < minPrec) break;
        take();
        // Excel と同じくすべて左結合（2^3^2 = 64）
        const right = binary(PREC[t.v] + 1);
        left = { t: 'bin', op: t.v, l: left, r: right };
      }
      return left;
    }

    if (!toks.length) return { t: 'str', v: '' };
    const ast = binary(0);
    if (pos < toks.length) fail('#構文', '式の終わりに余分な文字があります');
    return ast;
  }

  /* ---------- 関数の登録簿 ---------- */
  const FUNCS = {};
  /**
   * 関数を登録する
   * @param {string} name 関数名（大文字）
   * @param {{min:number, max?:number, desc:string, example:string, group:string, fn:Function, lazy?:boolean}} def
   *   lazy=true のときは fn(nodes, evalNode, ctx) に式のまま渡す（IF・IFERROR・ALL 用）
   */
  function register(name, def) {
    FUNCS[name.toUpperCase()] = Object.assign({ max: def.min }, def, { name: name.toUpperCase() });
  }

  /* ---------- 計算 ---------- */
  function evalNode(n, ctx) {
    switch (n.t) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'ref': return ctx.ref(n.name);
      case 'neg': return -toNum(evalNode(n.x, ctx));
      case 'bin': return evalBin(n.op, evalNode(n.l, ctx), evalNode(n.r, ctx));
      case 'call': {
        const f = FUNCS[n.name];
        if (!f) fail('#NAME?', `関数「${n.name}」はありません`);
        const max = f.max === Infinity ? Infinity : f.max;
        if (n.args.length < f.min || n.args.length > max) fail('#構文', `${n.name} の引数の数が違います（例：${f.example}）`);
        if (f.lazy) return f.fn(n.args, (x) => evalNode(x, ctx), ctx);
        return f.fn(n.args.map((a) => evalNode(a, ctx)), ctx);
      }
      default: fail('#構文', '式を計算できません');
    }
    return '';
  }

  function compare(a, b) {
    const na = typeof a === 'number' || (!isBlank(a) && Number.isFinite(U.toNumber(a)) && /^[-+]?[\d.,]+$/.test(U.normValue(a)));
    const nb = typeof b === 'number' || (!isBlank(b) && Number.isFinite(U.toNumber(b)) && /^[-+]?[\d.,]+$/.test(U.normValue(b)));
    if (na && nb) { const x = toNum(a); const y = toNum(b); return x === y ? 0 : x < y ? -1 : 1; }
    const x = U.normValue(toStr(a)).toUpperCase();
    const y = U.normValue(toStr(b)).toUpperCase();
    return x === y ? 0 : x < y ? -1 : 1;
  }

  /** 四則演算の結果から 2進数の誤差を除く（0.1+0.2 → 0.3） */
  const clean = (x) => (Number.isFinite(x) ? Number(x.toPrecision(15)) : x);

  function evalBin(op, a, b) {
    switch (op) {
      case '&': return toStr(a) + toStr(b);
      case '+': return clean(toNum(a) + toNum(b));
      case '-': return clean(toNum(a) - toNum(b));
      case '*': return clean(toNum(a) * toNum(b));
      case '/': { const d = toNum(b); if (d === 0) fail('#DIV/0!', '0 で割っています'); return clean(toNum(a) / d); }
      case '^': return Math.pow(toNum(a), toNum(b));
      case '=': return compare(a, b) === 0;
      case '<>': return compare(a, b) !== 0;
      case '<': return compare(a, b) < 0;
      case '>': return compare(a, b) > 0;
      case '<=': return compare(a, b) <= 0;
      case '>=': return compare(a, b) >= 0;
      default: fail('#構文', `演算子「${op}」は使えません`);
    }
    return '';
  }

  /* ---------- 公開 API ---------- */
  const cache = new Map();
  function compile(src) {
    const key = String(src || '');
    if (!cache.has(key)) {
      try { cache.set(key, { ast: parse(key) }); } catch (err) { cache.set(key, { error: err }); }
      if (cache.size > 500) cache.delete(cache.keys().next().value);
    }
    return cache.get(key);
  }

  /**
   * 式を計算する
   * @param {string} src
   * @param {{ref:(name:string)=>any, all:(name:string)=>any[]}} ctx
   * @returns {{value:any}|{error:{code:string, message:string}}}
   */
  function evaluate(src, ctx) {
    const c = compile(src);
    if (c.error) return { error: { code: c.error.code || '#構文', message: c.error.message } };
    try {
      const v = evalNode(c.ast, ctx);
      return { value: typeof v === 'number' && !Number.isFinite(v) ? fail('#NUM!', '計算結果が数値になりません') : v };
    } catch (err) {
      return { error: { code: err.code || '#ERR', message: err.message } };
    }
  }

  /** 式が参照する列名の一覧（構文エラーなら空） */
  function refs(src) {
    const c = compile(src);
    const out = [];
    const walk = (n) => {
      if (!n) return;
      if (n.t === 'ref') out.push(n.name.replace(/^\s*生\s*[:：]\s*/, ''));
      if (n.t === 'neg') walk(n.x);
      if (n.t === 'bin') { walk(n.l); walk(n.r); }
      if (n.t === 'call') n.args.forEach(walk);
    };
    if (c.ast) walk(c.ast);
    return Array.from(new Set(out));
  }

  /** 関数の一覧（取扱説明書・入力補助用） */
  const list = () => Object.keys(FUNCS).sort().map((k) => FUNCS[k]);

  /* ---------- 標準の関数 ---------- */
  const G_ROUND = '数値・丸め';
  const G_TEXT = '文字';
  const G_LOGIC = '条件';
  const G_AGG = '集計';

  register('FIXED', {
    group: G_ROUND, min: 1, max: 4, example: 'FIXED([板厚], 3)', desc: '小数第n位で四捨五入し、桁をそろえた文字にする（3つ目を TRUE にすると桁区切りなし。4つ目に規則 "A"（偶数丸め）・"B"（四捨五入）・"切上"・"切捨" を書くと、その規則で丸める）',
    fn: ([x, d, noComma, rule]) => {
      let mode = 'half_up';
      if (rule !== undefined && U.normValue(rule) !== '') { mode = ruleOf(rule); if (!mode) fail('#VALUE!', `丸めの規則「${rule}」を読めません（A・B・切上・切捨 が使えます）`); }
      const s = roundDec(toNum(x), d === undefined ? 2 : toNum(d), mode);
      return noComma !== undefined && toBool(noComma) ? s : withCommas(s);
    }
  });
  register('ROUND', { group: G_ROUND, min: 2, example: 'ROUND([幅], 1)', desc: '四捨五入', fn: ([x, d]) => Number(roundDec(toNum(x), toNum(d), 'half_up')) });
  register('ROUNDEVEN', { group: G_ROUND, min: 2, example: 'ROUNDEVEN([幅], 1)', desc: '規則 A（偶数丸め・銀行丸め）。ちょうど半分のときだけ、残す桁が偶数になる向きに丸める（例：0.25 → 0.2、0.35 → 0.4）', fn: ([x, d]) => Number(roundDec(toNum(x), toNum(d), 'half_even')) });
  register('ROUNDUP', { group: G_ROUND, min: 2, example: 'ROUNDUP([幅], 1)', desc: '切り上げ（0 から離れる向き）', fn: ([x, d]) => Number(roundDec(toNum(x), toNum(d), 'ceil')) });
  register('ROUNDDOWN', { group: G_ROUND, min: 2, example: 'ROUNDDOWN([公差], 1)', desc: '切り捨て（0 に近づく向き）', fn: ([x, d]) => Number(roundDec(toNum(x), toNum(d), 'floor')) });
  register('ABS', { group: G_ROUND, min: 1, example: 'ABS([公差(-)])', desc: '絶対値', fn: ([x]) => Math.abs(toNum(x)) });
  register('VALUE', { group: G_ROUND, min: 1, example: 'VALUE("1.5")', desc: '文字を数値にする', fn: ([x]) => toNum(x) });
  register('TEXT', {
    group: G_ROUND, min: 2, example: 'TEXT([製造日], "yyyy/mm/dd")', desc: '書式を付けた文字にする（日付：yyyy mm dd、数値："0.000" "#,##0"）',
    fn: ([v, f]) => (isBlank(v) ? '' : /[yd]/i.test(toStr(f)) ? formatDate(v, toStr(f)) : formatNumber(v, toStr(f)))
  });

  register('LEFT', { group: G_TEXT, min: 1, max: 2, example: 'LEFT([材質], 1)', desc: '左から n 文字', fn: ([s, n]) => toStr(s).slice(0, n === undefined ? 1 : toNum(n)) });
  register('RIGHT', { group: G_TEXT, min: 1, max: 2, example: 'RIGHT([ロット番号], 4)', desc: '右から n 文字', fn: ([s, n]) => { const k = n === undefined ? 1 : toNum(n); return k > 0 ? toStr(s).slice(-k) : ''; } });
  register('MID', { group: G_TEXT, min: 3, example: 'MID([検査番号], 3, 5)', desc: 'start 文字目から n 文字', fn: ([s, st, n]) => toStr(s).substr(Math.max(0, toNum(st) - 1), toNum(n)) });
  register('LEN', { group: G_TEXT, min: 1, example: 'LEN([備考])', desc: '文字数', fn: ([s]) => toStr(s).length });
  register('TRIM', { group: G_TEXT, min: 1, example: 'TRIM([客先])', desc: '前後の空白を除く', fn: ([s]) => toStr(s).trim() });
  register('UPPER', { group: G_TEXT, min: 1, example: 'UPPER([判定])', desc: '大文字にする', fn: ([s]) => toStr(s).toUpperCase() });
  register('LOWER', { group: G_TEXT, min: 1, example: 'LOWER([判定])', desc: '小文字にする', fn: ([s]) => toStr(s).toLowerCase() });
  register('SUBSTITUTE', { group: G_TEXT, min: 3, example: 'SUBSTITUTE([判定], "合格", "O.K.")', desc: '文字を置き換える', fn: ([s, a, b]) => toStr(s).split(toStr(a)).join(toStr(b)) });
  register('CONCAT', { group: G_TEXT, min: 1, max: Infinity, example: 'CONCAT([材質], "-", [質別])', desc: 'つなげる（& と同じ）', fn: (args) => args.map(toStr).join('') });
  /* ページ・1 枚の情報（ブロックの帳票の {ページ} {総ページ} などが、この関数に変わる） */
  const G_PAGE = 'ページ・枚数';
  register('PAGENO', { group: G_PAGE, min: 0, example: 'PAGENO()', desc: '今のページ番号（1 枚にまとめる単位ごとに 1 から数える）', fn: (a, ctx) => (ctx.page ? ctx.page.no : 1) });
  register('PAGECOUNT', { group: G_PAGE, min: 0, example: 'PAGECOUNT()', desc: '1 枚にまとめる単位の総ページ数', fn: (a, ctx) => (ctx.page ? ctx.page.count : 1) });
  // docMaker：ロットごとに使うので、板の枚数（板数・b/a・行板数）は取り込んでいない（PLATECOUNT・PLATEPAGE・ROWPLATES）
  register('ROWNO', { group: G_PAGE, min: 0, example: 'ROWNO()', desc: '板の表の中の行番号（表の外は空欄）', fn: (a, ctx) => (ctx.rowIndex >= 0 ? ctx.rowIndex + 1 : '') });
  register('LOTNAME', { group: G_PAGE, min: 0, example: 'LOTNAME()', desc: '1 枚にまとめる単位の名前（注文番号など）', fn: (a, ctx) => (ctx.lot ? ctx.lot.name : '') });
  /* 同じ表の別のセルの値（C3 や C3:C12 と書いた式を、ブロックの帳票が内部でこの形に直す） */
  register('ITEM', { group: G_PAGE, min: 1, example: 'ITEM("id")', desc: '（内部用）別のセルの値', fn: ([id], ctx) => (ctx.itemValue ? ctx.itemValue(toStr(id)) : fail('#REF!', 'セルの参照はブロックの表の中だけで使えます')) });
  register('ITEMS', { group: G_PAGE, min: 1, max: Infinity, example: 'ITEMS("id", "id")', desc: '（内部用）別のセルの値の並び（範囲）', fn: (ids, ctx) => (ctx.itemValue ? ids.map((id) => ctx.itemValue(toStr(id))) : fail('#REF!', 'セルの参照はブロックの表の中だけで使えます')) });
  register('TODAY', { group: G_TEXT, min: 0, example: 'TODAY()', desc: '今日の日付（yyyy/mm/dd）', fn: () => formatDate(Date.now(), 'yyyy/mm/dd') });

  register('IF', {
    group: G_LOGIC, min: 2, max: 3, lazy: true, example: 'IF([判定]="合格", "O.K.", "N.G.")', desc: '条件で切り替える',
    fn: ([c, a, b], ev) => (toBool(ev(c)) ? ev(a) : b === undefined ? false : ev(b))
  });
  register('IFERROR', {
    group: G_LOGIC, min: 2, lazy: true, example: 'IFERROR([幅]/[丈], "-")', desc: 'エラーのときに別の値にする',
    fn: ([x, alt], ev) => { try { return ev(x); } catch (err) { if (err instanceof FormulaError) return ev(alt); throw err; } }
  });
  register('ISBLANK', { group: G_LOGIC, min: 1, example: 'ISBLANK([備考])', desc: '空欄なら TRUE', fn: ([x]) => isBlank(x) });
  register('ISNUMBER', { group: G_LOGIC, min: 1, example: 'ISNUMBER([幅])', desc: '数値なら TRUE', fn: ([x]) => typeof x === 'number' || (!isBlank(x) && Number.isFinite(Number(U.normValue(x).replace(/,/g, '')))) });
  register('AND', { group: G_LOGIC, min: 1, max: Infinity, example: 'AND([幅]>0, [丈]>0)', desc: 'すべて TRUE なら TRUE', fn: (args) => args.every(toBool) });
  register('OR', { group: G_LOGIC, min: 1, max: Infinity, example: 'OR([判定]="NG", [外観]="NG")', desc: 'どれかが TRUE なら TRUE', fn: (args) => args.some(toBool) });
  register('NOT', { group: G_LOGIC, min: 1, example: 'NOT(ISBLANK([備考]))', desc: 'TRUE と FALSE を入れ替える', fn: ([x]) => !toBool(x) });

  register('ALL', {
    group: G_AGG, min: 1, lazy: true, example: 'MIN(ALL([板厚]))', desc: 'そのロットの全板の値（MIN・MAX・AVERAGE などと組み合わせる）',
    fn: ([x], ev, ctx) => {
      if (!x || x.t !== 'ref') fail('#構文', 'ALL の中には [列名] を書きます');
      return ctx.all(x.name);
    }
  });
  /**
   * 番号の並びを「2、4～11」のようにまとめる（連続する整数だけ。3 つ以上つながれば「～」、2 つなら「、」）
   * 整数でない値（A1・3-1 など）は、まとめずに後ろへ並べる。空欄・重複は除く。ゼロ埋め（01）は数として見る（出力は 1）
   */
  function rangesText(values, sep, dash) {
    const comma = sep === undefined || sep === null ? '、' : String(sep);
    const tilde = dash === undefined || dash === null ? '～' : String(dash);
    const flat = [].concat(...[].concat(values).map((v) => (Array.isArray(v) ? v : [v])));
    const nums = new Set();
    const others = [];
    flat.forEach((v) => {
      const s = U.normValue(v);
      if (s === '') return;
      if (/^\d+$/.test(s) && Number.isSafeInteger(Number(s))) nums.add(Number(s));
      else if (!others.includes(s)) others.push(s);
    });
    const sorted = Array.from(nums).sort((a, b) => a - b);
    const parts = [];
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
      if (j - i >= 2) parts.push(`${sorted[i]}${tilde}${sorted[j]}`);
      else for (let k = i; k <= j; k++) parts.push(String(sorted[k]));
      i = j + 1;
    }
    others.sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
    return parts.concat(others).join(comma);
  }
  register('RANGES', {
    group: G_AGG, min: 1, max: 3, example: 'RANGES(ALL([板番号]))', desc: '番号を連続部まとめで並べる（例：2、4～11）。整数だけが対象で、整数以外はそのまま後ろに並べる。2 つ目・3 つ目の引数で区切り（既定「、」）と連続部の記号（既定「～」）を変えられる',
    fn: ([list, sep, dash]) => rangesText(list, sep, dash)
  });
  // docMaker：RANGESBY（検査番号ごとに分けた連続まとめ）は CDB の特別な機能なので取り込んでいない。RANGES（汎用）は残す
  const agg = (name, desc, f) => register(name, {
    group: G_AGG, min: 1, max: Infinity, example: `${name}(ALL([幅]))`, desc,
    fn: (args) => { const ns = numbersOf(args); return f(ns); }
  });
  agg('SUM', '合計', (ns) => ns.reduce((a, b) => a + b, 0));
  agg('MIN', '最小', (ns) => (ns.length ? Math.min.apply(null, ns) : ''));
  agg('MAX', '最大', (ns) => (ns.length ? Math.max.apply(null, ns) : ''));
  agg('AVERAGE', '平均', (ns) => (ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : fail('#DIV/0!', '平均する値がありません')));
  agg('COUNT', '数値の個数', (ns) => ns.length);

  CDB.formula = {
    ruleOf, RULE_CODE, rawRefs, rangesText,
    FormulaError, register, evaluate, refs, list, compile,
    numToStr, toStr, toNum, isBlank, roundDec, withCommas, formatDate
  };
})();
