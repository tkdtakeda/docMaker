/* =========================================================
   js/ui/block-canvas.js : ブロックの帳票の編集画面（用紙の上に、帯・区画・表を描いて直接さわる）
   ・帯の左のラベルをクリック → 帯を選ぶ／帯の間の「＋」→ 帯を足す／空の区画のボタン → 表・文章・板の表を入れる
   ・セルをクリックで選ぶ（ドラッグ・Shift で範囲）、ダブルクリック／Enter／そのまま打つで入力（Enter で下へ、Tab で右へ）
   ・列の境界・行の下端・区画の境界をドラッグ（ドラッグ中は mm と、下の帯が一緒に動くのが見える）
   状態と操作は block-state.js。ここは描画とマウス・キーボードの受け付けだけ
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const UI = CDB.ui;
  const { el, icon } = U;
  const BD = () => CDB.blockDoc;
  const SP = () => CDB.sheetPages;
  const RR = () => CDB.reportRender;

  const EDGE = 5; // 境界の「つかめる幅」（px）
  const GUTTER = 92; // 帯のラベルを置く左の余白（px）

  /**
   * @param {{st:object, host:HTMLElement, root:HTMLElement, getPreset:Function, getZoom:Function, varName:(colId:string)=>string}} api
   */
  function create(api) {
    const st = api.st;
    const K = () => SP().PX_PER_MM;
    const P = () => api.getPreset();
    const offs = [];
    const docOn = (type, fn, opt) => { document.addEventListener(type, fn, opt); offs.push(() => document.removeEventListener(type, fn, opt)); };
    let paperEl = null;
    let pop = null;
    let drag = null;
    let guides = []; // ドラッグ中の整列の案内線（mm。{x} か {y}）
    let editing = null;
    let tip = null;

    /** 選んだセルに文字を打ち始めたとき：標準は今の文字の末尾に足す（置き換えは設定で。Excel と同じ） */
    const typeReplace = () => { try { return localStorage.getItem('cdb.block.typeReplace') === '1'; } catch (_) { return false; } };
    const textOfCell = (tableId, r, c) => { const f = BD().findTable(P().blocks, tableId); const cell = f && f.table.cells && f.table.cells[BD().key(r, c)]; return cell && cell.t !== undefined ? String(cell.t) : ''; };
    const typing = (t) => t && (['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName) || t.isContentEditable);

    /* ---------- ポップアップ（同時に 1 つだけ） ---------- */
    function closePop() { if (pop) { pop.remove(); pop = null; } }
    function openPop(node, x, y) {
      closePop();
      pop = node;
      pop.classList.add('bk-pop');
      pop.style.left = x + 'px';
      pop.style.top = y + 'px';
      api.root.appendChild(pop);
      const box = api.root.getBoundingClientRect();
      const m = pop.getBoundingClientRect();
      if (m.right > box.right) pop.style.left = Math.max(0, x - (m.right - box.right) - 8) + 'px';
      if (m.bottom > box.bottom) pop.style.top = Math.max(0, y - (m.bottom - box.bottom) - 8) + 'px';
    }
    const at = (e) => { const b = api.root.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };

    /** 帯を足す候補（区画の数と比率） */
    const BAND_CHOICES = [
      ['全幅', [1], '▭'], ['2 区画（50:50）', [50, 50], '▭▭'], ['2 区画（60:40）', [60, 40], '▭▭'], ['2 区画（70:30）', [70, 30], '▭▭'], ['3 区画', [1, 1, 1], '▭▭▭']
    ];
    function addBandMenu(e, section, index) {
      e.stopPropagation();
      const stick = el('input', { type: 'checkbox' });
      stick.addEventListener('click', (ev) => ev.stopPropagation());
      const brk = el('input', { type: 'checkbox' });
      brk.addEventListener('click', (ev) => ev.stopPropagation());
      const m = el('div', { class: 'menu', role: 'menu' }, [el('div', { class: 'menu-label', text: '帯を足す' })]
        .concat(index > 0 && section === 'bands' ? [el('label', { class: 'check', style: 'padding:2px 10px', title: '上の帯との間の余白を 0 にして、ぴったりくっつけます' }, [stick, '上の帯にくっつける'])] : [])
        .concat(index > 0 && section === 'bands' ? [el('label', { class: 'check', style: 'padding:2px 10px', title: 'この帯から新しいページにします（改ページ）' }, [brk, '新しいページから始める'])] : [])
        .concat(BAND_CHOICES.map(([label, ratios, mark]) =>
          el('button', { type: 'button', onclick: () => { closePop(); st.ops.addBand(section, index, ratios, { stick: stick.checked, pageBreak: brk.checked }); } }, [el('span', { class: 'bk-mark', text: mark }), label]))));
      const [x, y] = at(e);
      openPop(m, x, y);
    }

    /**
     * 表の行数・列数を選ぶ小窓（マス目をなぞって選ぶ／数字で入れる）。選んだら cb(行数, 列数)
     */
    function pickTable(e, cb) {
      e.stopPropagation();
      const MAXR = 10;
      const MAXC = 10;
      const info = el('div', { class: 'bk-pick-info', text: '3 行 × 3 列' });
      const cells = [];
      const grid = el('div', { class: 'bk-pick-grid', style: `grid-template-columns:repeat(${MAXC}, 18px)` });
      const mark = (r, c) => { cells.forEach((x) => x.el.classList.toggle('is-on', x.r <= r && x.c <= c)); info.textContent = `${r} 行 × ${c} 列`; rowIn.value = String(r); colIn.value = String(c); };
      const rowIn = el('input', { class: 'input rp-num', type: 'number', min: 1, max: 30, value: '3', 'aria-label': '行数' });
      const colIn = el('input', { class: 'input rp-num', type: 'number', min: 1, max: 20, value: '3', 'aria-label': '列数' });
      const go = () => { const r = Math.max(1, Math.min(30, Number(rowIn.value) || 3)); const c = Math.max(1, Math.min(20, Number(colIn.value) || 3)); closePop(); cb(r, c); };
      for (let r = 1; r <= MAXR; r++) for (let c = 1; c <= MAXC; c++) {
        const cell = el('span', { class: 'bk-pick-cell', 'data-r': r, 'data-c': c });
        cell.addEventListener('mouseenter', () => mark(r, c));
        cell.addEventListener('click', (ev) => { ev.stopPropagation(); closePop(); cb(r, c); });
        cells.push({ el: cell, r, c });
        grid.appendChild(cell);
      }
      [rowIn, colIn].forEach((i) => { i.addEventListener('click', (ev) => ev.stopPropagation()); i.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); go(); } }); });
      const box = el('div', { class: 'menu bk-pick', role: 'dialog', 'aria-label': '表の行数・列数' }, [
        el('div', { class: 'menu-label', text: '表の大きさ（マス目をなぞって選ぶ）' }), grid, info,
        el('div', { class: 'row' }, [el('label', { class: 'rp-numbox' }, ['行', rowIn]), el('label', { class: 'rp-numbox' }, ['列', colIn]), el('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: (ev) => { ev.stopPropagation(); go(); } }, [icon('fa-table-cells'), '入れる'])])
      ]);
      mark(3, 3);
      const [x, y] = at(e);
      openPop(box, x, y);
    }

    /* ---------- 描画 ---------- */
    function textNodes(text) {
      const frag = document.createDocumentFragment();
      if (/^\s*[=＝]/.test(text)) { frag.append(el('span', { class: 'bk-formula', text })); return frag; }
      String(text).split(/([{｛][^{}｛｝]+[}｝])/).forEach((p) => {
        if (!p) return;
        frag.append(/^[{｛][^{}｛｝]+[}｝]$/.test(p) ? el('span', { class: 'bk-var', text: p }) : document.createTextNode(p));
      });
      return frag;
    }

    function tableEl(t, zonePx) {
      const mergeAt = new Map();
      const covered = new Set();
      t.merges.forEach((m) => {
        mergeAt.set(BD().key(m.r0, m.c0), m);
        for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) covered.add(BD().key(r, c));
      });
      const colPx = t.colW.map((f) => f * zonePx);
      const table = el('table', { class: 'bk-t', style: `width:${zonePx}px` }, [el('colgroup', {}, colPx.map((w) => el('col', { style: `width:${w}px` })))]);
      const tbody = el('tbody');
      table.appendChild(tbody);
      for (let r = 0; r < t.nRows; r++) {
        const tr = el('tr', { style: `height:${t.rowH[r]}px` });
        for (let c = 0; c < t.nCols; c++) {
          const k = BD().key(r, c);
          if (covered.has(k)) continue;
          const m = mergeAt.get(k);
          const cell = t.cells[k] || {};
          const td = el('td', {
            'data-r': r, 'data-c': c, rowspan: m && m.r1 > m.r0 ? m.r1 - m.r0 + 1 : null, colspan: m && m.c1 > m.c0 ? m.c1 - m.c0 + 1 : null,
            style: RR().cellCss(cell.s || {}) + (cell.s && cell.s.wrap ? '' : ';white-space:pre')
          });
          if (t.rep && r >= t.rep.top && r <= t.rep.bottom) td.classList.add('is-repcell');
          if (cell.t) td.appendChild(textNodes(String(cell.t)));
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      return table;
    }

    function emptyZone(band, zone, section) {
      const B = P().blocks;
      const full = band.zones.length === 1 && section === 'bands' && !BD().repTable(B);
      const btn = (ic, text, fn, title) => el('button', { class: 'btn btn-sm', type: 'button', title, onclick: (e) => { e.stopPropagation(); fn(e); } }, [icon(ic), text]);
      const box = el('div', { class: 'bk-empty' + (lastZone === zone.id ? ' bk-drop' : ''), tabindex: '0', title: 'クリックして Ctrl+V で画像を貼り付け／画像ファイルをドラッグ＆ドロップ', onclick: () => { lastZone = zone.id; paintDrop(); } }, [
        el('span', { class: 'muted', text: '空の区画（画像は Ctrl+V・ドラッグ＆ドロップでも入ります）' }),
        el('div', { class: 'row wrap' }, [
          btn('fa-table-cells', '表', (e) => pickTable(e, (r, c) => st.ops.addTable(zone.id, r, c)), '行数・列数を選んで表を入れます（後から増減もできます）'),
          btn('fa-font', '文章', () => st.ops.addText(zone.id), '文字と {変数} を自由に書く 1 マスの枠です'),
          btn('fa-image', '画像', () => UI.blockImage.choose((img) => st.ops.addImage(zone.id, img)), '画像ファイルを選んで入れます（ロゴ・写真など。区画の幅に合わせます）'),
          full ? btn('fa-grip-lines', '板の表', () => st.ops.addPlateTable(zone.id), '板の数だけ 1 行ずつ繰り返す表です（全幅の帯に 1 つ）') : null
        ].filter(Boolean))
      ]);
      return box;
    }
    /** 画像の貼り付け先にしている空の区画（クリックで選ぶ） */
    let lastZone = null;
    const paintDrop = () => { if (paperEl) paperEl.querySelectorAll('.bk-empty').forEach((b) => b.classList.toggle('bk-drop', b.closest('.bk-zone') && b.closest('.bk-zone').dataset.zone === lastZone)); };

    function bandEl(band, section, no) {
      const B = P().blocks;
      const widths = BD().zoneWidthsMm(B.page, band).map((mm) => mm * K());
      const sel = st.sel();
      const gapsPx = BD().zoneGapsMm(band).map((g) => g * K());
      const gapPx = (gapsPx[gapsPx.length - 1] !== undefined ? gapsPx[gapsPx.length - 1] : BD().ZONE_GAP_MM * K()); // 右の空きの前に入れる間隔（いちばん右の間隔と同じ）
      const label = section === 'header' ? `ヘッダー${no}` : section === 'footer' ? `フッター${no}` : `帯${no}`;
      const sum = band.zones.length > 1 ? band.zones.map((z) => Math.round(z.w)).join(':') : '全幅';
      const lab = el('button', { class: 'bk-bl', type: 'button', title: `${label}（クリックで帯を選ぶ）`, onclick: (e) => { e.stopPropagation(); st.selectBand(band.id); } }, [el('b', { text: label }), el('span', { text: sum })]);
      const zones = el('div', { class: 'bk-zones', style: `gap:0;${band.h > 0 ? `min-height:${band.h}px` : ''}` });
      band.zones.forEach((z, i) => {
        const al = z.align || band.align;
        const ze = el('div', { class: 'bk-zone', 'data-zone': z.id, style: `width:${widths[i]}px;align-self:${{ top: 'flex-start', middle: 'center', bottom: 'flex-end', stretch: 'stretch' }[al] || 'flex-start'}` });
        if (al === 'stretch') ze.classList.add('is-stretch');
        if (z.block && BD().isImage(z.block)) {
          const sz = BD().imageSizeMm(z.block, widths[i] / K());
          const blk = el('div', { class: 'bk-blk bk-imgblk', 'data-table': z.block.id, style: `width:${widths[i]}px` }, [
            el('button', { class: 'bk-tag', type: 'button', title: 'クリックで画像を選ぶ', onclick: (e) => { e.stopPropagation(); st.selectTable(z.block.id); } }, [icon('fa-image'), z.block.name || '画像']),
            el('img', { src: z.block.src, alt: z.block.name || '', style: `width:${sz.w * K()}px;margin-left:${sz.off * K()}px`, draggable: 'false' })
          ]);
          blk.addEventListener('mousedown', (e) => { if (e.button === 0) { e.stopPropagation(); st.selectTable(z.block.id); } });
          ze.appendChild(blk);
        } else if (z.block) {
          const blk = el('div', { class: 'bk-blk', 'data-table': z.block.id }, [
            el('button', { class: 'bk-tag', type: 'button', title: 'クリックで表を選ぶ', onclick: (e) => { e.stopPropagation(); st.selectTable(z.block.id); } }, [z.block.rep ? icon('fa-grip-lines') : null, z.block.name || '表']),
            tableEl(z.block, widths[i])
          ]);
          ze.appendChild(blk);
        } else ze.appendChild(emptyZone(band, z, section));
        zones.appendChild(ze);
        if (i < band.zones.length - 1) zones.appendChild(el('span', { class: 'bk-grip', 'data-band': band.id, 'data-idx': i, style: `width:${gapsPx[i]}px`, title: `区画の境界（ドラッグで幅を変える）／あいだの間隔 ${Math.round(gapsPx[i] / K() * 10) / 10}mm（ダブルクリックで間隔を変える）` }));
      });
      if (band.used > 0 && band.used < 1) { // 右に空きがあるとき：ここに区画を足すかどうかは、ユーザーが決める
        const total = BD().printWidthMm(B.page) * K();
        const usedPx = widths.reduce((a, b) => a + b, 0) + gapsPx.reduce((a, b) => a + b, 0);
        const freePx = total - usedPx - gapPx;
        if (freePx > 40 && band.zones.length < BD().MAX_ZONES) {
          zones.appendChild(el('div', { class: 'bk-free', style: `width:${freePx}px;margin-left:${gapPx}px`, title: '右の空き' }, [
            el('button', { class: 'btn btn-sm', type: 'button', title: 'この空きに、空の区画を足します（足さなければ、空いたままです）', onclick: (ev) => { ev.stopPropagation(); st.ops.addZoneRight(band.id); } }, [icon('fa-square-plus'), '区画を足す'])
          ]));
        }
      }
      // 帯と帯の間隔：出力でも同じ大きさで空く部分。斜線で見せ、押すと「下の余白」を直せる（0 のときは見せない＝出力もぴったりくっつく）
      const gapMark = band.gap > 0 ? el('button', { class: 'bk-gapmark', type: 'button', style: `height:${band.gap * K()}px`, title: `次の帯との間隔 ${band.gap}mm（印刷・Excel でもこのとおり空きます）。押すと、帯を選んで「下の余白」を直せます`, onclick: (ev) => { ev.stopPropagation(); st.selectBand(band.id); requestAnimationFrame(() => { const f = [...document.querySelectorAll('.rp-numbox')].find((x) => /下の余白/.test(x.textContent)); const i = f && f.querySelector('input'); if (i) { i.focus(); i.select(); } }); } }, [el('span', { text: `間隔 ${band.gap}mm` })]) : null;
      const e = el('div', { class: 'bk-band' + (sel.kind === 'band' && sel.bandId === band.id ? ' is-sel' : ''), 'data-band': band.id, style: band.gap > 0 ? `margin-bottom:${band.gap * K()}px` : '' }, [lab, zones, gapMark]);
      return e;
    }

    function section(sec, title) {
      const B = P().blocks;
      const list = B[sec];
      const box = el('div', { class: 'bk-sec bk-sec-' + sec });
      if (sec !== 'bands') box.appendChild(el('div', { class: 'bk-sec-cap', text: title }));
      const strip = (i) => el('button', { class: 'bk-ins', type: 'button', title: '帯を足す', onclick: (e) => addBandMenu(e, sec, i) }, [el('span', {}, [icon('fa-plus'), ' 帯を追加'])]);
      if (!list.length) {
        box.appendChild(el('button', { class: 'btn btn-sm bk-add-first', type: 'button', onclick: (e) => addBandMenu(e, sec, 0) }, [icon('fa-plus'), sec === 'header' ? 'ヘッダーを足す（毎ページの上端）' : sec === 'footer' ? 'フッターを足す（毎ページの下端）' : '帯を足す']));
        return box;
      }
      list.forEach((b, i) => {
        box.appendChild(strip(i));
        if (b.breakBefore) box.appendChild(el('div', { class: 'bk-break', title: 'ここで改ページ（次の帯から新しいページ）' }, [icon('fa-scissors'), '改ページ']));
        box.appendChild(bandEl(b, sec, i + 1));
      });
      box.appendChild(strip(list.length));
      return box;
    }

    /* ---------- 自由に置く物（テキストボックス・図形・表・画像） ---------- */
    const HANDLES = { nw: [0, 0], n: [50, 0], ne: [100, 0], e: [100, 50], se: [100, 100], s: [50, 100], sw: [0, 100], w: [0, 50] };
    const roundMm = (v) => Math.round(v * 10) / 10;

    function floatEl(f, idx) {
      const k = K();
      const sz = BD().floatSizeMm(f);
      const wpx = sz.w * k;
      const hpx = sz.h * k;
      const node = el('div', { class: 'bk-float bk-f-' + f.kind, 'data-float': f.id, style: `width:${wpx}px;height:${Math.max(hpx, f.kind === 'shape' ? 10 : 0)}px;z-index:${10 + idx}` });
      if (f.kind === 'text' || f.kind === 'table') node.appendChild(el('div', { class: 'bk-blk bk-fblk', 'data-table': f.block.id }, [tableEl(f.block, wpx)]));
      else if (f.kind === 'image') node.appendChild(el('img', { class: 'bk-fbody', src: f.block.src, alt: '', draggable: 'false', style: `width:${wpx}px;height:${hpx}px` }));
      else { const body = el('div', { class: 'bk-fbody', style: 'position:absolute;inset:0' }); body.appendChild(CDB.reportFloats.shapeSvg(f, wpx, hpx)); node.appendChild(body); }
      ['n', 'e', 's', 'w'].forEach((side) => node.appendChild(el('span', { class: 'bk-fedge bk-fedge-' + side })));
      const label = { text: 'テキストボックス', shape: '図形', table: '表', image: '画像' }[f.kind];
      node.appendChild(el('button', { class: 'bk-ftag', type: 'button', title: 'ドラッグで移動／クリックで枠を選ぶ' }, [icon({ text: 'fa-font', shape: 'fa-shapes', table: 'fa-table-cells', image: 'fa-image' }[f.kind]), f.anchor === 'band' ? `${label}（帯に固定）` : label]));
      return node;
    }

    /** つまみ・選択の表示を、今の選択に合わせる（描き直さない） */
    function syncFloats() {
      if (!paperEl) return;
      const own = st.floatSel();
      const picked = st.sel().kind === 'float';
      paperEl.querySelectorAll('.bk-float').forEach((n) => {
        const on = !!own && own.id === n.dataset.float;
        n.classList.toggle('is-sel', on && picked);
        n.classList.toggle('is-cur', on);
        n.querySelectorAll('.bk-fh').forEach((h) => h.remove());
        if (on && picked) Object.keys(HANDLES).forEach((h) => n.appendChild(el('span', { class: 'bk-fh', 'data-h': h, style: `left:${HANDLES[h][0]}%;top:${HANDLES[h][1]}%` })));
      });
    }

    function drawGuides() {
      if (!paperEl) return;
      paperEl.querySelectorAll('.bk-guide').forEach((g) => g.remove());
      const B = P().blocks;
      const m = B.page.margin;
      const k = K();
      guides.forEach((g) => paperEl.appendChild(el('span', { class: 'bk-guide', style: g.x !== undefined ? `left:${(m.l + g.x) * k}px;top:0;bottom:0;width:0;border-left:1px solid #e0457b` : `top:${(m.t + g.y) * k}px;left:0;right:0;height:0;border-top:1px solid #e0457b` })));
    }

    /** 用紙を描く。container に wrap を入れて返す */
    function render(container) {
      closePop();
      const B = P().blocks;
      const m = B.page.margin;
      const [pw, ph] = SP().paperMm(B.page);
      const k = K();
      paperEl = el('div', { class: 'bk-paper', style: `width:${pw * k}px;min-height:${ph * k}px;padding:${m.t * k}px ${m.r * k}px ${m.b * k}px ${m.l * k}px` });
      paperEl.append(section('header', 'ヘッダー（毎ページの上端）'), section('bands', ''), section('footer', 'フッター（毎ページの下端）'));
      // 自由に置く物（後ろのものほど手前）。ページ基準は用紙の印刷範囲の左上から、帯基準は帯の左上から
      BD().floatsOf(B).forEach((f, i) => {
        const node = floatEl(f, i);
        const bandNode = f.anchor === 'band' && f.bandId ? paperEl.querySelector(`.bk-band[data-band="${f.bandId}"]`) : null;
        if (bandNode) { node.style.left = f.x * k + 'px'; node.style.top = f.y * k + 'px'; bandNode.appendChild(node); }
        else { node.style.left = (m.l + f.x) * k + 'px'; node.style.top = (m.t + f.y) * k + 'px'; paperEl.appendChild(node); }
      });
      // 印刷できる範囲の枠（余白の内側）
      paperEl.appendChild(el('div', { class: 'bk-printbox', style: `left:${m.l * k}px;top:${m.t * k}px;right:${m.r * k}px;bottom:${m.b * k}px`, title: '印刷できる範囲（用紙 − 余白）' }));
      const wrap = el('div', { class: 'bk-wrap', style: `padding-left:${GUTTER}px` }, [paperEl]);
      wrap.dataset.w = String(Math.round(pw * k + GUTTER + 24));
      wrap.dataset.h = String(Math.round(ph * k + 24));
      container.appendChild(wrap);
      syncFloats();
      drawGuides();
      updateHint();
      // 板の表の行の札（行の位置を測ってから、表の左に置く。セルの中に置くとはみ出しが切れるため）
      paperEl.querySelectorAll('.bk-blk').forEach((blk) => {
        const td = blk.querySelector('td.is-repcell');
        if (td) blk.appendChild(el('span', { class: 'bk-rep', style: `top:${td.offsetTop + 2}px`, text: '繰り返し' }));
      });
      paint();
      return wrap;
    }

    /* ---------- 選択の表示 ---------- */
    function paint() {
      if (!paperEl) return;
      const s = st.sel();
      paperEl.querySelectorAll('.bk-band').forEach((b) => b.classList.toggle('is-sel', s.kind === 'band' && b.dataset.band === s.bandId));
      paperEl.querySelectorAll('.bk-blk:not(.bk-fblk)').forEach((b) => {
        b.classList.toggle('is-sel', s.kind === 'table' && b.dataset.table === s.tableId);
        b.classList.toggle('is-cur', (s.kind === 'cell' || s.kind === 'table') && b.dataset.table === s.tableId);
      });
      paperEl.querySelectorAll('.bk-blk td').forEach((td) => {
        td.className = td.className.replace(/\bbk-s\w*/g, '').trim();
        const blk = td.closest('.bk-blk');
        if (s.kind !== 'cell' || blk.dataset.table !== s.tableId) return;
        const r = Number(td.dataset.r);
        const c = Number(td.dataset.c);
        const r1 = r + (Number(td.getAttribute('rowspan')) || 1) - 1;
        const c1 = c + (Number(td.getAttribute('colspan')) || 1) - 1;
        const inside = !(r1 < s.r0 || r > s.r1 || c1 < s.c0 || c > s.c1);
        if (!inside) return;
        td.classList.add('bk-sel');
        if (r <= s.ar && s.ar <= r1 && c <= s.ac && s.ac <= c1) td.classList.add('bk-sa');
        if (r <= s.r0) td.classList.add('bk-st');
        if (r1 >= s.r1) td.classList.add('bk-sb');
        if (c <= s.c0) td.classList.add('bk-sl');
        if (c1 >= s.c1) td.classList.add('bk-sr');
      });
    }
    /** 選んだセルのすぐ下に、今できる操作を小さく出す（選択中／入力中の違いが分かるように） */
    function updateHint() {
      if (!paperEl) return;
      paperEl.querySelectorAll('.bk-cellhint').forEach((h) => h.remove());
      const s = st.sel();
      if (s.kind !== 'cell' || drag) return;
      const td = tdOf(s.tableId, s.ar, s.ac);
      if (!td) return;
      const z = api.getZoom() || 1;
      const pr = paperEl.getBoundingClientRect();
      const tr = td.getBoundingClientRect();
      const has = textOfCell(s.tableId, s.ar, s.ac) !== '';
      const text = editing ? '入力中：Enter で確定・Shift+Enter で改行・Esc で取り消し・Tab で次のセル　／　{ で変数・{= で計算式・| で書式の候補' : has ? '選択中：もう一度クリック／Enter／ダブルクリックで編集（打つと末尾に追記・Delete で消去）' : '選択中：そのまま打つ／もう一度クリック／Enter で入力';
      paperEl.appendChild(el('span', { class: 'bk-cellhint' + (editing ? ' is-editing' : ''), style: `left:${(tr.left - pr.left) / z}px;top:${(tr.bottom - pr.top) / z + 3}px`, text }));
    }
    st.onChange(() => { paint(); syncFloats(); updateHint(); });

    const tdOf = (tableId, r, c) => paperEl && paperEl.querySelector(`.bk-blk[data-table="${tableId}"] td[data-r="${r}"][data-c="${c}"]`);

    /* ---------- 入力中の候補（{ → 列・式 ／ | → 書式 ／ {= → 列・関数）：覚えなくても、選べば入る ---------- */
    const PROPS = [
      { key: '2', label: '小数 2 桁', desc: '{板厚|2} ＝ 小数 2 桁（0〜4 を選べます。四捨五入）', ins: '2' },
      { key: '0', label: '小数 0 桁（整数）', desc: '{金額|0}', ins: '0' },
      { key: '1', label: '小数 1 桁', desc: '{幅|1}', ins: '1' },
      { key: '3', label: '小数 3 桁', desc: '{長さ|3}', ins: '3' },
      { key: '丸=A', label: '丸め規則 A（偶数丸め）', desc: '桁と一緒に：{板厚|桁=2|丸=A}。元の値から丸めます', ins: '丸=A' },
      { key: '丸=B', label: '丸め規則 B（四捨五入）', desc: '桁と一緒に：{板厚|桁=2|丸=B}。元の値から丸めます', ins: '丸=B' },
      { key: '丸=切上', label: '切り上げ', desc: '桁と一緒に：{板厚|桁=2|丸=切上}', ins: '丸=切上' },
      { key: '丸=切捨', label: '切り捨て', desc: '桁と一緒に：{板厚|桁=2|丸=切捨}', ins: '丸=切捨' },
      { key: '区切り', label: '桁区切り（1,234）', desc: '桁と一緒に：{金額|0|区切り}', ins: '区切り' },
      { key: '前=', label: '前の文字', desc: '値があるときだけ付く：{幅|前=約}', ins: '前=' },
      { key: '後=', label: '後ろの文字（単位）', desc: '値があるときだけ付く：{幅|後=mm}', ins: '後=' },
      { key: '空=', label: '値が空のときの文字', desc: '{幅|空=－}', ins: '空=' },
      { key: '埋=', label: '0 埋め（整数の桁数）', desc: '{板番号|埋=3} → 007', ins: '埋=' }
    ];
    let sug = null; // { box, items, idx, apply(item), ctx }

    /** カーソルのまわりの文脈：{ の中か・どこまで打ったか */
    function suggestContext(value, pos) {
      const before = value.slice(0, pos);
      const open = Math.max(before.lastIndexOf('{'), before.lastIndexOf('｛'));
      if (open < 0) return null;
      const close = Math.max(before.lastIndexOf('}'), before.lastIndexOf('｝'));
      if (close > open) return null;
      const inner = before.slice(open + 1);
      const parts = CDB.blockCompile.splitTop(inner);
      const isExpr = /^[=＝]/.test(parts[0].trim());
      const last = parts[parts.length - 1];
      const start = pos - last.length; // 置き換える範囲の始め
      if (parts.length > 1) return { mode: 'prop', word: last.trim(), start, open };
      if (!isExpr) return { mode: 'name', word: last, start, open };
      // 式：[ の途中なら列、英字の途中なら関数
      const br = last.match(/\[([^\]]*)$/);
      if (br) return { mode: 'col', word: br[1], start: pos - br[1].length, open };
      const fn = last.match(/([A-Za-z_][A-Za-z0-9_.]*)$/);
      if (fn) return { mode: 'fn', word: fn[1], start: pos - fn[1].length, open };
      return { mode: 'expr', word: '', start: pos, open };
    }

    function suggestItems(ctx) {
      const norm = (x) => CDB.util.normKey(x);
      const w = norm(ctx.word);
      const cols = (api.getColumns ? api.getColumns() : []).filter((c) => c.side === 'master' || c.side === 'plate');
      if (ctx.mode === 'name') {
        const out = [];
        if (!w || '=式'.startsWith(ctx.word.trim()) || ctx.word.trim().startsWith('=')) out.push({ label: '{=式}', desc: '計算式を入れる（例：{=[板厚]-[公差]|桁=2}）', ins: '=', after: '', kind: 'expr' });
        cols.forEach((c) => { const n = api.varName(c.id); if (!w || norm(n).includes(w)) out.push({ label: n, desc: c.side === 'plate' ? '板ごとのデータ' : 'ロット・元データ', ins: n, after: '}' }); });
        Object.keys(CDB.blockCompile.VARS).forEach((n) => { if (!w || norm(n).includes(w)) out.push({ label: n, desc: 'ツールの値', ins: n, after: '}' }); });
        const tpl = [
          { label: '{=IF(ROWNO()=1,"固定値","")}', desc: '板の表：1 行目だけ固定値、以降は空欄', ins: '=IF(ROWNO()=1,"固定値","")', after: '}' },
          { label: '{=IF(ROWNO()=1,"固定値",[列名])}', desc: '板の表：1 行目だけ固定値、以降はデータの値', ins: '=IF(ROWNO()=1,"固定値",[列名])', after: '}' }
        ].filter((x) => w && /(1行目|行|固定|IF|ROW|最初)/i.test(ctx.word.trim()));
        return tpl.concat(out.slice(0, 12));
      }
      if (ctx.mode === 'prop') return PROPS.filter((p) => !w || p.key.startsWith(ctx.word.trim()) || norm(p.label).includes(w)).map((p) => Object.assign({ after: p.ins.endsWith('=') ? '' : '}' }, p));
      if (ctx.mode === 'col') return cols.filter((c) => !w || norm(api.varName(c.id)).includes(w)).slice(0, 12).map((c) => ({ label: `[${api.varName(c.id)}]`, desc: c.side === 'plate' ? '板ごとのデータ' : 'ロット・元データ', ins: api.varName(c.id) + ']', after: '' }));
      if (ctx.mode === 'fn') return CDB.formula.list().filter((f) => f.name.startsWith(ctx.word.toUpperCase())).slice(0, 10).map((f) => ({ label: f.name + '(', desc: `${f.desc}　例：${f.example}`, ins: f.name + '(', after: '' }));
      return [];
    }

    const SUG_HELP = {
      name: '候補から選ぶ（Tab／Enter）。{=式} で計算式、{名前|2} で桁',
      prop: '書式を選ぶ（Tab／Enter）。| で区切って複数：{金額|0|区切り|後=円}',
      col: '列を選ぶ（Tab／Enter）。式の中の列は [列名]',
      fn: '関数を選ぶ（Tab／Enter）',
      expr: '式：[列名]・数値・関数・C3（同じ表のセル）。| のあとに桁などを指定'
    };

    function closeSuggest() { if (sug) { sug.box.remove(); sug = null; } }

    function updateSuggest() {
      if (!editing || editing.done) { closeSuggest(); return; }
      const ta = editing.ta;
      if (ta.selectionStart !== ta.selectionEnd) { closeSuggest(); return; }
      const ctx = suggestContext(ta.value, ta.selectionStart);
      if (!ctx) { closeSuggest(); return; }
      const items = suggestItems(ctx);
      if (!items.length && ctx.mode !== 'expr') { closeSuggest(); return; }
      const prevIdx = sug && sug.idx < items.length ? sug.idx : 0;
      closeSuggest();
      const box = el('div', { class: 'bk-suggest', role: 'listbox', 'aria-label': '入力の候補' });
      items.forEach((it, i) => {
        const row = el('div', { class: 'bk-sug-item' + (i === prevIdx ? ' is-on' : ''), role: 'option' }, [el('b', { text: it.label }), el('span', { class: 'muted', text: it.desc })]);
        row.addEventListener('mousedown', (e) => { e.preventDefault(); applySuggest(it, ctx); }); // 押してもフォーカスが入力欄から外れない
        box.appendChild(row);
      });
      box.appendChild(el('div', { class: 'bk-sug-help', text: SUG_HELP[ctx.mode] }));
      const tr = editing.td.getBoundingClientRect();
      const rb = api.root.getBoundingClientRect();
      box.style.left = Math.max(0, tr.left - rb.left) + 'px';
      box.style.top = tr.bottom - rb.top + 4 + 'px';
      api.root.appendChild(box);
      const m = box.getBoundingClientRect();
      if (m.right > rb.right) box.style.left = Math.max(0, rb.right - rb.left - m.width - 8) + 'px';
      if (m.bottom > rb.bottom) box.style.top = Math.max(0, tr.top - rb.top - m.height - 4) + 'px';
      sug = { box, items, idx: prevIdx, ctx };
    }

    function applySuggest(it, ctx) {
      const ta = editing.ta;
      const v = ta.value;
      const pos = ta.selectionStart;
      let tail = it.after || '';
      if (tail === '}' && /^[}｝]/.test(v.slice(pos))) tail = ''; // すでに閉じていれば足さない
      const text = it.ins + tail;
      ta.value = v.slice(0, ctx.start) + text + v.slice(pos);
      const caret = ctx.start + it.ins.length + (it.kind === 'expr' ? 0 : tail.length);
      ta.setSelectionRange(caret, caret);
      if (it.kind === 'expr') { // {=} の形にして、カーソルを = のあとへ
        if (!/^[}｝]/.test(ta.value.slice(caret))) ta.value = ta.value.slice(0, caret) + '}' + ta.value.slice(caret);
        ta.setSelectionRange(caret, caret);
      }
      ta.focus();
      updateSuggest();
    }

    function suggestKey(e) {
      if (!sug) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sug.idx = (sug.idx + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
        Array.from(sug.box.querySelectorAll('.bk-sug-item')).forEach((r, i) => r.classList.toggle('is-on', i === sug.idx));
        return true;
      }
      if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey && !e.altKey && sug.items.length) { e.preventDefault(); applySuggest(sug.items[sug.idx], sug.ctx); return true; }
      if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); return true; }
      return false;
    }

    /* ---------- 入力（セルの中） ---------- */
    function startEdit(td, first) {
      const blk = td.closest('.bk-blk');
      if (!blk) return;
      const tableId = blk.dataset.table;
      const r = Number(td.dataset.r);
      const c = Number(td.dataset.c);
      const t = BD().findTable(P().blocks, tableId).table;
      const cell = t.cells[BD().key(r, c)] || {};
      const ta = el('textarea', { class: 'bk-edit', 'aria-label': `${U.cellAddr(r, c)} の中身`, rows: 1, spellcheck: 'false' });
      ta.value = first !== undefined ? first : cell.t === undefined ? '' : String(cell.t);
      ta.style.minHeight = td.offsetHeight + 'px';
      td.classList.add('is-editing');
      td.appendChild(ta);
      // 狭いセルでも式が読めるよう、入力欄はセルより広げ（最低 280px）、中身に合わせて高さを伸ばす。右にはみ出すときは左へ寄せる
      const fit = () => {
        ta.style.height = 'auto';
        ta.style.height = Math.max(td.offsetHeight, ta.scrollHeight + 4) + 'px';
        ta.style.left = '-2px';
        const rb = api.root.getBoundingClientRect();
        const over = ta.getBoundingClientRect().right - (rb.right - 8);
        if (over > 0) ta.style.left = Math.max(-(ta.getBoundingClientRect().left - rb.left - 4), -2 - over / (api.getZoom() || 1)) + 'px';
      };
      editing = { td, ta, tableId, r, c, done: false };
      ta.focus();
      updateHint();
      updateSuggest();
      ta.setSelectionRange(ta.value.length, ta.value.length); // 中身は選ばず、末尾にカーソル（途中に貼り付けても、もとの文字が消えない）
      const finish = (commit, dr, dc) => {
        if (!editing || editing.done) return;
        editing.done = true;
        closeSuggest();
        const v = ta.value;
        editing = null;
        td.classList.remove('is-editing');
        if (commit && v !== (cell.t === undefined ? '' : String(cell.t))) st.ops.setText(tableId, r, c, v);
        else ta.remove();
        td.classList.remove('is-editing');
        if (dr || dc) st.move(dr, dc, false);
        api.host.focus({ preventScroll: true });
        updateHint();
      };
      ta.addEventListener('input', () => { fit(); updateSuggest(); });
      fit();
      ta.addEventListener('click', updateSuggest);
      ta.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateSuggest(); });
      ta.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.isComposing) return;
        if (suggestKey(e)) return;
        if (e.key === 'Enter' && !e.shiftKey && !e.altKey) { e.preventDefault(); finish(true, 1, 0); }
        else if (e.key === 'Enter' && e.altKey) { e.preventDefault(); const a = ta.selectionStart; ta.setRangeText('\n', a, ta.selectionEnd, 'end'); } // Alt+Enter でも改行（Excel と同じ）。Shift+Enter は入力欄の標準の改行
        else if (e.key === 'Tab') { e.preventDefault(); finish(true, 0, e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        else if ((e.ctrlKey || e.metaKey) && (e.key === ']' || e.key === '[')) { e.preventDefault(); const d = e.key === ']' ? 1 : -1; finish(true, 0, 0); st.ops.indent(d); }
      });
      ta.addEventListener('blur', () => finish(true));
    }

    /* ---------- ドラッグ（列の境界・行の下端・区画の境界） ---------- */
    function showTip(text, x, y) {
      if (!tip) { tip = el('div', { class: 'bk-tip' }); api.root.appendChild(tip); }
      tip.textContent = text;
      const b = api.root.getBoundingClientRect();
      const w = tip.offsetWidth;
      tip.style.left = (x - b.left + 14 + w > b.width - 8 ? x - b.left - 14 - w : x - b.left + 14) + 'px';
      tip.style.top = y - b.top + 14 + 'px';
    }
    const hideTip = () => { if (tip) { tip.remove(); tip = null; } };

    /** つかめる境界（列の右端・行の下端）か */
    function edgeAt(e) {
      const td = e.target.closest && e.target.closest('.bk-blk td');
      if (!td || editing) return null;
      const rc = td.getBoundingClientRect();
      const z = api.getZoom() || 1;
      const blk = td.closest('.bk-blk');
      const f = BD().findTable(P().blocks, blk.dataset.table);
      if (!f) return null;
      const c1 = Number(td.dataset.c) + (Number(td.getAttribute('colspan')) || 1) - 1;
      const r1 = Number(td.dataset.r) + (Number(td.getAttribute('rowspan')) || 1) - 1;
      const edge = EDGE * z;
      if (rc.bottom - e.clientY <= edge) return { kind: 'row', td, tableId: f.table.id, i: r1 };
      if (rc.right - e.clientX <= edge && c1 < f.table.nCols - 1) return { kind: 'col', td, tableId: f.table.id, i: c1 };
      if (rc.right - e.clientX <= edge && !f.float) return { kind: 'zoneright', td, tableId: f.table.id }; // 表の右端 = 区画の右端
      return null;
    }

    /** 今の高さで、1 ページの板の行数がいくつになるか（ドラッグ中の表示用） */
    function capacityNow() {
      try { const res = CDB.blockCompile.compile(P().blocks); return res.table ? SP().capacity(res.doc, res.table) : null; } catch (_) { return null; }
    }

    let raf = 0;
    const redraw = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; api.redraw(); });
    };

    function startDrag(e, d) {
      drag = Object.assign({ before: st.beginLive(), x: e.clientX, y: e.clientY }, d);
      e.preventDefault();
    }

    api.host.addEventListener('mousemove', (e) => {
      if (drag) return;
      const g = e.target.closest && e.target.closest('.bk-grip');
      const ed = g ? null : edgeAt(e);
      api.host.style.cursor = g ? 'col-resize' : ed ? (ed.kind === 'row' ? 'row-resize' : 'col-resize') : '';
    });

    docOn('mousemove', (e) => {
      if (!drag) return;
      const z = api.getZoom() || 1;
      const B = P().blocks;
      if (drag.kind === 'col') {
        const f = BD().findTable(B, drag.tableId);
        if (!f) return;
        const zonePx = (f.float ? f.float.w : BD().zoneWidthsMm(B.page, f.band)[f.band.zones.indexOf(f.zone)]) * K();
        f.table.colW = drag.start.slice();
        BD().moveColEdge(f.table, drag.i, (e.clientX - drag.x) / z / zonePx);
        showTip(`列幅 ${(f.table.colW[drag.i] * zonePx / K()).toFixed(1)}mm`, e.clientX, e.clientY);
      } else if (drag.kind === 'row') {
        const f = BD().findTable(B, drag.tableId);
        if (!f) return;
        f.table.rowH = drag.start.slice();
        BD().setRowHeight(f.table, drag.i, drag.start[drag.i] + (e.clientY - drag.y) / z);
        const cap = f.float ? null : capacityNow();
        const bandBelow = !f.float && BD().allBands(B).length > 1;
        showTip(`高さ ${(f.table.rowH[drag.i] / K()).toFixed(1)}mm${bandBelow ? '　下の帯が一緒に動きます' : ''}${cap !== null && drag.cap !== null ? `（板の行 ${drag.cap} → ${cap}）` : ''}`, e.clientX, e.clientY);
      } else if (drag.kind === 'zonelast') {
        zoneLastDrag(e, z, B);
      } else if (drag.kind === 'fmove' || drag.kind === 'fresize') {
        floatDrag(e, z, B);
      } else if (drag.kind === 'zone') {
        const f = BD().findBand(B, drag.bandId);
        if (!f) return;
        f.band.zones.forEach((zn, i) => { zn.w = drag.start[i]; });
        const px = drag.widths[drag.i] + drag.widths[drag.i + 1];
        BD().moveZoneEdge(B, drag.bandId, drag.i, (e.clientX - drag.x) / z / px);
        showTip(`区画 ${f.band.zones.map((zn) => Math.round(zn.w)).join(' : ')}`, e.clientX, e.clientY);
      }
      redraw();
    });

    /** いちばん右の区画の右端のドラッグ：幅を変えるだけ（右に空きが残る。区画は足さない。足すかどうかは「右に区画を足す」でユーザーが決める） */
    function zoneLastDrag(e, z, B) {
      const f = BD().findBand(B, drag.bandId);
      if (!f) return;
      f.band.zones.forEach((zn, i) => { zn.w = drag.start[i]; });
      if (drag.used0 > 0 && drag.used0 < 1) f.band.used = drag.used0; else delete f.band.used;
      const dx = (e.clientX - drag.x) / z / K();
      const P = BD().setLastZoneWidth(B, drag.bandId, drag.mm[drag.i] + dx, B.page);
      showTip(`区画の幅 ${roundMm(P)}mm`, e.clientX, e.clientY);
    }

    /** 自由に置く物の移動・大きさ変更（1mm に吸着。ページ基準は余白・中央・ほかの物の端にそろう） */
    const SNAP_MM = 1.2;
    function floatDrag(e, z, B) {
      const f = BD().findFloat(B, drag.id);
      if (!f) return;
      const k = K();
      const dx = (e.clientX - drag.x) / z / k;
      const dy = (e.clientY - drag.y) / z / k;
      const st0 = drag.start;
      if (drag.rowH) f.block.rowH = drag.rowH.slice(); // 行の高さは、ドラッグの最初の値から比例させる（積み重ならないように）
      guides = [];
      if (drag.kind === 'fmove') {
        let nx = st0.x + dx;
        let ny = st0.y + dy;
        if (f.anchor === 'page' && !e.altKey) {
          const pw = BD().printWidthMm(B.page);
          const ph = SP().printable(B.page).h / k;
          const xs = [0, pw / 2, pw];
          const ys = [0, ph / 2, ph];
          BD().floatsOf(B).forEach((o) => { if (o.id === f.id || o.anchor !== 'page') return; const sz = BD().floatSizeMm(o); xs.push(o.x, o.x + sz.w / 2, o.x + sz.w); ys.push(o.y, o.y + sz.h / 2, o.y + sz.h); });
          const fit = (v, size, cands, axis) => {
            let best = null;
            [0, size / 2, size].forEach((off) => cands.forEach((c) => { const d = c - (v + off); if (Math.abs(d) <= SNAP_MM && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, c }; }));
            if (best) { guides.push({ [axis]: best.c }); return v + best.d; }
            return Math.round(v);
          };
          const sz = { w: st0.w, h: st0.h };
          nx = fit(nx, sz.w, xs, 'x');
          ny = fit(ny, sz.h, ys, 'y');
        } else { nx = Math.round(nx); ny = Math.round(ny); }
        BD().setFloatGeom(B, f.id, { x: roundMm(nx), y: roundMm(ny) });
        showTip(`位置 ${roundMm(f.x)}, ${roundMm(f.y)} mm`, e.clientX, e.clientY);
        return;
      }
      // 大きさ（つまみ）
      const h = drag.h;
      let { x, y, w } = st0;
      let hh = st0.h;
      if (h.includes('e')) w = st0.w + dx;
      if (h.includes('w')) { w = st0.w - dx; x = st0.x + dx; }
      if (h.includes('s')) hh = st0.h + dy;
      if (h.includes('n')) { hh = st0.h - dy; y = st0.y + dy; }
      w = Math.max(3, Math.round(w));
      if (f.kind === 'image') { // 縦横比を保つ（上下のつまみだけのときは高さから幅を決める）
        if (!/[ew]/.test(h)) w = Math.max(3, Math.round(hh / f.block.ratio));
        hh = w * f.block.ratio;
      } else hh = Math.max(0, Math.round(hh));
      if (h.includes('w')) x = st0.x + st0.w - w;
      const g = { w };
      if (f.kind !== 'image') g.h = hh;
      BD().setFloatGeom(B, f.id, g);
      const real = BD().floatSizeMm(f);
      f.x = roundMm(h.includes('w') ? st0.x + st0.w - real.w : st0.x);
      f.y = roundMm(h.includes('n') ? st0.y + st0.h - real.h : st0.y);
      showTip(`${roundMm(real.w)} × ${roundMm(real.h)} mm`, e.clientX, e.clientY);
    }

    docOn('mouseup', () => {
      if (drag) {
        const d = drag;
        drag = null;
        guides = [];
        hideTip();
        st.endLive(d.before, d.kind === 'col' ? '列幅' : d.kind === 'row' ? '行の高さ' : d.kind === 'fmove' ? '移動' : d.kind === 'fresize' ? '大きさ' : '区画');
        api.redraw();
        return;
      }
      selecting = false;
    });

    /* ---------- マウス ---------- */
    // 区画のあいだ（境界）のダブルクリック：その帯を選び、上のバーの、その間隔の入力欄へ（描き直しで dblclick が届かないので、2 回目の押下で扱う）
    const focusGap = (bandId, idx) => {
      st.selectBand(bandId);
      setTimeout(() => { const i = document.querySelector(`input[data-gap="${idx}"]`) || document.querySelector('input[data-gap]'); if (i) { i.focus(); i.select(); } }, 80);
    };
    let selecting = false;
    api.host.addEventListener('mousedown', (e) => {
      closePop();
      if (e.button !== 0) return;
      const fnode = e.target.closest && e.target.closest('.bk-float');
      const fh = fnode && e.target.closest('.bk-fh');
      const fmv = fnode && !fh && e.target.closest('.bk-fedge, .bk-ftag, .bk-fbody');
      if (fh || fmv) {
        const id = fnode.dataset.float;
        if (!st.floatSel() || st.floatSel().id !== id || st.kind() !== 'float') st.selectFloat(id);
        api.host.focus({ preventScroll: true });
        const f = BD().findFloat(P().blocks, id);
        drag = { before: st.beginLive(), kind: fh ? 'fresize' : 'fmove', id, h: fh ? fh.dataset.h : '', x: e.clientX, y: e.clientY, start: { x: f.x, y: f.y, w: f.w, h: BD().floatSizeMm(f).h }, rowH: f.block && f.kind !== 'image' ? f.block.rowH.slice() : null };
        e.preventDefault();
        return;
      }
      const grip = e.target.closest && e.target.closest('.bk-grip');
      if (grip && e.detail >= 2) { e.preventDefault(); focusGap(grip.dataset.band, grip.dataset.idx); return; }
      if (grip) {
        const B = P().blocks;
        const f = BD().findBand(B, grip.dataset.band);
        const widths = BD().zoneWidthsMm(B.page, f.band).map((mm) => mm * K());
        startDrag(e, { kind: 'zone', bandId: f.band.id, i: Number(grip.dataset.idx), start: f.band.zones.map((zn) => zn.w), widths });
        return;
      }
      const ed = edgeAt(e);
      if (ed && ed.kind === 'zoneright') {
        // 表の右端をドラッグ：途中の区画は隣との境界を動かす。いちばん右の区画は、幅を変える（短くすると右に空きが残る）
        const B0 = P().blocks;
        const f0 = BD().findTable(B0, ed.tableId);
        const mm = BD().zoneWidthsMm(B0.page, f0.band);
        const idx0 = f0.band.zones.indexOf(f0.zone);
        if (idx0 < f0.band.zones.length - 1) startDrag(e, { kind: 'zone', bandId: f0.band.id, i: idx0, start: f0.band.zones.map((zn) => zn.w), widths: mm.map((x) => x * K()) });
        else startDrag(e, { kind: 'zonelast', bandId: f0.band.id, i: idx0, start: f0.band.zones.map((zn) => zn.w), mm, used0: f0.band.used });
        return;
      }
      if (ed) {
        const t = BD().findTable(P().blocks, ed.tableId).table;
        startDrag(e, { kind: ed.kind, tableId: ed.tableId, i: ed.i, start: ed.kind === 'col' ? t.colW.slice() : t.rowH.slice(), cap: ed.kind === 'row' ? capacityNow() : null });
        return;
      }
      const td = e.target.closest && e.target.closest('.bk-blk td');
      if (td && !td.classList.contains('is-editing') && !(e.target.closest && e.target.closest('textarea'))) {
        const blk = td.closest('.bk-blk');
        const rr = Number(td.dataset.r);
        const cc = Number(td.dataset.c);
        const s0 = st.sel();
        // すでに選んでいるセルをもう一度クリック → 入力（ダブルクリックを待たない）
        if (!e.shiftKey && s0.kind === 'cell' && s0.tableId === blk.dataset.table && s0.r0 === rr && s0.c0 === cc) { e.preventDefault(); startEdit(td); return; }
        st.selectCell(blk.dataset.table, rr, cc, e.shiftKey);
        selecting = blk.dataset.table;
        api.host.focus({ preventScroll: true });
        return;
      }
      if (!e.target.closest('.bk-tag, .bk-bl, .bk-ins, button, .bk-empty')) { if (e.target.closest('.bk-paper, .bk-wrap')) st.clearSel(); }
    });
    api.host.addEventListener('mouseover', (e) => {
      if (!selecting || drag) return;
      const td = e.target.closest && e.target.closest('.bk-blk td');
      if (!td || td.closest('.bk-blk').dataset.table !== selecting) return;
      st.selectCell(selecting, Number(td.dataset.r), Number(td.dataset.c), true);
    });
    api.host.addEventListener('dblclick', (e) => {
      const td = e.target.closest && e.target.closest('.bk-blk td');
      if (td && !td.classList.contains('is-editing')) startEdit(td);
    });

    /* 右クリックのメニュー */
    api.host.addEventListener('contextmenu', (e) => {
      const td = e.target.closest && e.target.closest('.bk-blk td');
      if (!td) return;
      e.preventDefault();
      const blk = td.closest('.bk-blk');
      const r = Number(td.dataset.r);
      const c = Number(td.dataset.c);
      const s = st.sel();
      if (!(s.kind === 'cell' && s.tableId === blk.dataset.table && r >= s.r0 && r <= s.r1 && c >= s.c0 && c <= s.c1)) st.selectCell(blk.dataset.table, r, c, false);
      const t = st.table();
      const s2 = st.sel();
      const why = CDB.sheetDoc.mergeBlock(BD().L(t), st.range());
      const item = (ic, label, fn, dis, cls) => el('button', { type: 'button', class: cls || '', disabled: !!dis, onclick: () => { closePop(); fn(); } }, [icon(ic), label]);
      const m = el('div', { class: 'menu', role: 'menu' }, [
        item('fa-object-group', '結合', st.ops.merge, !!why), item('fa-object-ungroup', '結合を解除', st.ops.unmerge, !t.merges.some((x) => CDB.sheetDoc.hit(x, st.range()))),
        el('hr'),
        item('fa-arrow-up', '行を上に挿入', st.ops.insertRowsAbove), item('fa-arrow-down', '行を下に挿入', st.ops.insertRowsBelow), item('fa-trash-can', '行を削除', st.ops.deleteRows, t.nRows <= s2.r1 - s2.r0 + 1, 'is-danger'),
        el('hr'),
        item('fa-arrow-left', '列を左に挿入', st.ops.insertColsLeft), item('fa-arrow-right', '列を右に挿入', st.ops.insertColsRight), item('fa-trash-can', '列を削除', st.ops.deleteCols, t.nCols <= s2.c1 - s2.c0 + 1, 'is-danger'),
        el('hr'),
        t.rep && t.rep.top === s2.r0 ? item('fa-xmark', '板の表を解除', st.ops.clearRep) : item('fa-grip-lines', 'この行を板の表の行にする', st.ops.setRep, s2.r0 !== s2.r1),
        item('fa-eraser', '中身を消す', st.ops.clearText)
      ]);
      const [x, y] = at(e);
      openPop(m, x, y);
    });

    /* 画像ファイルを区画にドラッグ＆ドロップ（空の区画は入れる、画像のある区画は差し替える） */
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const zoneOf = (e) => (e.target.closest ? e.target.closest('.bk-zone') : null);
    function putImage(zoneId, img) {
      const f = BD().findZone(P().blocks, zoneId);
      if (!f) return;
      if (f.zone.block && BD().isImage(f.zone.block)) st.ops.replaceImage(f.zone.block.id, img);
      else if (!f.zone.block) st.ops.addImage(zoneId, img);
      else UI.toast({ type: 'info', text: 'この区画には表が入っています。画像は空の区画か、画像のある区画に入れてください' });
    }
    async function takeFile(file, zoneId) {
      try { putImage(zoneId, await UI.blockImage.read(file)); } catch (err) { UI.toast({ type: 'warn', text: err.message }); }
    }
    api.host.addEventListener('dragover', (e) => { if (hasFiles(e) && zoneOf(e)) { e.preventDefault(); zoneOf(e).classList.add('bk-drop'); } });
    api.host.addEventListener('dragleave', (e) => { if (zoneOf(e)) zoneOf(e).classList.remove('bk-drop'); });
    api.host.addEventListener('drop', (e) => {
      const z = zoneOf(e);
      if (!hasFiles(e) || !z) return;
      e.preventDefault();
      z.classList.remove('bk-drop');
      const f = Array.from(e.dataTransfer.files).find(UI.blockImage.isImageFile);
      if (f) takeFile(f, z.dataset.zone); else UI.toast({ type: 'warn', text: '画像ファイル（PNG・JPEG・GIF など）をドロップしてください' });
    });
    /* Ctrl+V：選んでいる画像は差し替え、クリックした空の区画には入れる */
    docOn('paste', (e) => {
      if (!api.root.isConnected || !api.root.contains(document.activeElement) && document.activeElement !== document.body) return;
      if (typing(document.activeElement)) return;
      const f = Array.from((e.clipboardData && e.clipboardData.files) || []).find(UI.blockImage.isImageFile);
      if (!f) { // 画像でなければ、選んだセルへ貼り付け（アプリ内のコピーは書式ごと。Excel などの文字はタブ区切りで）
        if (st.kind() === 'cell') { e.preventDefault(); st.ops.paste(e.clipboardData ? e.clipboardData.getData('text/plain') : undefined); }
        return;
      }
      const s = st.sel();
      let zoneId = null;
      if (s.kind === 'table') { const t = BD().findTable(P().blocks, s.tableId); if (t && BD().isImage(t.table)) zoneId = t.zone.id; }
      if (!zoneId && lastZone && BD().findZone(P().blocks, lastZone) && !BD().findZone(P().blocks, lastZone).zone.block) zoneId = lastZone;
      e.preventDefault();
      if (!zoneId) { UI.toast({ type: 'info', text: '画像の入れ先を選んでください。空の区画をクリックするか、差し替える画像を選んでから Ctrl+V してください' }); return; }
      takeFile(f, zoneId);
    });

    /* 列をドラッグして、セルに {列名} を入れる */
    api.host.addEventListener('dragover', (e) => { if (e.target.closest && e.target.closest('.bk-blk td') && !hasFiles(e)) e.preventDefault(); });
    api.host.addEventListener('drop', (e) => {
      const td = e.target.closest && e.target.closest('.bk-blk td');
      const txt = e.dataTransfer.getData('text/plain') || '';
      if (!td || !txt.startsWith('cdbcol:')) return;
      e.preventDefault();
      const blk = td.closest('.bk-blk');
      st.selectCell(blk.dataset.table, Number(td.dataset.r), Number(td.dataset.c), false);
      st.insertText(`{${api.varName(txt.slice(7))}}`);
    });

    /* ---------- キーボード ---------- */
    docOn('keydown', (e) => {
      const p = P();
      if (!p || !p.blocks || !api.root.isConnected || !(api.root.contains(e.target) || e.target === document.body) || typing(e.target)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); st.undo(); return; }
      if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); st.redo(); return; }
      const s = st.sel();
      if (e.key === 'Escape') { if (pop) { closePop(); return; } return; }
      if (s.kind === 'float') { // 矢印で 1mm（Shift で 5mm）・Delete で削除・Ctrl+D で複製・Enter で中身を編集
        if (e.target !== api.host) return;
        const f = BD().findFloat(p.blocks, s.floatId);
        if (!f) return;
        const mv = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
        if (mv) { e.preventDefault(); const n = e.shiftKey ? 5 : 1; st.ops.setFloatGeom(f.id, { x: roundMm(f.x + mv[0] * n), y: roundMm(f.y + mv[1] * n) }); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); st.ops.removeFloat(f.id); return; }
        if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); st.ops.duplicateFloat(f.id); return; }
        if (e.key === 'Enter' && f.block && f.kind !== 'image') { e.preventDefault(); st.selectCell(f.block.id, 0, 0); const td = tdOf(f.block.id, 0, 0); if (td) startEdit(td); }
        return;
      }
      if ((s.kind === 'band' || s.kind === 'table') && !ctrl && (e.key === 'Delete' || e.key === 'Backspace')) { // 帯・表を選んでいるとき：Delete で削除（取り消せる）
        if (!api.host.contains(e.target)) return; // 用紙の中（帯・表のラベルのボタンにフォーカスがあっても効く）。右のパネルや入力欄では効かせない
        e.preventDefault();
        if (s.kind === 'band') st.ops.removeBand(s.bandId); else st.ops.deleteTable();
        return;
      }
      if (s.kind !== 'cell') return;
      if (ctrl && !e.shiftKey && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x') && e.target === api.host) { e.preventDefault(); st.ops.copy(e.key.toLowerCase() === 'x'); return; }
      if (ctrl && (e.key === ']' || e.key === '[')) { e.preventDefault(); st.ops.indent(e.key === ']' ? 1 : -1); return; } // インデント（Ctrl+Tab はブラウザのタブ切り替えに取られるため、この 2 つに割り当てる）
      if (ctrl && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        const k = e.key.toLowerCase();
        const cur = (st.table().cells[BD().key(s.ar, s.ac)] || { s: {} }).s || {};
        st.ops.setStyle({ [k]: cur[k] ? false : 1 });
        return;
      }
      if (e.target !== api.host) return;
      const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
      if (mv) { e.preventDefault(); st.move(mv[0], mv[1], e.shiftKey); return; }
      if (e.key === 'Process' || e.isComposing) { const td = tdOf(s.tableId, s.ar, s.ac); if (td) startEdit(td, typeReplace() ? '' : textOfCell(s.tableId, s.ar, s.ac)); return; } // 日本語入力（IME）：入力欄を先に作って、そのまま変換を続ける
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); st.ops.clearText(); return; }
      if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); const td = tdOf(s.tableId, s.ar, s.ac); if (td) startEdit(td); return; }
      if (e.key === 'Tab') { e.preventDefault(); st.move(0, e.shiftKey ? -1 : 1, false); return; }
      if (e.key.length === 1 && !ctrl && !e.altKey) { const td = tdOf(s.tableId, s.ar, s.ac); if (td) { e.preventDefault(); startEdit(td, (typeReplace() ? '' : textOfCell(s.tableId, s.ar, s.ac)) + e.key); } }
    });
    docOn('click', closePop);

    /** 自由に置く物の基準（ページ／帯）を替える。今見えている位置のまま動かさないように、座標を直す */
    function anchorFloat(id, mode) {
      const f = BD().findFloat(P().blocks, id);
      const node = paperEl && paperEl.querySelector(`.bk-float[data-float="${id}"]`);
      if (!f || !node) return;
      const z = api.getZoom() || 1;
      const k = K();
      const fr = node.getBoundingClientRect();
      if (mode === 'band') {
        const bands = Array.from(paperEl.querySelectorAll('.bk-band'));
        if (!bands.length) { UI.toast({ type: 'warn', text: '帯がありません。先に帯を足してください' }); return; }
        const cy = fr.top + fr.height / 2;
        let best = null;
        bands.forEach((b) => { const r = b.getBoundingClientRect(); const d = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0; if (!best || d < best.d) best = { b, r, d }; });
        st.ops.setFloatAnchor(id, 'band', best.b.dataset.band, roundMm((fr.left - best.r.left) / z / k), roundMm((fr.top - best.r.top) / z / k));
      } else {
        const pr = paperEl.getBoundingClientRect();
        const m = P().blocks.page.margin;
        st.ops.setFloatAnchor(id, 'page', null, roundMm((fr.left - pr.left) / z / k - m.l), roundMm((fr.top - pr.top) / z / k - m.t));
      }
    }

    return {
      render, paint, closePop, anchorFloat, pickTable,
      /** 変数などを入れる。入力中なら、入力欄のカーソルの位置（選んだ文字があれば置き換え）に入れて、入力を続けられるようにする。そうでなければ、選んだセルの末尾に足す */
      insertText: (text, exprText, back) => {
        if (editing && !editing.done) {
          const ta = editing.ta;
          const a = ta.selectionStart;
          // カーソルが {=…} の式の中なら、列は [列名] の形で入れる（式の中では {列名} が使えないため）
          const before = ta.value.slice(0, a);
          const open = before.lastIndexOf('{');
          const inExpr = open > before.lastIndexOf('}') && /^[=＝]/.test(before.slice(open + 1));
          const put = inExpr && exprText ? exprText : text;
          ta.setRangeText(put, a, ta.selectionEnd, 'end');
          if (back) ta.setSelectionRange(ta.selectionStart - back, ta.selectionStart - back);
          ta.focus();
          updateSuggest();
          return true;
        }
        const ok = st.insertText(text);
        return ok;
      },
      isEditing: () => !!(editing && !editing.done), focus: () => api.host.focus({ preventScroll: true }), destroy: () => { closePop(); hideTip(); offs.forEach((f) => f()); offs.length = 0; },
      startEditAt: (tableId, r, c) => { const td = tdOf(tableId, r, c); if (td) startEdit(td); }
    };
  }

  UI.blockCanvas = { create };
})();
