/* =========================================================
   js/ui/block-state.js : ブロックの帳票の編集の状態（選択・取り消し・操作）
   画面（block-canvas.js・block-bar.js・block-side.js）はここの操作を呼ぶだけ。変更は exec を通す：
     控えを取る → 変える → セル型へ変換（preset.doc などを作り直す）→ 通知。取り消し・やり直しは控えで戻す
   選択は常に 1 つ：none ／ cell（表のセルの範囲） ／ table ／ band
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const UI = CDB.ui;
  const BD = () => CDB.blockDoc;
  const SD = () => CDB.sheetDoc;

  const HISTORY_MAX = 100;

  /**
   * @param {{getPreset:()=>object, changed:(what:string)=>void}} api
   */
  function create(api) {
    const P = () => api.getPreset();
    const B = () => P().blocks;
    const undoStack = [];
    const redoStack = [];
    const listeners = [];
    const notify = () => listeners.forEach((fn) => fn());

    /** 選択（常に 1 種類）。cell のときは range（r0〜r1・c0〜c1）と anchor（範囲を作り始めたセル） */
    let sel = { kind: 'none' };
    const snap = () => JSON.stringify(P().blocks);

    /* ---------- 参照 ---------- */
    const tableSel = () => (sel.tableId ? BD().findTable(B(), sel.tableId) : null);
    const table = () => { const f = tableSel(); return f ? f.table : null; };
    const bandSel = () => (sel.bandId ? BD().findBand(B(), sel.bandId) : null);
    /** 選んだ表の区画の幅（mm） */
    function zoneMm(tableId) {
      const f = BD().findTable(B(), tableId || sel.tableId);
      if (!f) return 0;
      if (f.float) return f.float.w;
      return BD().zoneWidthsMm(B().page, f.band)[f.band.zones.indexOf(f.zone)];
    }
    const range = () => ({ r0: sel.r0, c0: sel.c0, r1: sel.r1, c1: sel.c1 });

    /* ---------- 選択 ---------- */
    function fix() {
      if (!P() || !P().blocks) { sel = { kind: 'none' }; return; } // ブロックの帳票でない（旧形式・ひな形の帳票）
      if (sel.kind === 'cell' || sel.kind === 'table') {
        const t = table();
        if (!t) { sel = { kind: 'none' }; return; }
        if (sel.kind === 'cell') {
          sel.r0 = Math.max(0, Math.min(sel.r0, t.nRows - 1)); sel.r1 = Math.max(0, Math.min(sel.r1, t.nRows - 1));
          sel.c0 = Math.max(0, Math.min(sel.c0, t.nCols - 1)); sel.c1 = Math.max(0, Math.min(sel.c1, t.nCols - 1));
          sel.ar = Math.min(sel.ar, t.nRows - 1); sel.ac = Math.min(sel.ac, t.nCols - 1);
        }
      } else if (sel.kind === 'band' && !bandSel()) sel = { kind: 'none' };
      else if (sel.kind === 'float' && !BD().findFloat(B(), sel.floatId)) sel = { kind: 'none' };
    }

    /** 結合セルは丸ごと選ぶ */
    function expand(t, rg) {
      const out = SD().norm(rg);
      let moved = true;
      while (moved) {
        moved = false;
        t.merges.forEach((m) => {
          if (SD().hit(m, out) && (m.r0 < out.r0 || m.r1 > out.r1 || m.c0 < out.c0 || m.c1 > out.c1)) {
            out.r0 = Math.min(out.r0, m.r0); out.r1 = Math.max(out.r1, m.r1); out.c0 = Math.min(out.c0, m.c0); out.c1 = Math.max(out.c1, m.c1); moved = true;
          }
        });
      }
      return out;
    }

    /** セルを選ぶ（extend：アンカーからの範囲にする） */
    function selectCell(tableId, r, c, extend) {
      const f = BD().findTable(B(), tableId);
      if (!f) return;
      const t = f.table;
      const same = sel.kind === 'cell' && sel.tableId === tableId;
      const ar = extend && same ? sel.ar : r;
      const ac = extend && same ? sel.ac : c;
      const e = expand(t, { r0: ar, c0: ac, r1: r, c1: c });
      sel = Object.assign({ kind: 'cell', tableId, ar, ac }, e);
      if (!extend || !same) { sel.ar = e.r0; sel.ac = e.c0; }
      notify();
    }
    function selectTable(tableId) { sel = { kind: 'table', tableId }; notify(); }
    function selectBand(bandId) { sel = { kind: 'band', bandId }; notify(); }
    function selectFloat(floatId) { sel = { kind: 'float', floatId }; notify(); }
    /** 今選んでいる自由に置く物（物そのもの、または中の表のセルを選んでいるとき） */
    function floatSel() {
      if (sel.kind === 'float') return BD().findFloat(B(), sel.floatId);
      if ((sel.kind === 'cell' || sel.kind === 'table') && sel.tableId) { const f = BD().findTable(B(), sel.tableId); return f && f.float ? f.float : null; }
      return null;
    }
    function clearSel() { sel = { kind: 'none' }; notify(); }

    /** 矢印キーで選びを動かす */
    function move(dr, dc, extend) {
      if (sel.kind !== 'cell') return;
      const t = table();
      const end = extend ? { r: sel.r0 === sel.ar ? sel.r1 : sel.r0, c: sel.c0 === sel.ac ? sel.c1 : sel.c0 } : { r: sel.ar, c: sel.ac };
      const r = Math.max(0, Math.min(t.nRows - 1, end.r + dr));
      const c = Math.max(0, Math.min(t.nCols - 1, end.c + dc));
      selectCell(sel.tableId, r, c, extend);
    }

    /* ---------- 変更（控えを取って、変えて、変換して、知らせる） ---------- */
    function commit(before, label) {
      undoStack.push(before);
      if (undoStack.length > HISTORY_MAX) undoStack.shift();
      redoStack.length = 0;
      CDB.blockCompile.apply(P());
      fix();
      api.changed('layout', label);
      notify();
    }

    function exec(label, fn) {
      const before = snap();
      let res;
      try { res = fn(B()); } catch (err) {
        P().blocks = JSON.parse(before);
        UI.toast({ type: 'warn', text: err.message });
        return null;
      }
      if (snap() === before) return res;
      commit(before, label);
      return res;
    }

    /** ドラッグ中の変更：画面だけ先に動かし、離したときに 1 回の変更として控えを取る */
    const beginLive = () => snap();
    function endLive(before, label) { if (snap() !== before) commit(before, label); else notify(); }

    function restore(s) {
      P().blocks = JSON.parse(s);
      CDB.blockCompile.apply(P());
      fix();
      api.changed('layout');
      notify();
    }
    function undo() { if (!undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()); }
    function redo() { if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); }

    const st_addr = () => (sel.r0 === sel.r1 && sel.c0 === sel.c1 ? U.cellAddr(sel.r0, sel.c0) : `${U.cellAddr(sel.r0, sel.c0)}:${U.cellAddr(sel.r1, sel.c1)}`);
    /* ---------- 操作：セル ---------- */
    /** 削除した行・列を参照していた式があれば知らせる（その参照は空にしてある） */
    const warnLost = (n) => { if (n) UI.toast({ type: 'warn', text: `削除した行・列を使っていた式の参照 ${n} 件を、空にしました。式を確かめてください`, duration: 9000 }); };
    const withT = (fn) => (...a) => { const t = table(); if (!t) return null; return fn(t, ...a); };
    const rows = (t) => ({ n: sel.r1 - sel.r0 + 1, at: sel.r0, t });
    /* ---------- コピー・貼り付け（セル）と、内容に合わせた列幅 ---------- */
    let clip = null; // { data, tsv }
    const tsvOf = (t, rg) => { const a = SD().norm(rg); const lines = []; for (let r = a.r0; r <= a.r1; r++) { const row = []; for (let c = a.c0; c <= a.c1; c++) { const cell = t.cells[BD().key(r, c)]; row.push(cell && cell.t !== undefined ? String(cell.t).replace(/[\t\r\n]+/g, ' ') : ''); } lines.push(row.join('\t')); } return lines.join('\n'); };
    let mctx = null;
    const textPx = (s0, text) => {
      mctx = mctx || document.createElement('canvas').getContext('2d');
      mctx.font = `${s0.i ? 'italic ' : ''}${s0.b ? 'bold ' : ''}${(s0.sz || SD().DEFAULT_SIZE) * 96 / 72}px '${s0.f || SD().DEFAULT_FONT}', sans-serif`;
      return Math.max(0, ...String(text).split('\n').map((l) => mctx.measureText(l).width));
    };
    /** 文字の幅を測って、必要な列幅（px）にする。結合で複数の列にまたがるセルは測らない */
    function neededPx(t, c) {
      let w = 0;
      for (let r = 0; r < t.nRows; r++) {
        const cell = t.cells[BD().key(r, c)];
        if (!cell || cell.t === undefined || cell.t === '') continue;
        const m = t.merges.find((x) => r >= x.r0 && r <= x.r1 && c >= x.c0 && c <= x.c1);
        if (m && m.c1 > m.c0) continue;
        const s0 = cell.s || {};
        w = Math.max(w, textPx(s0, cell.t) + 12 + ((s0.ind || 0) * 3 + (s0.pl || 0) + (s0.pr || 0)) * CDB.sheetPages.PX_PER_MM);
      }
      return Math.max(24, Math.ceil(w));
    }

    /** 削除したあとの通知（そこから取り消せる） */
    const undoToast = (text) => UI.toast({ type: 'ok', text, undo: () => undo(), duration: 8000 });

    const ops = {
      /** 選んだ範囲をコピー（cut なら中身を消す）。アプリ内では書式ごと、システムのクリップボードには文字（タブ区切り）で渡す */
      copy: (cut) => {
        const t = table();
        if (!t || sel.kind !== 'cell') return;
        clip = { data: BD().copyRange(t, range()), tsv: tsvOf(t, range()) };
        try { navigator.clipboard.writeText(clip.tsv).catch(() => {}); } catch (_) { /* 使えない環境では、アプリの中だけで貼り付ける */ }
        if (cut) ops.clearText();
        else UI.toast({ type: 'ok', text: `${st_addr()} をコピーしました（Ctrl+V で貼り付け）`, duration: 2500 });
      },
      /** 貼り付け：アプリ内でコピーしたものは書式ごと（式の参照はずらす）、外から来た文字（Excel など）はタブ区切りの値として */
      paste: (text) => exec('貼り付け', () => {
        const t = table();
        if (!t || sel.kind !== 'cell') return;
        const norm = (x) => String(x || '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
        let res;
        if (clip && (!text || norm(text) === clip.tsv)) {
          res = BD().pasteRange(t, sel.r0, sel.c0, clip.data, (src, dr, dc) => CDB.blockCompile.mapRefs(src, (a, b) => {
            const mv = (p) => ({ r: Math.max(0, p.r + dr), c: Math.max(0, p.c + dc) });
            const lab = (p) => U.colLetter(p.c) + (p.r + 1);
            return b ? `${lab(mv(a))}:${lab(mv(b))}` : lab(mv(a));
          }));
        } else if (text) { // 外から来た文字：値だけ貼る（書式・結合は変えない。結合の中と空の欄は飛ばす）
          const rows = norm(text).split('\n').map((l) => l.split('\t'));
          res = BD().pasteValues(t, sel.r0, sel.c0, rows);
          if (res.skipped) UI.toast({ type: 'info', text: `結合セルの中の ${res.skipped} 欄は、飛ばして貼りました`, duration: 5000 });
        } else return;
        if (res.cut) UI.toast({ type: 'info', text: '表の端を超える分は貼り付けませんでした。行・列を足してから貼ってください', duration: 6000 });
        sel.r1 = Math.min(t.nRows - 1, sel.r0 + res.rows - 1); sel.c1 = Math.min(t.nCols - 1, sel.c0 + res.cols - 1);
      }),
      fitCols: () => exec('列幅を内容に合わせる', () => {
        const t = table();
        const cols = [];
        const a = sel.kind === 'cell' ? sel.c0 : 0;
        const b = sel.kind === 'cell' ? sel.c1 : t.nCols - 1;
        for (let c = a; c <= b; c++) cols.push(c);
        BD().fitCols(t, cols, cols.map((c) => neededPx(t, c)), zoneMm() * CDB.sheetPages.PX_PER_MM);
      }),
      duplicateBand: (id) => exec('帯を複製', () => { const c = BD().duplicateBand(B(), id); if (c) sel = { kind: 'band', bandId: c.id }; }),
      setStyle: (patch) => exec('書式', () => { const t = table(); if (t) SD().setStyle(BD().L(t), range(), patch); }),
      /** インデントを 1 段ずつ増減（左のインデント。Ctrl+] / Ctrl+[）。0〜10 段 */
      indent: (delta) => { const t = table(); const cur = ((t.cells[BD().key(sel.ar, sel.ac)] || {}).s || {}).ind || 0; return ops.setStyle({ ind: Math.max(0, Math.min(10, cur + delta)) || false }); },
      setBorder: (mode, spec) => exec('罫線', () => { const t = table(); if (t) SD().setBorder(BD().L(t), range(), mode, spec); }),
      merge: () => exec('結合', () => {
        const t = table();
        SD().merge(BD().L(t), range());
        for (let r = sel.r0; r <= sel.r1; r++) for (let c = sel.c0; c <= sel.c1; c++) if (r !== sel.r0 || c !== sel.c0) BD().setText(t, r, c, ''); // 左上以外の中身は消える
      }),
      unmerge: () => exec('結合を解除', () => { const t = table(); if (t) SD().unmerge(BD().L(t), range()); }),
      insertRowsAbove: () => exec('行を挿入', () => { const t = table(); const n = sel.r1 - sel.r0 + 1; SD().insertRows(BD().L(t), sel.r0, n); CDB.blockCompile.shiftRefs(t, 'row', sel.r0, n, false); sel.r1 = sel.r0 + n - 1; sel.ar = sel.r0; }),
      insertRowsBelow: () => exec('行を挿入', () => { const t = table(); const n = sel.r1 - sel.r0 + 1; SD().insertRows(BD().L(t), sel.r1 + 1, n); CDB.blockCompile.shiftRefs(t, 'row', sel.r1 + 1, n, false); sel.r0 = sel.r1 + 1; sel.r1 = sel.r0 + n - 1; sel.ar = sel.r0; }),
      deleteRows: () => exec('行を削除', () => { const t = table(); SD().deleteRows(BD().L(t), sel.r0, sel.r1); warnLost(CDB.blockCompile.shiftRefs(t, 'row', sel.r0, sel.r1 - sel.r0 + 1, true)); }),
      insertColsLeft: () => exec('列を挿入', () => { const t = table(); const n = sel.c1 - sel.c0 + 1; BD().insertCols(t, sel.c0, n); CDB.blockCompile.shiftRefs(t, 'col', sel.c0, n, false); sel.c1 = sel.c0 + n - 1; sel.ac = sel.c0; }),
      insertColsRight: () => exec('列を挿入', () => { const t = table(); const n = sel.c1 - sel.c0 + 1; BD().insertCols(t, sel.c1 + 1, n); CDB.blockCompile.shiftRefs(t, 'col', sel.c1 + 1, n, false); sel.c0 = sel.c1 + 1; sel.c1 = sel.c0 + n - 1; sel.ac = sel.c0; }),
      deleteCols: () => exec('列を削除', () => { const t = table(); BD().deleteCols(t, sel.c0, sel.c1); warnLost(CDB.blockCompile.shiftRefs(t, 'col', sel.c0, sel.c1 - sel.c0 + 1, true)); }),
      setText: (tableId, r, c, text) => exec('入力', () => { const f = BD().findTable(B(), tableId); if (f) { BD().setText(f.table, r, c, text); BD().fitMultiline(f.table, r, c); } }), // 改行があれば、折り返しをオンにして行の高さを広げる
      clearText: () => exec('中身を消す', () => { const t = table(); for (let r = sel.r0; r <= sel.r1; r++) for (let c = sel.c0; c <= sel.c1; c++) BD().setText(t, r, c, ''); }),
      /** 選んだセルの値の設定（空欄のとき・前後の文字・書式など。cell.x に持ち、変換で項目に反映する） */
      setCellExtra: (patch) => exec('セルの設定', () => {
        const t = table();
        const k = BD().key(sel.ar, sel.ac);
        const cell = t.cells[k] || (t.cells[k] = { s: {} });
        const x = Object.assign({}, cell.x || {});
        Object.keys(patch).forEach((key) => { const v = patch[key]; if (v === '' || v === undefined || v === null || (Array.isArray(v) && !v.length)) delete x[key]; else x[key] = v; });
        if (Object.keys(x).length) cell.x = x; else delete cell.x;
      }),
      /** 列幅・行の高さ（mm） */
      setColWidthMm: (mm) => exec('列幅', () => { const t = table(); BD().setColMm(t, sel.c0, mm, zoneMm()); }),
      setRowHeightMm: (mm) => exec('行の高さ', () => { const t = table(); const px = mm * CDB.sheetPages.PX_PER_MM; for (let r = sel.r0; r <= sel.r1; r++) BD().setRowHeight(t, r, px); }),
      equalizeCols: () => exec('列幅をそろえる', () => { const t = table(); if (sel.kind === 'cell' && sel.c1 > sel.c0) BD().equalizeCols(t, sel.c0, sel.c1); else BD().equalizeAllCols(t); }),
      equalizeRows: () => exec('高さをそろえる', () => { const t = table(); if (sel.kind === 'cell' && sel.r1 > sel.r0) BD().equalizeRows(t, sel.r0, sel.r1); else BD().equalizeRows(t, 0, t.nRows - 1); }),
      sameWidthAsFirst: () => exec('列幅をそろえる', () => { const t = table(); BD().sameAsFirstCols(t, sel.c0, sel.c1); }),
      setRep: () => exec('板の表の行', () => { BD().setRep(B(), sel.tableId, sel.r0, sel.r1); UI.toast({ type: 'ok', text: `${sel.r0 + 1}${sel.r1 > sel.r0 ? `〜${sel.r1 + 1}` : ''} 行目を板の表の行にしました（板の数だけ繰り返し、あふれたら次のページへ）。検査番号ごとに 1 行にするときは、バーの「行のまとめ」を使います`, duration: 7000 }); }),
      clearRep: () => exec('板の表を解除', () => BD().setRep(B(), sel.tableId, null)),

      /* ---------- 表 ---------- */
      setTableName: (name) => exec('表の名前', () => { const t = table(); if (t) t.name = U.normValue(name) || '表'; }),
      deleteTable: () => { const r = exec('表を削除', () => { const f = tableSel(); if (f) BD().removeBlock(B(), f.zone.id); sel = { kind: 'none' }; }); undoToast('表（画像）を区画から外しました'); return r; },
      /** 区画に表・文章・板の表を入れる */
      addTable: (zoneId, rows, cols) => exec('表を入れる', () => { const t = BD().setBlock(B(), zoneId, BD().newTable(rows || 3, cols || 3, { name: '表' })); sel = { kind: 'cell', tableId: t.id, r0: 0, c0: 0, r1: 0, c1: 0, ar: 0, ac: 0 }; }),
      addText: (zoneId) => exec('文章を入れる', () => { const t = BD().setBlock(B(), zoneId, BD().newTable(1, 1, { name: '文章', border: false, rowH: 36 })); sel = { kind: 'cell', tableId: t.id, r0: 0, c0: 0, r1: 0, c1: 0, ar: 0, ac: 0 }; }),
      addPlateTable: (zoneId) => exec('板の表を入れる', () => {
        const t = BD().newTable(2, 4, { name: '板の表' });
        const head = { b: 1, bg: '#dbe7f4', h: 'center', v: 'middle' };
        for (let c = 0; c < 4; c++) SD().setStyle(BD().L(t), { r0: 0, c0: c, r1: 0, c1: c }, head);
        BD().setBlock(B(), zoneId, t);
        BD().setRep(B(), t.id, 1);
        sel = { kind: 'cell', tableId: t.id, r0: 0, c0: 0, r1: 0, c1: 0, ar: 0, ac: 0 };
      }),

      /* ---------- 画像 ---------- */
      addImage: (zoneId, img) => exec('画像を入れる', () => { const b = BD().setBlock(B(), zoneId, BD().newImage(img)); sel = { kind: 'table', tableId: b.id }; }),
      replaceImage: (tableId, img) => exec('画像を差し替える', () => { const f = BD().findTable(B(), tableId); if (f && BD().isImage(f.table)) { f.table.src = img.src; f.table.ratio = img.h / Math.max(1, img.w); } }),
      setImageWidthMm: (mm) => exec('画像の幅', () => { const t = table(); if (t && BD().isImage(t)) t.w = mm > 0 ? Math.min(400, mm) : 0; }),
      setImageAlign: (a) => exec('画像の位置', () => { const t = table(); if (t && BD().isImage(t)) t.align = ['left', 'center', 'right'].includes(a) ? a : 'left'; }),

      /* ---------- 自由に置く物 ---------- */
      /** 挿入。kind：text・shape・table・image。o：{shape, img, x, y, anchor, bandId}（位置は mm） */
      addFloat: (kind, o) => exec('挿入', () => {
        const n = BD().floatsOf(B()).length;
        const f = BD().newFloat(kind, Object.assign({ x: 20 + (n % 6) * 6, y: 40 + (n % 6) * 6 }, o || {}));
        if (o && o.anchor === 'band' && o.bandId) { f.anchor = 'band'; f.bandId = o.bandId; }
        BD().addFloat(B(), f);
        sel = { kind: 'float', floatId: f.id };
      }),
      replaceFloatImage: (id, img) => exec('画像を差し替える', () => { const f = BD().findFloat(B(), id); if (f && f.kind === 'image') { f.block.src = img.src; f.block.ratio = img.h / Math.max(1, img.w); } }),
      setFloatGeom: (id, g) => exec('位置・大きさ', () => BD().setFloatGeom(B(), id, g)),
      removeFloat: (id) => { const r = exec('削除', () => { BD().removeFloat(B(), id); sel = { kind: 'none' }; }); undoToast('削除しました'); return r; },
      floatZ: (id, how) => exec('重なりの順序', () => BD().floatZ(B(), id, how)),
      setFloatShow: (id, v) => exec('表示するページ', () => { const f = BD().findFloat(B(), id); if (f) f.show = ['all', 'first', 'last'].includes(v) ? v : 'all'; }),
      setShape: (id, patch) => exec('図形', () => { const f = BD().findFloat(B(), id); if (f && f.shape) Object.assign(f.shape, patch); }),
      setFloatAnchor: (id, anchor, bandId, x, y) => exec('位置の基準', () => { const f = BD().findFloat(B(), id); if (!f) return; f.anchor = anchor; f.bandId = anchor === 'band' ? bandId : null; f.x = x; f.y = y; }),
      duplicateFloat: (id) => exec('複製', () => {
        const f = BD().findFloat(B(), id);
        if (!f) return;
        const c = JSON.parse(JSON.stringify(f));
        const re = (x) => { if (x && typeof x === 'object') { if (x.id) x.id = U.uid('bd'); Object.keys(x).forEach((k) => { if (k !== 'cells') re(x[k]); }); } };
        re(c);
        c.x += 5; c.y += 5;
        BD().addFloat(B(), c);
        sel = { kind: 'float', floatId: c.id };
      }),

      /* ---------- 帯・区画 ---------- */
      addBand: (section, index, ratios, o) => exec('帯を追加', () => {
        const list = B()[section];
        const at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length));
        const b = BD().addBand(B(), section, at, ratios);
        if (o && o.stick && at > 0) list[at - 1].gap = 0; // 上の帯にくっつける
        if (o && o.pageBreak && section === 'bands' && B()[section].indexOf(b) > 0) b.breakBefore = true; // 新しいページから始める
        sel = { kind: 'band', bandId: b.id };
      }),
      removeBand: (id) => { const r = exec('帯を削除', () => { BD().removeBand(B(), id); sel = { kind: 'none' }; }); undoToast('帯を削除しました'); return r; },
      moveBand: (id, dir) => exec('帯を動かす', () => BD().moveBand(B(), id, dir)),
      addZoneRight: (id) => exec('右に区画を足す', () => { BD().addZoneRight(B(), id, B().page); }),
      setZones: (id, ratios) => exec('区画', () => BD().setZones(B(), id, ratios)),
      setBandHeightMm: (id, mm) => exec('帯の高さ', () => BD().setBandHeight(B(), id, mm > 0 ? mm * CDB.sheetPages.PX_PER_MM : 0)),
      setZoneGap: (id, mm, idx) => exec('区画の間隔', () => BD().setZoneGap(B(), id, mm, idx)),
      /** 選んだセルの {変数} を「連続をまとめる」にする（2、4～11）。すでに全部そうなら解除。変数がなければ、defName の列を入れる。結果を返す：'on'|'off'|'insert'|'none' */
      toggleRange: (defName) => {
        const t = table();
        const cell = t.cells[BD().key(sel.ar, sel.ac)] || {};
        const text = cell.t === undefined ? '' : String(cell.t);
        const BCm = CDB.blockCompile;
        const toks = /^\s*[=＝]/.test(text) ? [] : BCm.tokensOf(text).filter((k) => !/^[=＝]/.test(k.name) && !BCm.VARS[k.name]);
        let result = 'none';
        exec('連続をまとめる', () => {
          let out = text;
          if (toks.length) {
            const turnOn = !toks.every((k) => k.props.range);
            for (let i = toks.length - 1; i >= 0; i--) {
              const k = toks[i];
              const props = Object.assign({}, k.props);
              if (turnOn) { props.range = true; delete props.runs; } else { delete props.range; delete props.rangeKey; }
              out = out.slice(0, k.start) + BCm.serializeVar(k.name, props) + out.slice(k.end);
            }
            result = turnOn ? 'on' : 'off';
          } else if (text === '' && defName) {
            out = BCm.serializeVar(defName, { range: true });
            result = 'insert';
          }
          if (out !== text) { BD().setText(t, sel.ar, sel.ac, out); BD().fitMultiline(t, sel.ar, sel.ac); }
        });
        return result;
      },
      setRepBy: (colId) => exec('板の表の行のまとめ方', () => BD().setRepBy(B(), sel.tableId, colId)),
      setRule: (which, rule) => exec('一定間隔の罫線', () => BD().setRule(B(), sel.tableId, which, rule)),
      setBandGap: (id, mm) => exec('帯の下の余白', () => BD().setBandGap(B(), id, mm)),
      setBandBreak: (id, v) => exec('改ページ', () => BD().setBandBreak(B(), id, v)),
      setBandShow: (id, v) => exec('表示するページ', () => BD().setBandShow(B(), id, v)),
      setBandAlign: (id, a) => exec('区画内の位置', () => BD().setBandAlign(B(), id, a)),
      setZoneAlign: (id, a) => exec('区画内の位置', () => BD().setZoneAlign(B(), id, a)),

      /* ---------- 用紙 ---------- */
      setPage: (patch) => exec('用紙', () => { Object.assign(B().page, patch); if (patch.margin) B().page.margin = Object.assign({}, patch.margin); })
    };

    /** 選んだセルに文字を入れる（変数の挿入用）。空なら置き換え、中身があれば後ろにつなぐ */
    function insertText(text) {
      if (sel.kind !== 'cell') return false;
      const t = table();
      const cell = t.cells[BD().key(sel.ar, sel.ac)] || {};
      const cur = cell.t === undefined ? '' : String(cell.t);
      ops.setText(sel.tableId, sel.ar, sel.ac, cur + text);
      return true;
    }

    /** 選んだセルの中身 */
    function cellText() {
      if (sel.kind !== 'cell') return '';
      const t = table();
      const cell = t && t.cells[BD().key(sel.ar, sel.ac)];
      return cell && cell.t !== undefined ? String(cell.t) : '';
    }

    return {
      sel: () => { fix(); return Object.assign({}, sel); }, kind: () => { fix(); return sel.kind; },
      /** 帳票を切り替えたとき：選択と、取り消しの控えを捨てる（別の帳票に戻してしまわないように） */
      reset: () => { sel = { kind: 'none' }; undoStack.length = 0; redoStack.length = 0; }, table, tableSel, bandSel, zoneMm, range, expand,
      selectCell, selectTable, selectBand, selectFloat, floatSel, clearSel, move, exec, beginLive, endLive, undo, redo, ops, insertText, cellText,
      canUndo: () => undoStack.length > 0, canRedo: () => redoStack.length > 0,
      onChange: (fn) => listeners.push(fn), notify, fix,
      addr: () => (sel.kind === 'cell' ? (sel.r0 === sel.r1 && sel.c0 === sel.c1 ? U.cellAddr(sel.r0, sel.c0) : `${U.cellAddr(sel.r0, sel.c0)}:${U.cellAddr(sel.r1, sel.c1)}`) : '')
    };
  }

  UI.blockState = { create };
})();
