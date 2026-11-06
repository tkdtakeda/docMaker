/* =========================================================
   js/ui/block-bar.js : ブロックの帳票の操作バー（選んだものの種類で中身が変わる）
   セル：文字・色・罫線・配置／結合・行列・列幅・高さ／板の表 ・ 表：名前・幅と高さをそろえる・区画内の位置・削除
   帯：区画の数と比率・高さ・下の余白・並べ替え・削除 ・ 何も選んでいない：案内
   操作は block-state.js に渡すだけ。1 段に収まらない幅でも、段ごとに折り返さない
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const UI = CDB.ui;
  const { el, icon } = U;
  const SD = () => CDB.sheetDoc;
  const BD = () => CDB.blockDoc;
  const SP = () => CDB.sheetPages;

  const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36];
  const BORDER_MODES = [
    ['all', 'fa-border-all', '格子（すべての辺）'], ['outer', 'fa-border-outer', '外枠'], ['inner', 'fa-border-none', '内側だけ'],
    ['top', 'fa-arrow-up', '上'], ['bottom', 'fa-arrow-down', '下'], ['left', 'fa-arrow-left', '左'], ['right', 'fa-arrow-right', '右'], ['none', 'fa-ban', '罫線をなくす']
  ];
  const RATIOS = [['全幅', [1]], ['50:50', [50, 50]], ['60:40', [60, 40]], ['70:30', [70, 30]], ['3 区画', [1, 1, 1]]];

  /**
   * @param {HTMLElement} host
   * @param {{st:object}} api
   */
  function create(host, api) {
    const st = api.st;
    const canvas = api.canvas;
    const lineState = { style: 'thin', color: '#111111' };
    const open = { border: false, rc: false, same: false, para: false, insert: false };
    const K = () => SP().PX_PER_MM;

    const btn = (ic, title, onclick, o) => {
      const x = o || {};
      return el('button', {
        class: 'icon-btn rp-fmt' + (x.on ? ' is-on' : '') + (x.keep ? ' rp-keep' : ''), type: 'button', title, 'aria-label': title, 'aria-pressed': x.on === undefined ? null : String(!!x.on),
        disabled: !!x.disabled, onclick
      }, [icon(ic), x.text ? el('span', { class: 'rp-fmt-text', text: x.text }) : null, x.caret ? icon('fa-caret-down') : null]);
    };
    const sep = () => el('span', { class: 'rp-fmt-sep', 'aria-hidden': 'true' });
    const group = (title, kids) => el('div', { class: 'rp-fmt-group', role: 'group', 'aria-label': title }, kids.filter(Boolean));
    const closeAll = () => { open.border = false; open.rc = false; open.same = false; open.para = false; open.insert = false; };
    const toggleOpen = (k) => (e) => { e.stopPropagation(); const was = open[k]; closeAll(); open[k] = !was; render(); };
    const numBox = (label, value, min, max, step, unit, onChange, title) => {
      const i = el('input', { class: 'input rp-num', type: 'number', min, max, step, value: String(value), 'aria-label': label, title });
      i.addEventListener('change', () => onChange(Number(i.value)));
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) i.blur(); });
      return el('label', { class: 'rp-numbox', title }, [label, i, el('span', { class: 'muted', text: unit })]);
    };
    const mm1 = (n) => Math.round(n * 10) / 10;
    const undoGroup = () => group('取り消し', [btn('fa-rotate-left', '取り消し（Ctrl+Z）', () => st.undo(), { disabled: !st.canUndo() }), btn('fa-rotate-right', 'やり直し（Ctrl+Y）', () => st.redo(), { disabled: !st.canRedo() })]);

    /* ---------- セル ---------- */
    function cellRows() {
      const t = st.table();
      const sel = st.sel();
      const cell = t.cells[BD().key(sel.ar, sel.ac)] || {};
      const s = cell.s || {};
      const ops = st.ops;
      const set = (patch) => () => ops.setStyle(patch);
      const toggle = (k) => () => ops.setStyle({ [k]: s[k] ? false : 1 });

      const font = UI.select(SD().FONTS.map((f) => ({ value: f, label: f })), s.f || SD().DEFAULT_FONT, { 'aria-label': 'フォント', title: 'フォント' });
      font.addEventListener('change', () => ops.setStyle({ f: font.value }));
      const size = UI.select(SIZES.map((n) => ({ value: String(n), label: String(n) })), String(s.sz || SD().DEFAULT_SIZE), { 'aria-label': '文字サイズ（pt）', title: '文字サイズ（pt）' });
      size.addEventListener('change', () => ops.setStyle({ sz: Number(size.value) }));
      const color = el('input', { type: 'color', class: 'rp-color', value: s.color || '#000000', title: '文字の色', 'aria-label': '文字の色' });
      color.addEventListener('change', () => ops.setStyle({ color: color.value }));
      const fill = el('input', { type: 'color', class: 'rp-color', value: s.bg || '#ffffff', title: '塗りつぶしの色', 'aria-label': '塗りつぶしの色' });
      fill.addEventListener('change', () => ops.setStyle({ bg: fill.value }));

      const lineSel = UI.select(SD().BORDER_STYLES, lineState.style, { 'aria-label': '線の種類', title: '線の種類' });
      lineSel.addEventListener('change', () => { lineState.style = lineSel.value; });
      lineSel.addEventListener('click', (e) => e.stopPropagation());
      const lineColor = el('input', { type: 'color', class: 'rp-color', value: lineState.color, title: '線の色', 'aria-label': '線の色' });
      lineColor.addEventListener('change', () => { lineState.color = lineColor.value; });
      lineColor.addEventListener('click', (e) => e.stopPropagation());
      const bm = el('div', { class: 'menu rp-bmenu', role: 'menu', hidden: !open.border }, [
        el('div', { class: 'rp-menu-row' }, [el('span', { class: 'muted', text: '線' }), lineSel, lineColor]),
        ...BORDER_MODES.map(([mode, ic, label]) => el('button', { type: 'button', onclick: () => { open.border = false; ops.setBorder(mode, `${lineState.style} ${lineState.color}`); } }, [icon(ic), label]))
      ]);
      const bBtn = el('button', { class: 'icon-btn rp-fmt', type: 'button', title: '罫線を引く（線の種類・色を選んで、辺を押す）', 'aria-haspopup': 'menu', 'aria-expanded': String(open.border), onclick: toggleOpen('border') },
        [icon('fa-border-all'), el('span', { class: 'rp-fmt-text', text: '罫線' }), icon('fa-caret-down')]);

      // 段落：左のインデント（Ctrl+] / Ctrl+[）・先頭行の字下げ・左右の余白（mm）・行間。Excel に出るのは左のインデントだけ
      const paraNum = (label, key, min, max, step, unit) => {
        const i = el('input', { class: 'input rp-num', type: 'number', min, max, step, value: s[key] === undefined ? '' : String(s[key]), placeholder: '0', 'aria-label': label });
        i.addEventListener('click', (e) => e.stopPropagation());
        i.addEventListener('change', () => { const v = i.value === '' ? false : Math.max(min, Math.min(max, Number(i.value))); open.para = false; ops.setStyle({ [key]: v || false }); });
        i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) i.blur(); });
        return el('label', { class: 'rp-menu-row' }, [el('span', { class: 'muted', text: label }), i, el('span', { class: 'muted', text: unit })]);
      };
      const paraMenu = el('div', { class: 'menu rp-bmenu', role: 'menu', hidden: !open.para }, [
        el('div', { class: 'menu-label', text: '段落（このセルの中身の余白）' }),
        paraNum('左の余白', 'pl', 0, 50, 0.5, 'mm'), paraNum('右の余白', 'pr', 0, 50, 0.5, 'mm'),
        paraNum('先頭行の字下げ', 'fi', 0, 5, 0.5, '文字'), paraNum('行間', 'lh', 1, 3, 0.1, '倍'),
        el('div', { class: 'muted', style: 'padding:2px 8px', text: 'Excel には、左のインデント（段）だけが出ます。余白・字下げ・行間は、画面・PDF に出ます。' })
      ]);
      const paraBtn = el('button', { class: 'icon-btn rp-fmt', type: 'button', title: '段落の余白（左右の余白・先頭行の字下げ・行間）', 'aria-haspopup': 'menu', 'aria-expanded': String(open.para), onclick: toggleOpen('para') },
        [icon('fa-paragraph'), el('span', { class: 'rp-fmt-text', text: '段落' }), icon('fa-caret-down')]);

      const n = (a, b) => b - a + 1;
      const rc = el('div', { class: 'menu rp-bmenu', role: 'menu', hidden: !open.rc }, [
        el('div', { class: 'menu-label', text: `行（${sel.r0 + 1}${sel.r1 > sel.r0 ? `〜${sel.r1 + 1}` : ''} 行目）` }),
        el('button', { type: 'button', onclick: () => { open.rc = false; ops.insertRowsAbove(); } }, [icon('fa-arrow-up'), '上に行を挿入']),
        el('button', { type: 'button', onclick: () => { open.rc = false; ops.insertRowsBelow(); } }, [icon('fa-arrow-down'), '下に行を挿入']),
        el('button', { type: 'button', class: 'is-danger', disabled: t.nRows <= n(sel.r0, sel.r1), onclick: () => { open.rc = false; ops.deleteRows(); } }, [icon('fa-trash-can'), '選んだ行を削除']),
        el('div', { class: 'menu-label', text: `列（${U.colLetter(sel.c0)}${sel.c1 > sel.c0 ? `〜${U.colLetter(sel.c1)}` : ''} 列）` }),
        el('button', { type: 'button', onclick: () => { open.rc = false; ops.insertColsLeft(); } }, [icon('fa-arrow-left'), '左に列を挿入']),
        el('button', { type: 'button', onclick: () => { open.rc = false; ops.insertColsRight(); } }, [icon('fa-arrow-right'), '右に列を挿入']),
        el('button', { type: 'button', class: 'is-danger', disabled: t.nCols <= n(sel.c0, sel.c1), onclick: () => { open.rc = false; ops.deleteCols(); } }, [icon('fa-trash-can'), '選んだ列を削除'])
      ]);
      const rcBtn = el('button', { class: 'icon-btn rp-fmt', type: 'button', title: '行・列を挿入・削除（右クリックでも出ます）', 'aria-haspopup': 'menu', 'aria-expanded': String(open.rc), onclick: toggleOpen('rc') },
        [icon('fa-table-cells'), el('span', { class: 'rp-fmt-text', text: '行・列' }), icon('fa-caret-down')]);

      // 幅と高さ（mm）：入力でもドラッグ（列の境界・行の下端）でも変えられる。そろえるはメニュー
      const zmm = st.zoneMm();
      const same = el('div', { class: 'menu rp-bmenu', role: 'menu', hidden: !open.same }, [
        el('button', { type: 'button', onclick: () => { open.same = false; ops.equalizeCols(); } }, [icon('fa-arrows-left-right'), sel.c1 > sel.c0 ? '選んだ列の幅を均等に' : '表の全部の列の幅を均等に']),
        el('button', { type: 'button', disabled: sel.c1 === sel.c0, onclick: () => { open.same = false; ops.sameWidthAsFirst(); } }, [icon('fa-equals'), '選んだ列を 1 列目の幅にそろえる']),
        el('button', { type: 'button', onclick: () => { open.same = false; ops.fitCols(); } }, [icon('fa-text-width'), sel.c1 > sel.c0 ? '選んだ列を内容の幅に合わせる' : '選んだ列（1 列）を内容の幅に合わせる']),
        el('button', { type: 'button', onclick: () => { open.same = false; ops.equalizeRows(); } }, [icon('fa-arrows-up-down'), sel.r1 > sel.r0 ? '選んだ行の高さを均等に' : '表の全部の行の高さを均等に'])
      ]);
      const sameBtn = el('button', { class: 'icon-btn rp-fmt', type: 'button', title: '幅・高さをそろえる', 'aria-haspopup': 'menu', 'aria-expanded': String(open.same), onclick: toggleOpen('same') },
        [icon('fa-ruler-combined'), el('span', { class: 'rp-fmt-text', text: 'そろえる' }), icon('fa-caret-down')]);

      const inMerge = t.merges.some((m) => SD().hit(m, st.range()));
      const mergeWhy = SD().mergeBlock(BD().L(t), st.range());
      const isRep = !!t.rep && t.rep.top === sel.r0 && t.rep.bottom === sel.r1;

      // docMaker：CDB の【特別な機能】（板番号を検査番号ごとに連続まとめ）は取り込んでいない
      // 板の表の行のまとめ方（板ごと／検査番号ごとなど）。板の表のあるときだけ
      function repBySelect(tb) {
        const cols = (api.getColumns ? api.getColumns() : []).filter((c) => c.side === 'plate' || c.side === 'master');
        const opts = [{ value: '', label: '板ごとに 1 行' }].concat(cols.map((c) => ({ value: c.id, label: `${c.label} ごとに 1 行` })));
        if (tb.repBy && !cols.some((c) => c.id === tb.repBy)) opts.push({ value: tb.repBy, label: `${tb.repBy.slice(2)} ごとに 1 行（今のデータにない列）` });
        const sel2 = UI.select(opts, tb.repBy || '', { 'aria-label': '板の表の行のまとめ方', title: '板の表の 1 行を、板 1 枚にするか、列の値（検査番号など）が同じ板のまとまりにするかを決めます。列ごとの行は、値の昇順に並びます' });
        sel2.addEventListener('change', () => { ops.setRepBy(sel2.value); UI.toast({ type: 'ok', text: sel2.value ? `${(cols.find((c) => c.id === sel2.value) || {}).label || '列'} ごとに 1 行にします` : '1 行ずつにします', duration: 6000 }); });
        return sel2;
      }

      const rowA = el('div', { class: 'rp-fmt-row is-cell' }, [
        group('文字', [font, size, btn('fa-bold', '太字（Ctrl+B）', toggle('b'), { on: !!s.b }), btn('fa-italic', '斜体（Ctrl+I）', toggle('i'), { on: !!s.i }), btn('fa-underline', '下線（Ctrl+U）', toggle('u'), { on: !!s.u }),
          el('label', { class: 'rp-colorbox', title: '文字の色' }, [icon('fa-font'), color]),
          el('label', { class: 'rp-colorbox', title: '塗りつぶしの色' }, [icon('fa-fill-drip'), fill]),
          btn('fa-droplet-slash', '塗りつぶしをなくす', set({ bg: null }))]),
        sep(), group('罫線', [bBtn, bm]), sep(),
        group('配置', [
          btn('fa-align-left', '左揃え', set({ h: 'left' }), { on: s.h === 'left' }), btn('fa-align-center', '中央揃え', set({ h: 'center' }), { on: s.h === 'center' }), btn('fa-align-right', '右揃え', set({ h: 'right' }), { on: s.h === 'right' }),
          btn('fa-arrow-up-long', '上揃え', set({ v: 'top' }), { on: s.v === 'top' }), btn('fa-grip-lines', '上下中央', set({ v: 'middle' }), { on: s.v === 'middle' }), btn('fa-arrow-down-long', '下揃え', set({ v: 'bottom' }), { on: s.v === 'bottom' }),
          btn('fa-turn-down', '折り返して全体を表示', toggle('wrap'), { on: !!s.wrap, text: '折返' }), btn('fa-down-left-and-up-right-to-center', '縮小して全体を表示', toggle('shrink'), { on: !!s.shrink, text: '縮小' })]),
        sep(),
        group('段落', [btn('fa-outdent', 'インデントを減らす（Ctrl+[）', () => ops.indent(-1), { disabled: !s.ind }), btn('fa-indent', 'インデントを増やす（Ctrl+]）', () => ops.indent(1)), paraBtn, paraMenu])
      ]);
      const rowB = el('div', { class: 'rp-fmt-row is-cell' }, [
        el('span', { class: 'rp-fmt-addr', title: `選んでいるセル（${t.name}）`, text: `${t.name} ${st.addr()}` }), undoGroup(), sep(),
        group('結合', [btn('fa-object-group', mergeWhy || '選んだセルを結合', () => ops.merge(), { disabled: !!mergeWhy, text: '結合' }), btn('fa-object-ungroup', '結合を解除', () => ops.unmerge(), { disabled: !inMerge, text: '解除' })]), sep(),
        group('行・列', [rcBtn, rc,
          numBox('幅', mm1(t.colW[sel.c0] * zmm), 3, 400, 0.5, 'mm', (v) => ops.setColWidthMm(v), '選んだ列の幅（mm）。列の境界をドラッグしても変えられます'),
          numBox('高さ', mm1(t.rowH[sel.r0] / K()), 3, 300, 0.5, 'mm', (v) => ops.setRowHeightMm(v), '選んだ行の高さ（mm）。行の下端をドラッグしても変えられます'),
          sameBtn, same]), sep(),
        st.floatSel() ? group('枠', [btn('fa-vector-square', 'このテキストボックス・表の枠を選ぶ（移動・大きさ・重なり・基準）', () => st.selectFloat(st.floatSel().id), { text: '枠を選ぶ', keep: true })]) : group('板の表', [isRep
          ? btn('fa-xmark', '板の表を解除', () => ops.clearRep(), { text: '板の表を解除', keep: true })
          : btn('fa-grip-lines', 'この行（選んだ連続する行）を板の表の行にする（板の数だけ繰り返します。複数行も可。全幅の帯の表だけ）', () => ops.setRep(), { text: '板の表の行にする', keep: true })]),
        sep(),
        t.rep ? group('行のまとめ', [repBySelect(t)]) : null
      ]);
      return [rowA, rowB];
    }

    /* ---------- 表 ---------- */
    function tableRows() {
      const f = st.tableSel();
      const t = f.table;
      const ops = st.ops;
      const name = el('input', { class: 'input', type: 'text', value: t.name, 'aria-label': '表の名前', title: '表の名前（式や点検の表示に使います）' });
      name.addEventListener('change', () => { ops.setTableName(name.value); U.flash(name); });
      const alignBtns = [['top', 'fa-arrow-up-long', '上揃え（標準）'], ['middle', 'fa-grip-lines', '上下中央'], ['bottom', 'fa-arrow-down-long', '下揃え'], ['stretch', 'fa-arrows-up-down', '高さを合わせる（行を引き伸ばして、帯の高さに）']].map(([v, ic, label]) =>
        btn(ic, `同じ帯の中で、この表を${label}にする`, () => ops.setZoneAlign(f.zone.id, v), { on: (f.zone.align || f.band.align || 'top') === v }));
      return [el('div', { class: 'rp-fmt-row' }, [
        el('span', { class: 'rp-fmt-addr', text: '表' }), name, undoGroup(), sep(),
        group('幅・高さ', [btn('fa-arrows-left-right', '全部の列の幅を均等にする', () => ops.equalizeCols(), { text: '列を均等' }), btn('fa-arrows-up-down', '全部の行の高さを均等にする', () => ops.equalizeRows(), { text: '行を均等' })]), sep(),
        group('この表の位置（同じ帯の中）', alignBtns), sep(),
        group('表', [btn('fa-trash-can', '表を区画から外す（取り消せます）', () => ops.deleteTable(), { text: '表を削除' })])
      ])];
    }

    /* ---------- 挿入（自由に置く物） ---------- */
    function insertGroup() {
      const sel = st.sel();
      const where = sel.kind === 'band' ? { anchor: 'band', bandId: sel.bandId, x: 5, y: 5 } : {}; // 帯を選んでいれば、その帯に固定して置く
      const add = (kind, o) => () => { open.insert = false; st.ops.addFloat(kind, Object.assign({}, where, o || {})); canvas.focus(); }; // 置いたあとは、すぐ矢印キー・Enter が効くように、編集画面へフォーカスを戻す
      const item = (ic, label, fn) => el('button', { type: 'button', onclick: fn }, [icon(ic), label]);
      const menu = el('div', { class: 'menu rp-bmenu', role: 'menu', hidden: !open.insert }, [
        el('div', { class: 'menu-label', text: sel.kind === 'band' ? '選んだ帯に固定して置く' : '用紙の上に自由に置く' }),
        item('fa-font', 'テキストボックス', add('text')),
        item('fa-square', '四角', add('shape', { shape: 'rect' })), item('fa-circle', '楕円', add('shape', { shape: 'ellipse' })),
        item('fa-minus', '線', add('shape', { shape: 'line', w: 50, h: 0 })), item('fa-arrow-right-long', '矢印', add('shape', { shape: 'arrow', w: 50, h: 0 })),
        el('button', { type: 'button', onclick: (ev) => { open.insert = false; canvas.pickTable(ev, (rows, cols) => { st.ops.addFloat('table', Object.assign({ rows, cols }, where)); canvas.focus(); }); } }, [icon('fa-table-cells'), '表…']),
        item('fa-image', '画像…', () => { open.insert = false; render(); UI.blockImage.choose((img) => { st.ops.addFloat('image', Object.assign({ img }, where)); canvas.focus(); }); })
      ]);
      const b = el('button', { class: 'icon-btn rp-fmt', type: 'button', title: '自由に置く物を挿入（テキストボックス・図形・表・画像）', 'aria-haspopup': 'menu', 'aria-expanded': String(open.insert), onclick: toggleOpen('insert') },
        [icon('fa-plus'), el('span', { class: 'rp-fmt-text', text: '挿入' }), icon('fa-caret-down')]);
      return group('挿入', [b, menu]);
    }

    function floatRows() {
      const f = st.floatSel();
      const ops = st.ops;
      const sz = BD().floatSizeMm(f);
      const shape = f.kind === 'shape' ? f.shape : null;
      const isLine = shape && (shape.type === 'line' || shape.type === 'arrow');
      const kindName = { text: 'テキストボックス', shape: '図形', table: '表', image: '画像' }[f.kind];
      const anchor = UI.select([{ value: 'page', label: 'ページ基準' }, { value: 'band', label: '帯に固定' }], f.anchor, { 'aria-label': '位置の基準', title: '位置の基準：ページ（用紙の印刷範囲の左上から）か、帯（帯の左上から。帯と一緒に動く）' });
      anchor.addEventListener('change', () => canvas.anchorFloat(f.id, anchor.value));
      const show = UI.select([{ value: 'all', label: '全ページ' }, { value: 'first', label: '1 ページ目だけ' }, { value: 'last', label: '最後のページだけ' }], f.show || 'all', { 'aria-label': '表示するページ', title: '表示するページ（ページ基準のとき）' });
      show.disabled = f.anchor !== 'page';
      show.addEventListener('change', () => ops.setFloatShow(f.id, show.value));
      const color = (value, title, cb) => { const i = el('input', { type: 'color', class: 'rp-color', value, title, 'aria-label': title }); i.addEventListener('change', () => cb(i.value)); return i; };
      const shapeGroup = shape ? [sep(), group('図形', [
        el('label', { class: 'rp-colorbox', title: '線の色' }, [icon('fa-pen'), color(shape.stroke || '#000000', '線の色', (v) => ops.setShape(f.id, { stroke: v }))]),
        isLine ? null : el('label', { class: 'rp-colorbox', title: '塗りつぶしの色' }, [icon('fa-fill-drip'), color(shape.fill || '#ffffff', '塗りつぶしの色', (v) => ops.setShape(f.id, { fill: v }))]),
        isLine ? null : btn('fa-droplet-slash', '塗りつぶしをなくす', () => ops.setShape(f.id, { fill: '' })),
        numBox('線の太さ', shape.sw, 0.1, 5, 0.1, 'mm', (v) => ops.setShape(f.id, { sw: v }), '線の太さ（mm）'),
        isLine ? btn('fa-left-right', '左右を反転', () => ops.setShape(f.id, { fx: !shape.fx })) : null,
        isLine ? btn('fa-up-down', '上下を反転', () => ops.setShape(f.id, { fy: !shape.fy })) : null])] : [];
      return [el('div', { class: 'rp-fmt-row' }, [
        el('span', { class: 'rp-fmt-addr', text: kindName }), undoGroup(), sep(),
        group('位置と大きさ', [
          numBox('x', mm1(f.x), -100, 600, 0.5, 'mm', (v) => ops.setFloatGeom(f.id, { x: v }), '左からの位置（mm）。矢印キーで 1mm ずつ動かせます'),
          numBox('y', mm1(f.y), -100, 800, 0.5, 'mm', (v) => ops.setFloatGeom(f.id, { y: v }), '上からの位置（mm）'),
          numBox('幅', mm1(sz.w), 3, 600, 0.5, 'mm', (v) => ops.setFloatGeom(f.id, { w: v }), '幅（mm）'),
          f.kind === 'image' ? el('span', { class: 'muted', title: '画像は縦横比を保つため、高さは幅から決まります', text: `高さ ${mm1(sz.h)}mm` }) : numBox('高さ', mm1(sz.h), 0, 800, 0.5, 'mm', (v) => ops.setFloatGeom(f.id, { h: v }), f.kind === 'shape' ? '高さ（mm）' : '高さ（mm。行の高さを比例して変えます）')]),
        sep(), group('基準', [anchor, show]), sep(),
        group('重なり', [btn('fa-angles-up', '最前面へ', () => ops.floatZ(f.id, 'front')), btn('fa-angle-up', '1 つ前へ', () => ops.floatZ(f.id, 'up')), btn('fa-angle-down', '1 つ後ろへ', () => ops.floatZ(f.id, 'down')), btn('fa-angles-down', '最背面へ', () => ops.floatZ(f.id, 'back'))]),
        ...shapeGroup, sep(),
        group('物', [
          (f.kind === 'text' || f.kind === 'table') ? btn('fa-pen', '中身を編集（Enter）', () => st.selectCell(f.block.id, 0, 0), { text: '中身を編集', keep: true }) : null,
          f.kind === 'image' ? btn('fa-image', '別の画像に差し替える', () => UI.blockImage.choose((img) => ops.replaceFloatImage(f.id, img)), { text: '差し替え', keep: true }) : null,
          btn('fa-clone', '複製（Ctrl+D）', () => ops.duplicateFloat(f.id), { text: '複製', keep: true }),
          btn('fa-trash-can', '削除（Delete）', () => ops.removeFloat(f.id), { text: '削除', keep: true })])
      ])];
    }

    /* ---------- 画像 ---------- */
    function imageRows() {
      const f = st.tableSel();
      const t = f.table;
      const ops = st.ops;
      const zmm = st.zoneMm();
      const name = el('input', { class: 'input', type: 'text', value: t.name, 'aria-label': '画像の名前' });
      name.addEventListener('change', () => { ops.setTableName(name.value); U.flash(name); });
      const posBtns = [['left', 'fa-align-left', '左'], ['center', 'fa-align-center', '中央'], ['right', 'fa-align-right', '右']].map(([v, ic, label]) => btn(ic, `画像を区画の${label}に置く`, () => ops.setImageAlign(v), { on: (t.align || 'left') === v }));
      const zoneAlign = [['top', 'fa-arrow-up-long', '上揃え（標準）'], ['middle', 'fa-grip-lines', '上下中央'], ['bottom', 'fa-arrow-down-long', '下揃え']].map(([v, ic, label]) =>
        btn(ic, `同じ帯の中で、この画像を${label}にする`, () => ops.setZoneAlign(f.zone.id, v), { on: (f.zone.align || f.band.align || 'top') === v }));
      return [el('div', { class: 'rp-fmt-row' }, [
        el('span', { class: 'rp-fmt-addr', text: '画像' }), name, undoGroup(), sep(),
        group('大きさ', [numBox('幅', t.w > 0 ? mm1(Math.min(t.w, zmm)) : mm1(zmm), 3, 400, 1, 'mm', (v) => ops.setImageWidthMm(v), '画像の幅（mm）。標準は区画の幅いっぱい。縦横比は保たれます'),
          btn('fa-up-right-and-down-left-from-center', '区画の幅いっぱいにする', () => ops.setImageWidthMm(0), { text: '区画の幅に合わせる', keep: true, disabled: !(t.w > 0) })]), sep(),
        group('位置', posBtns), sep(), group('この画像の位置（同じ帯の中）', zoneAlign), sep(),
        group('画像', [btn('fa-image', '別の画像に差し替える', () => UI.blockImage.choose((img) => ops.replaceImage(t.id, img)), { text: '差し替え', keep: true }), btn('fa-trash-can', '画像を区画から外す（取り消せます）', () => ops.deleteTable(), { text: '画像を削除', keep: true })])
      ])];
    }

    /* ---------- 帯 ---------- */
    function bandRows() {
      const f = st.bandSel();
      const b = f.band;
      const ops = st.ops;
      const ratio = el('input', { class: 'input rp-num', type: 'text', value: b.zones.map((z) => Math.round(z.w)).join(':'), 'aria-label': '区画の比率', title: '区画の比率（例：60:40 や 1:1:1）', style: 'width:90px' });
      const apply = () => {
        const parts = ratio.value.split(/[:：,，\s]+/).map(Number).filter((x) => x > 0);
        if (!parts.length) { UI.toast({ type: 'warn', text: '比率は 60:40 のように数字で入れてください' }); render(); return; }
        ops.setZones(b.id, parts);
      };
      ratio.addEventListener('change', apply);
      ratio.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) ratio.blur(); });
      const alignBtns = [['top', 'fa-arrow-up-long', '上揃え（標準）'], ['middle', 'fa-grip-lines', '上下中央'], ['bottom', 'fa-arrow-down-long', '下揃え'], ['stretch', 'fa-arrows-up-down', '高さを合わせる（行を引き伸ばす）']].map(([v, ic, label]) =>
        btn(ic, `背の低い表を${label}にする`, () => ops.setBandAlign(b.id, v), { on: (b.align || 'top') === v }));
      const showSel = f.section === 'bands' ? null : UI.select([{ value: 'all', label: '全ページ' }, { value: 'first', label: '1 ページ目だけ' }, { value: 'last', label: '最後のページだけ' }], b.show || 'all', { 'aria-label': '表示するページ', title: 'この帯を出すページ' });
      if (showSel) showSel.addEventListener('change', () => ops.setBandShow(b.id, showSel.value));
      return [el('div', { class: 'rp-fmt-row' }, [
        el('span', { class: 'rp-fmt-addr', text: f.section === 'header' ? 'ヘッダー' : f.section === 'footer' ? 'フッター' : '帯' }), undoGroup(), sep(),
        group('区画', [...RATIOS.map(([label, r]) => btn('fa-table-columns', `区画を ${label} にする`, () => ops.setZones(b.id, r), { text: label, on: b.zones.length === r.length && r.every((x, i) => Math.abs(b.zones[i].w / b.zones.reduce((a, z) => a + z.w, 0) - x / r.reduce((a, y) => a + y, 0)) < 0.01) })), el('label', { class: 'rp-numbox' }, ['比率', ratio]),
          ...(b.zones.length > 1 ? BD().zoneGapsMm(b).map((g, gi, all) => { const nb = numBox(all.length > 1 ? `間隔${gi + 1}` : '間隔', g, 0, 30, 0.5, 'mm', (v) => ops.setZoneGap(b.id, v, gi), `${gi + 1} 番目と ${gi + 2} 番目の区画のあいだの空き（0〜30mm）。0 にすると、隣の表がくっつき、線がつながります`); nb.querySelector('input').setAttribute('data-gap', String(gi)); return nb; }) : []),
          btn('fa-square-plus', b.used > 0 && b.used < 1 ? '右の空きに、空の区画を足す' : '右に空きがありません（表の右端を左へ引くと、空きができます）', () => ops.addZoneRight(b.id), { text: '右に区画を足す', keep: true, disabled: !(b.used > 0 && b.used < 1) })]), sep(),
        group('高さ・余白', [
          numBox('高さ', b.h > 0 ? mm1(b.h / K()) : 0, 0, 400, 1, 'mm（0＝自動）', (v) => ops.setBandHeightMm(b.id, v), '帯の高さを固定します。0 なら中の表の高さに合わせます'),
          numBox('下の余白', b.gap, 0, 30, 1, 'mm', (v) => ops.setBandGap(b.id, v), '次の帯との間隔')]), sep(),
        group('区画内の位置', alignBtns), sep(),
        showSel ? group('表示するページ', [showSel]) : null, showSel ? sep() : null,
        f.section === 'bands' ? group('改ページ', [btn('fa-file-lines', b.breakBefore ? '改ページを解除（この帯の前）' : 'この帯の前で改ページ（新しいページから始める）', () => ops.setBandBreak(b.id, !b.breakBefore), { on: !!b.breakBefore, text: '前で改ページ', keep: true })]) : null,
        f.section === 'bands' ? sep() : null,
        group('順序', [btn('fa-arrow-up', '帯を上へ', () => ops.moveBand(b.id, -1)), btn('fa-arrow-down', '帯を下へ', () => ops.moveBand(b.id, 1))]), sep(),
        group('帯', [btn('fa-clone', '帯を複製してすぐ下に入れる（板の表がある帯は不可）', () => ops.duplicateBand(b.id), { text: '複製', keep: true }), btn('fa-trash-can', '帯を削除（中の表も消えます。取り消せます）', () => ops.removeBand(b.id), { text: '帯を削除' })])
      ])];
    }

    function render() {
      host.innerHTML = '';
      const k = st.kind();
      if (k === 'cell') host.append(...cellRows());
      else if (k === 'table') host.append(...(BD().isImage(st.tableSel().table) ? imageRows() : tableRows()));
      else if (k === 'band') host.append(...bandRows());
      else if (k === 'float') host.append(...floatRows());
      else {
        host.append(el('div', { class: 'rp-fmt-row' }, [undoGroup(), sep(), el('span', { class: 'muted bk-hint-line', title: '表のセルをクリックすると書式・幅・高さの操作が、帯の左のラベルをクリックすると区画・高さの操作が、ここに出ます。列の境界・行の下端・区画の境界はドラッグでも動かせます。「挿入」でテキストボックス・図形・表・画像を自由に置けます', text: 'セルをクリック＝書式・幅・高さ／帯のラベルをクリック＝区画・高さ／「挿入」＝テキストボックス・図形・表・画像' })]));
      }
      const firstRow = host.querySelector('.rp-fmt-row');
      if (firstRow) firstRow.prepend(insertGroup(), sep());
    }

    const onDoc = () => { if (open.border || open.rc || open.same || open.para || open.insert) { closeAll(); render(); } };
    document.addEventListener('click', onDoc);
    st.onChange(render);
    return { render, destroy: () => document.removeEventListener('click', onDoc) };
  }

  UI.blockBar = { create };
})();
