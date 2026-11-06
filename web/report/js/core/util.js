/* =========================================================
   js/core/util.js : 共通ユーティリティ（DOM生成・書式・正規化・イベント・フォーム遷移）
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});

  /* ---------- DOM ---------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /**
   * 要素生成。attrs の on* はイベント、class/text/html/style/dataset は特別扱い。
   */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    const a = attrs || {};
    Object.keys(a).forEach((k) => {
      const v = a[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    });
    [].concat(children || []).forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return node;
  }

  /** Font Awesome アイコン */
  function icon(name, extra) {
    const style = name.startsWith('fa-regular') ? '' : 'fa-solid ';
    return el('i', { class: style + name + (extra ? ' ' + extra : ''), 'aria-hidden': 'true' });
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- 書式 ---------- */
  const nf = new Intl.NumberFormat('ja-JP');
  const fmt = (n) => nf.format(n || 0);
  function fmtDateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ---------- 正規化 ---------- */
  /** 値の表記正規化：全角→半角(NFKC)・前後空白除去 */
  function normValue(v) {
    if (v === undefined || v === null) return '';
    return String(v).normalize('NFKC').trim();
  }
  /** キーの正規化：NFKC・空白除去・大文字化・数値先頭ゼロ除去 */
  function normKey(v) {
    const s = normValue(v).replace(/\s+/g, '').toUpperCase();
    return s.replace(/^0+(?=\d)/, '');
  }
  /** 数値化（カンマ・単位混じりにも一定対応） */
  function toNumber(v) {
    const s = normValue(v).replace(/,/g, '');
    if (s === '') return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : parseFloat(s);
  }
  /** 日付化（yyyy/mm/dd, yyyy-mm-dd, Excelシリアル） */
  function toDateNum(v) {
    const s = normValue(v);
    if (s === '') return NaN;
    if (/^\d{5}(\.\d+)?$/.test(s)) return Math.round((Number(s) - 25569) * 86400000);
    const t = Date.parse(s.replace(/\./g, '/').replace(/-/g, '/'));
    return Number.isFinite(t) ? t : NaN;
  }

  /** 日付を yyyy/mm/dd に正規化（時刻・「～」などの後続は捨てる）。解釈できなければ元の値 */
  function normDate(v) {
    const s = normValue(v);
    const m = s.match(/^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})/);
    const p = (x) => String(x).padStart(2, '0');
    if (m) return `${m[1]}/${p(m[2])}/${p(m[3])}`;
    if (/^\d{5}(\.\d+)?$/.test(s)) {
      const d = new Date(Math.round((Number(s) - 25569) * 86400000));
      return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
    }
    return s;
  }

  /** 列番号(0始まり) → Excel の列記号（A, B, …, AA） */
  function colLetter(i) {
    let s = '';
    let n = i + 1;
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  /** セル番地（A1形式） */
  function cellAddr(r, c) {
    return colLetter(c) + (r + 1);
  }

  /* ---------- 汎用 ---------- */
  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function debounce(fn, ms) {
    let t = 0;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }
  /** 見出し集合の一致率（Jaccard） */
  function similarity(a, b) {
    const A = new Set(a.map(normKey).filter(Boolean));
    const B = new Set(b.map(normKey).filter(Boolean));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    A.forEach((x) => { if (B.has(x)) inter++; });
    return inter / (A.size + B.size - inter);
  }

  /* ---------- イベントバス ---------- */
  const handlers = {};
  const bus = {
    on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); },
    off(name, fn) { handlers[name] = (handlers[name] || []).filter((h) => h !== fn); },
    emit(name, payload) { (handlers[name] || []).slice().forEach((fn) => fn(payload)); }
  };

  /* ---------- フォーム遷移 ---------- */
  /**
   * コンテナ内の入力で、フォーカス時に全選択、Enter で次の入力へ移動する。
   * data-maxlen を持つ入力は、その文字数に達したら自動で次へ移動する。
   */
  function enableFormNav(container) {
    const selector = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not(:disabled), select:not(:disabled)';
    container.addEventListener('focusin', (e) => {
      const t = e.target;
      if (t.matches && t.matches('input[type=text], input[type=number], input:not([type])')) {
        setTimeout(() => { try { t.select(); } catch (_) { /* noop */ } }, 0);
      }
    });
    const next = (from) => {
      const list = $$(selector, container).filter((n) => n.offsetParent !== null);
      const i = list.indexOf(from);
      if (i >= 0 && list[i + 1]) list[i + 1].focus();
    };
    container.addEventListener('keydown', (e) => {
      const t = e.target;
      if (e.key !== 'Enter' || e.isComposing) return;
      if (!t.matches || !t.matches(selector)) return;
      if (t.dataset.enter === 'submit') return;
      e.preventDefault();
      t.dispatchEvent(new Event('change', { bubbles: true }));
      next(t);
    });
    container.addEventListener('input', (e) => {
      const t = e.target;
      const max = Number(t.dataset && t.dataset.maxlen);
      if (max && String(t.value).length >= max) next(t);
    });
  }

  /** 保存反映の視覚フィードバック */
  function flash(node) {
    if (!node) return;
    node.classList.remove('is-saved');
    void node.offsetWidth;
    node.classList.add('is-saved');
  }

  /** CSV/TSVセル用に文字列化 */
  function cellText(v) {
    return v === undefined || v === null ? '' : String(v);
  }

  CDB.util = {
    $, $$, el, icon, esc, fmt, fmtDateTime,
    normValue, normKey, toNumber, toDateNum, normDate, colLetter, cellAddr,
    uid, debounce, similarity, enableFormNav, flash, cellText
  };
  CDB.bus = bus;
})();
