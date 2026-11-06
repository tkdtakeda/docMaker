/* =========================================================
   web/report/js/adapter.js : CDB の帳票部品を docMaker で動かすための「つなぎ役」
   CDB の帳票部品（web/report/js/report・ui）は、CDB のコードをなるべくそのまま使う（CDB 側の直しを取り込み直しやすくするため）。
   CDB にあって docMaker に無いものは、ここで置き換える：
   ・CDB.db        … 帳票プリセット（reports）とひな形（templates）の保存先を、ブラウザ内（IndexedDB）からサーバー（共有フォルダ）へ
                     ひな形の Excel（ArrayBuffer）は base64 にして送る
   ・CDB.judge     … 丸め（規則A・B・切り上げ・切り捨て）だけを CDB の judge.js から写した
   ・CDB.reportRules / CDB.issued / UI.reportRules … 作成済・使い切り・NG を載せない、は取り込んでいない（何もしない形）
   ・UI.sample     … 「サンプルで試す」は docMaker のサンプル帳票（samples.js）を入れる
   ・UI.history    … 実行の履歴は docMaker には無い
   util.js の後、帳票部品の前に読み込む。
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const STORES = ['reports', 'templates'];
  const API = 'api/reports/';

  /* ---------- 保存（サーバー） ---------- */
  const toB64 = (buf) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const fromB64 = (s) => { const bin = atob(s); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b.buffer; };
  /** 送る形：ArrayBuffer・型付き配列は { __b64 } に（入れ子も） */
  function pack(v) {
    if (v instanceof ArrayBuffer) return { __b64: toB64(v) };
    if (ArrayBuffer.isView(v)) return { __b64: toB64(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) };
    if (Array.isArray(v)) return v.map(pack);
    if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach((k) => { o[k] = pack(v[k]); }); return o; }
    return v;
  }
  function unpack(v) {
    if (Array.isArray(v)) return v.map(unpack);
    if (v && typeof v === 'object') {
      if (typeof v.__b64 === 'string' && Object.keys(v).length === 1) return fromB64(v.__b64);
      const o = {}; Object.keys(v).forEach((k) => { o[k] = unpack(v[k]); }); return o;
    }
    return v;
  }
  const check = (store) => { if (!STORES.includes(store)) throw new Error(`docMaker では「${store}」は保存しません`); };
  async function call(url, opt) {
    let r;
    try { r = await fetch(url, opt); } catch (e) { throw new Error('サーバーに届きません。Start.bat が動いているか確かめてください'); }
    let body = null;
    try { body = await r.json(); } catch (_) { /* JSON でない */ }
    if (!r.ok) throw new Error((body && body.error) || `保存先の応答が正しくありません（${r.status}）`);
    return body;
  }
  CDB.db = {
    STORES,
    async getAll(store) { check(store); return unpack((await call(API + store)).items || []); },
    async get(store, id) { check(store); if (!id) return null; try { return unpack((await call(API + store + '/' + encodeURIComponent(id))).item); } catch (e) { if (/見つかりません/.test(e.message)) return null; throw e; } },
    async put(store, rec) { check(store); await call(API + store + '/' + encodeURIComponent(rec.id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pack(rec)) }); return rec.id; },
    async deleteMany(store, ids) { check(store); await call(API + store + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }); },
    async putMany(store, recs) { for (const r of recs) await this.put(store, r); }
  };

  /* ---------- 丸め（CDB js/domain/judge.js の round と同じ） ---------- */
  function parseDecimal(v) {
    const s = U.normValue(v).replace(/,/g, '');
    const m = s.match(/^([+-])?(\d*)(?:\.(\d*))?$/);
    if (!m || (!m[2] && !m[3])) return null;
    return { neg: m[1] === '-', int: (m[2] || '0').replace(/^0+(?=\d)/, ''), frac: m[3] || '' };
  }
  function round(v, mode, digits) {
    const d = parseDecimal(v);
    if (!d || !mode) return U.normValue(v);
    const n = Math.max(0, digits | 0);
    const frac = d.frac.padEnd(n, '0');
    const kept = d.int + frac.slice(0, n);
    const rest = frac.slice(n);
    const restNonZero = /[1-9]/.test(rest);
    let inc = false;
    if (mode === 'half_up') inc = rest[0] >= '5';
    else if (mode === 'ceil') inc = restNonZero;
    else if (mode === 'half_even') {
      if (rest[0] > '5') inc = true;
      else if (rest[0] === '5') inc = /[1-9]/.test(rest.slice(1)) || Number(kept[kept.length - 1]) % 2 === 1;
    }
    const digitsStr = (BigInt(kept) + (inc ? 1n : 0n)).toString().padStart(n + 1, '0');
    const intPart = digitsStr.slice(0, digitsStr.length - n) || '0';
    const fracPart = n ? '.' + digitsStr.slice(digitsStr.length - n) : '';
    const zero = /^0*$/.test(intPart + fracPart.slice(1));
    return (d.neg && !zero ? '-' : '') + intPart + fracPart;
  }
  CDB.judge = { round, parseDecimal };

  /* ---------- 取り込んでいない仕組み（何もしない形） ---------- */
  CDB.reportRules = { apply: (lots) => ({ lots, excluded: 0, skippedDone: 0, plates: 0, perGroup: [] }), effective: () => ({}), recordOf: () => ({}) };
  CDB.issued = { list: async () => [], activeMap: () => new Map() };
  CDB.ui = CDB.ui || {};
  CDB.ui.reportRules = { create: () => ({ render() {} }) };
  CDB.ui.history = { open: () => CDB.ui.toast({ type: 'info', text: '実行の履歴は、docMaker では残していません（出力した結果は、この画面の下に出ます）' }) };
  CDB.ui.sample = { open: () => CDB.docSamples && CDB.docSamples.install() };
})();
