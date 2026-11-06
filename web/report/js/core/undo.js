/* =========================================================
   js/core/undo.js : 取り消し・やり直しの記録（画面に依らない部品）
   変更のたびに「設定の写し」を比べ、違えば 1 段として積む。
   どの操作で変わったかを問わないので、セルのクリック・列の設定・照合先などを同じ仕組みで戻せる。
   使い方：
     const u = CDB.undo.create({ snapshot, restore, describe });
     変更を描き終えたら u.observe()（違いがあれば 1 段積む）
     u.undo() / u.redo() / u.resetToFirst()（最初に記録した状態へ。これも取り消せる）
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});

  const MAX = 100; // これより古い段は捨てる

  /**
   * @param {{snapshot:()=>object, restore:(s:object)=>void, describe?:(before:object, after:object)=>string}} o
   *   snapshot … 今の設定の写し（JSON にできるもの）／ restore … 写しを画面に戻す／ describe … 何が変わったかの短い文
   */
  function create(o) {
    const describe = o.describe || (() => '変更');
    let base = null;   // 今の状態として記録済みのもの { j: JSON, s: 写し }
    let first = null;  // 最初に記録した状態（自動で判定した状態）
    const undos = [];  // { from, to, label }
    const redos = [];
    let restoring = false;

    const take = () => {
      const j = JSON.stringify(o.snapshot());
      return { j, s: JSON.parse(j) };
    };
    const put = (rec) => {
      restoring = true;
      try { o.restore(JSON.parse(rec.j)); } finally { restoring = false; }
      base = rec;
    };

    return {
      /** 記録を消す（別のデータを入れたとき） */
      reset() {
        base = null;
        first = null;
        undos.length = 0;
        redos.length = 0;
      },
      /**
       * 今の状態を見て、前と違えば 1 段積む
       * @returns {boolean} 積んだか
       */
      observe() {
        if (restoring) return false;
        const now = take();
        if (!base) { base = now; first = first || now; return false; }
        if (now.j === base.j) return false;
        undos.push({ from: base, to: now, label: describe(base.s, now.s) });
        if (undos.length > MAX) undos.shift();
        redos.length = 0;
        base = now;
        return true;
      },
      canUndo: () => undos.length > 0,
      canRedo: () => redos.length > 0,
      canReset: () => !!first && !!base && first.j !== base.j,
      undoLabel: () => (undos.length ? undos[undos.length - 1].label : ''),
      redoLabel: () => (redos.length ? redos[redos.length - 1].label : ''),
      /** @returns {string} 取り消した変更の説明（なければ空） */
      undo() {
        const e = undos.pop();
        if (!e) return '';
        redos.push(e);
        put(e.from);
        return e.label;
      },
      /** @returns {string} やり直した変更の説明（なければ空） */
      redo() {
        const e = redos.pop();
        if (!e) return '';
        undos.push(e);
        put(e.to);
        return e.label;
      },
      /** 最初に記録した状態へ戻す（1 段として積むので、これも取り消せる） */
      resetToFirst(label) {
        if (!this.canReset()) return '';
        const e = { from: base, to: first, label: label || '最初の状態に戻す' };
        undos.push(e);
        redos.length = 0;
        put(first);
        return e.label;
      }
    };
  }

  CDB.undo = { create };
})();
