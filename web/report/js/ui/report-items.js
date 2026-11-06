/* =========================================================
   js/ui/report-items.js : 帳票の変換表（項目の一覧と編集）・セルの小窓（配置の追加・変更）
   ・変換表は 1 行 1 項目。表示名・中身・空欄時・置き換え・配置数を 1 行で見渡せる
   ・行を開くと、種類ごとの設定・書式・置き換えのルールと「このロットでの値」が出る
   ・セルの小窓は、思い出させずに選ばせる（項目・DB の列の一覧を、入力しながら絞り込める）
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const UI = CDB.ui;
  const RI = CDB.reportItems;
  const RM = CDB.reportModel;
  const { el, icon } = U;

  const TOL_ROUND = [
    { value: '', label: 'しない' },
    { value: 'floor', label: '切り捨て' },
    { value: 'ceil', label: '切り上げ' },
    { value: 'half_up', label: '規則B（四捨五入）' },
    { value: 'half_even', label: '規則A（偶数丸め）' }
  ];
  /**
   * 桁をそろえるときの丸め規則。「指定なし」は従来どおり（四捨五入。データ側で丸めた値から）。
   * 選ぶと、データ側（判定設定）で丸める前の元の値から丸める（二重に丸めない）
   */
  const DIGIT_RULES = [
    { value: '', label: '指定なし（四捨五入）' },
    { value: 'half_up', label: '規則B（四捨五入）' },
    { value: 'half_even', label: '規則A（偶数丸め）' },
    { value: 'ceil', label: '切り上げ' },
    { value: 'floor', label: '切り捨て' }
  ];
  const RULE_TITLE = '規則を選ぶと、データ側の丸め（判定設定）の前の元の値から丸めます。「指定なし」は従来どおりです';

  /* ── 列の選択肢 ── */
  /** DB の列（元データ・板）だけ */
  const dataColumns = (columns) => columns.filter((c) => c.side === 'master' || c.side === 'plate');

  /** 列の select（元データ／板でまとめる）。value は列ID */
  function columnSelect(columns, value, attrs) {
    const sel = el('select', Object.assign({ class: 'select' }, attrs || {}), [el('option', { value: '', text: '（列を選ぶ）' })]);
    [['master', '元データ'], ['plate', 'DB の列（ロットの各行）']].forEach(([side, label]) => {
      const cs = columns.filter((c) => c.side === side);
      if (!cs.length) return;
      sel.appendChild(el('optgroup', { label }, cs.map((c) => el('option', { value: c.id, text: c.label }))));
    });
    // データにない列が設定されていても、消さずに見せる
    if (value && !columns.some((c) => c.id === value)) sel.appendChild(el('option', { value, text: `${RI.colText(value)}（データにありません）` }));
    sel.value = value || '';
    return sel;
  }

  /** 式で使う名前の select（value は列名。元/板が重複する列は 元:・板: 付き） */
  function nameSelect(columns, value, attrs) {
    const names = dataColumns(columns).map((c) => ({ c, name: RM.refName(c, columns) }));
    const sel = el('select', Object.assign({ class: 'select' }, attrs || {}), [el('option', { value: '', text: '（列を選ぶ）' })]);
    [['master', '元データ'], ['plate', 'DB の列（ロットの各行）']].forEach(([side, label]) => {
      const cs = names.filter((x) => x.c.side === side);
      if (cs.length) sel.appendChild(el('optgroup', { label }, cs.map((x) => el('option', { value: x.name, text: x.c.label }))));
    });
    if (value && !names.some((x) => x.name === value)) sel.appendChild(el('option', { value, text: `${value}（データにありません）` }));
    sel.value = value || '';
    return sel;
  }

  /** 入力欄（変更のたびに onInput、確定で onChange。反映の合図つき） */
  function input(value, onInput, attrs) {
    const node = el('input', Object.assign({ class: 'input', type: 'text' }, attrs || {}));
    node.value = value === undefined || value === null ? '' : value;
    node.addEventListener('input', () => onInput(node.value, false));
    node.addEventListener('change', () => { onInput(node.value, true); U.flash(node); });
    return node;
  }

  function seg(options, value, onChange) {
    const nm = U.uid('seg');
    return el('div', { class: 'seg' }, options.map((o) => {
      const r = el('input', { type: 'radio', name: nm, value: o.value });
      r.checked = o.value === value;
      r.addEventListener('change', () => onChange(o.value));
      return el('label', { title: o.title || null }, [r, o.icon ? icon(o.icon) : null, o.label]);
    }));
  }

  /* ── 変換表 ── */
  /**
   * @param {HTMLElement} host
   * @param {{getPreset:Function, getColumns:Function, getLot:Function, changed:(what:string)=>void, startPlacing:(id:string)=>void, placingId:()=>string|null}} api
   */
  function createTable(host, api) {
    let openId = null;
    let newId = null;
    const sumEls = new Map(); // 項目ID → 「中身」の要約（編集中にその場で書き換える）

    function render() {
      const preset = api.getPreset();
      host.innerHTML = '';
      if (!preset) return;
      const columns = api.getColumns();
      const table = el('table', { class: 'map-table rp-items' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: '表示名', title: '帳票に出す名前。「表示名」「表示名＋値」で配置すると、この名前が帳票に出ます' }),
          el('th', { text: '中身', title: 'DB の列・計算式・公差範囲など' }),
          el('th', { text: '空欄時', title: '値が空欄のときに出す文字' }),
          el('th', { text: '前', title: '値の前につける文字（例：約）。値が空欄のときはつけません' }),
          el('th', { text: '後', title: '値の後ろにつける文字（単位など。例：枚・mm）。値が空欄のときはつけません' }),
          el('th', { title: '帳票に配置している数' }, [icon('fa-location-crosshairs')]),
          el('th', {})
        ])])
      ]);
      const tbody = el('tbody');
      table.appendChild(tbody);
      preset.items.forEach((it) => {
        const kind = RI.kindOf(it);
        const n = RM.placeCount(preset, it.id);
        const isOpen = openId === it.id;
        const placing = api.placingId() === it.id;
        const tr = el('tr', { class: (isOpen ? 'is-open ' : '') + (newId === it.id ? 'is-new' : '') });
        tr.append(
          el('td', {}, [input(it.label, (v, done) => { it.label = v; api.changed(done ? 'items' : 'label'); }, { 'aria-label': '表示名' })]),
          el('td', { class: 'rp-item-sum' }, [el('button', {
            class: 'btn btn-sm btn-ghost rp-sum-btn', type: 'button', title: '開いて設定を変える',
            onclick: () => { openId = isOpen ? null : it.id; render(); }
          }, [icon(kind.icon), (() => { const sp = el('span', { class: 'grow', text: kind.summary(it) }); sumEls.set(it.id, sp); return sp; })(),
            (it.map || []).filter((m) => U.normValue(m.from)).length ? el('span', { class: 'badge badge-accent', title: '置き換えのルール', text: `置換${it.map.filter((m) => U.normValue(m.from)).length}` }) : null,
            icon(isOpen ? 'fa-chevron-up' : 'fa-chevron-down')])]),
          el('td', {}, [input(it.blank, (v, done) => { it.blank = v; api.changed(done ? 'items' : 'value'); }, { class: 'input rp-blank', placeholder: '空欄', 'aria-label': '空欄時の文字' })]),
          el('td', {}, [input(it.pre || '', (v, done) => { it.pre = v; api.changed(done ? 'items' : 'value'); }, { class: 'input rp-blank', placeholder: '前', 'aria-label': '値の前につける文字' })]),
          el('td', {}, [input(it.post || '', (v, done) => { it.post = v; api.changed(done ? 'items' : 'value'); }, { class: 'input rp-blank', placeholder: '単位', 'aria-label': '値の後ろにつける文字（単位など）' })]),
          el('td', { class: 'nowrap' }, [el('button', {
            class: 'btn btn-sm' + (placing ? ' is-active' : ''), type: 'button',
            title: placing ? '配置を終える（Esc）' : 'プレビューのセルをクリックして配置する',
            onclick: () => api.startPlacing(placing ? null : it.id)
          }, [icon('fa-location-crosshairs'), String(n)])]),
          el('td', {}, [el('button', {
            class: 'icon-btn is-danger', type: 'button', title: '項目を削除（配置も外れます）',
            onclick: () => removeItem(it)
          }, [icon('fa-trash-can')])])
        );
        tbody.appendChild(tr);
        if (isOpen) tbody.appendChild(el('tr', { class: 'rp-editor-row' }, [el('td', { colspan: 7 }, [editor(it, columns)])]));
      });
      host.appendChild(preset.items.length ? table : el('div', { class: 'note' }, [icon('fa-circle-info'),
        el('div', { text: 'まだ項目がありません。下のボタンで追加するか、プレビューのセルをクリックして DB の列を選ぶと自動で作られます。' })]));
      host.appendChild(addBar(columns));
      newId = null;
    }

    function addBar(columns) {
      const colSel = columnSelect(dataColumns(columns), '', { title: 'DB の列から項目を作る', 'aria-label': 'DB の列から追加' });
      colSel.addEventListener('change', () => {
        const c = columns.find((x) => x.id === colSel.value);
        if (c) add(RI.create('field', { label: c.label, col: c.id }));
      });
      return el('div', { class: 'rp-addbar' }, [
        el('div', { class: 'row' }, [icon('fa-plus'), el('span', { class: 'muted', text: '項目を追加：' }), colSel]),
        el('div', { class: 'row wrap' }, RI.kinds().filter((k) => k.kind !== 'field').map((k) => el('button', {
          class: 'btn btn-sm', type: 'button', title: k.desc, onclick: () => add(RI.create(k.kind))
        }, [icon(k.icon), k.label])))
      ]);
    }

    function add(item) {
      api.getPreset().items.push(item);
      openId = item.kind === 'field' ? null : item.id;
      newId = item.id;
      api.changed('items');
      render();
      return item;
    }

    function removeItem(it) {
      const p = api.getPreset();
      const prevItems = p.items.slice();
      const prevPlaces = p.places.slice();
      p.items = p.items.filter((x) => x !== it);
      p.places = p.places.filter((x) => x.item !== it.id);
      api.changed('places');
      render();
      UI.toast({
        type: 'ok', text: `項目「${it.label}」を削除しました（配置 ${prevPlaces.length - p.places.length} か所も外しました）`,
        undo: () => { p.items = prevItems; p.places = prevPlaces; api.changed('places'); render(); }
      });
    }

    /* ── 項目の編集（行を開いたとき） ── */
    function editor(it, columns) {
      const result = el('div', { class: 'rp-result' });
      const showResult = () => {
        result.innerHTML = '';
        const lot = api.getLot();
        const r = RM.previewItem(api.getPreset(), it, lot, columns);
        if (!r) { result.append(icon('fa-circle-info'), ' データを読み込むと、ここに値の例が出ます'); return; }
        const where = r.inTable ? (r.row ? '1 枚目の板' : '板なし') : 'ロット';
        if (r.error) {
          result.classList.add('is-err');
          result.append(icon('fa-circle-xmark'), ` ${lot.name}（${where}）：${r.error.code} ${r.error.message}`);
        } else {
          result.classList.remove('is-err');
          result.append(icon('fa-eye'), ` ${lot.name}（${where}）の値：`, el('b', { class: 'mono', text: r.text === '' ? '（空欄）' : r.text }));
        }
        U.flash(result);
      };
      const change = (done) => {
        api.changed(done ? 'items' : 'value');
        const sp = sumEls.get(it.id);
        if (sp) sp.textContent = RI.kindOf(it).summary(it);
        showResult();
      };

      const kindSeg = seg(RI.kinds().map((k) => ({ value: k.kind, label: k.label, icon: k.icon, title: k.desc })), it.kind, (v) => {
        Object.assign(it, RI.kindOf({ kind: v }).create({ col: it.col }), { kind: v });
        api.changed('items');
        render();
      });
      const box = el('div', { class: 'rp-editor' }, [
        el('div', { class: 'field' }, [el('label', { text: '種類' }), kindSeg]),
        kindForm(it, columns, change),
        formatForm(it, change),
        mapForm(it, change),
        result
      ]);
      showResult();
      return box;
    }

    function kindForm(it, columns, change) {
      if (it.kind === 'field') {
        const sel = columnSelect(dataColumns(columns), it.col);
        sel.addEventListener('change', () => {
          const prev = columns.find((c) => c.id === it.col);
          const c = columns.find((x) => x.id === sel.value);
          // 表示名を変えていなければ、列名に合わせる
          if (c && (!U.normValue(it.label) || (prev && it.label === prev.label) || it.label === RI.kindOf(it).label)) it.label = c.label;
          it.col = sel.value;
          change(true);
          render();
        });
        return el('div', { class: 'field' }, [el('label', { text: 'DB の列（値をそのまま出す）' }), sel]);
      }
      if (it.kind === 'formula') {
        const ta = el('textarea', { class: 'textarea', rows: 3, spellcheck: 'false', placeholder: '例：FIXED([板厚]-[公差(-)], 3) & "mm ～ " & FIXED([板厚]+[公差(+)], 3) & "mm"', 'aria-label': '計算式' });
        ta.value = it.expr || '';
        ta.addEventListener('input', U.debounce(() => { it.expr = ta.value; change(false); }, 250));
        ta.addEventListener('change', () => { it.expr = ta.value; change(true); U.flash(ta); });
        const insert = (text) => {
          const s = ta.selectionStart ?? ta.value.length;
          const e = ta.selectionEnd ?? ta.value.length;
          ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
          ta.focus();
          ta.selectionStart = ta.selectionEnd = s + text.length;
          it.expr = ta.value;
          change(true);
        };
        const colIns = nameSelect(columns, '', { title: 'カーソルの位置に [列名] を入れる', 'aria-label': '列を挿入' });
        colIns.options[0].text = '列を入れる…';
        colIns.addEventListener('change', () => { if (colIns.value) insert(`[${colIns.value}]`); colIns.value = ''; });
        const fnIns = el('select', { class: 'select', title: 'カーソルの位置に関数を入れる', 'aria-label': '関数を挿入' }, [el('option', { value: '', text: '関数を入れる…' })]);
        const groups = {};
        CDB.formula.list().forEach((f) => { (groups[f.group] = groups[f.group] || []).push(f); });
        Object.keys(groups).forEach((g) => fnIns.appendChild(el('optgroup', { label: g }, groups[g].map((f) => el('option', { value: f.name, text: `${f.name} … ${f.desc}` })))));
        fnIns.addEventListener('change', () => { const f = CDB.formula.list().find((x) => x.name === fnIns.value); if (f) insert(f.example); fnIns.value = ''; });
        return el('div', { class: 'field' }, [
          el('label', { text: '計算式（Excel と同じ書き方。列は [列名]、文字は "～"、連結は &）' }),
          ta,
          el('div', { class: 'row' }, [colIns, fnIns])
        ]);
      }
      if (it.kind === 'tolerance') return toleranceForm(it, columns, change);
      if (it.kind === 'text') {
        return el('div', { class: 'field' }, [el('label', { text: '出す文字' }), input(it.text, (v, done) => { it.text = v; change(done); })]);
      }
      if (it.kind === 'system') {
        const sel = UI.select(RI.SYSTEM.map((s) => ({ value: s.value, label: s.label })), it.sys);
        sel.addEventListener('change', () => { it.sys = sel.value; change(true); render(); });
        return el('div', { class: 'field' }, [el('label', { text: 'ツールの値' }), sel]);
      }
      return el('div');
    }

    function operandInput(o, columns, change, label) {
      const wrap = el('div', { class: 'row' });
      const draw = () => {
        wrap.innerHTML = '';
        const s = seg([{ value: 'col', label: '列' }, { value: 'num', label: '数値' }], o.src, (v) => { o.src = v; o.v = ''; change(true); draw(); });
        let f;
        if (o.src === 'col') {
          f = nameSelect(columns, o.v, { 'aria-label': label });
          f.addEventListener('change', () => { o.v = f.value; change(true); render(); });
        } else f = input(o.v, (v, done) => { o.v = v; change(done); }, { inputmode: 'decimal', 'aria-label': label, style: 'width:90px' });
        wrap.append(s, f);
      };
      draw();
      return el('div', { class: 'field' }, [el('label', { text: label }), wrap]);
    }

    function toleranceForm(it, columns, change) {
      const t = it.tol;
      const digits = input(t.digits, (v, done) => { t.digits = Number(v) || 0; change(done); }, { inputmode: 'numeric', 'data-maxlen': 1, style: 'width:48px' });
      const tolDigits = input(t.tolDigits, (v, done) => { t.tolDigits = Number(v) || 0; change(done); }, { inputmode: 'numeric', 'data-maxlen': 1, style: 'width:48px' });
      const rule = UI.select(DIGIT_RULES, t.round || '', { 'aria-label': '表示の桁の丸め規則', title: RULE_TITLE });
      rule.addEventListener('change', () => { t.round = rule.value; if (!rule.value) delete t.round; change(true); U.flash(rule); });
      const round = UI.select(TOL_ROUND, t.tolRound || '');
      round.addEventListener('change', () => { t.tolRound = round.value; tolDigits.disabled = !round.value; change(true); });
      tolDigits.disabled = !t.tolRound;
      const comma = el('input', { type: 'checkbox' });
      comma.checked = !!t.comma;
      comma.addEventListener('change', () => { t.comma = comma.checked; change(true); });
      const toFormula = el('button', {
        class: 'btn btn-sm btn-ghost', type: 'button', title: '同じ計算をする式に変えて、細かく直せるようにします',
        onclick: () => { it.expr = RI.toleranceExpr(t); it.kind = 'formula'; delete it.tol; api.changed('items'); render(); }
      }, [icon('fa-square-root-variable'), '式にして細かく直す']);
      return el('div', { class: 'rp-tol' }, [
        operandInput(t.base, columns, change, '基準値'),
        el('div', { class: 'row wrap rp-tol-pm' }, [operandInput(t.minus, columns, change, '－側の公差'), operandInput(t.plus, columns, change, '＋側の公差')]),
        el('div', { class: 'row wrap' }, [
          el('div', { class: 'field' }, [el('label', { text: '公差の丸め' }), el('div', { class: 'row' }, [round, el('span', { class: 'muted', text: '小数' }), tolDigits, el('span', { class: 'muted', text: '桁' })])]),
          el('div', { class: 'field' }, [el('label', { text: '表示の桁数と丸め規則' }), el('div', { class: 'row' }, [el('span', { class: 'muted', text: '小数' }), digits, el('span', { class: 'muted', text: '桁' }), rule])])
        ]),
        el('div', { class: 'row wrap' }, [
          el('div', { class: 'field' }, [el('label', { text: '単位' }), input(t.unit, (v, done) => { t.unit = v; change(done); }, { style: 'width:64px' })]),
          el('div', { class: 'field' }, [el('label', { text: '区切り' }), input(t.sep, (v, done) => { t.sep = v; change(done); }, { style: 'width:64px' })]),
          el('label', { class: 'check', style: 'align-self:flex-end' }, [comma, '桁区切り（1,000）'])
        ]),
        el('div', { class: 'row' }, [el('span', { class: 'muted', text: '下限値 ＝ 基準値 － |－側|、上限値 ＝ 基準値 ＋ |＋側|。基準値が空欄なら「空欄時」の文字' }), el('div', { class: 'grow' }), toFormula])
      ]);
    }

    function formatForm(it, change) {
      const f = it.fmt || (it.fmt = { type: 'auto', digits: '', comma: false, date: 'yyyy/mm/dd' });
      const box = el('div', { class: 'row wrap' });
      const draw = () => {
        box.innerHTML = '';
        const type = UI.select(RI.FMT_TYPES, f.type || 'auto', { 'aria-label': '書式' });
        type.addEventListener('change', () => { f.type = type.value; change(true); draw(); });
        box.append(el('div', { class: 'field' }, [el('label', { text: '書式' }), type]));
        if (f.type === 'number') {
          const comma = el('input', { type: 'checkbox' });
          comma.checked = !!f.comma;
          comma.addEventListener('change', () => { f.comma = comma.checked; change(true); });
          const rule = UI.select(DIGIT_RULES, f.round || '', { 'aria-label': '丸め規則', title: RULE_TITLE });
          rule.addEventListener('change', () => { f.round = rule.value; if (!rule.value) delete f.round; change(true); U.flash(rule); });
          box.append(
            el('div', { class: 'field' }, [el('label', { text: '小数の桁（空欄はそのまま）' }), input(f.digits, (v, done) => { f.digits = v; change(done); }, { inputmode: 'numeric', 'data-maxlen': 1, style: 'width:48px' })]),
            el('div', { class: 'field' }, [el('label', { text: '丸め規則' }), rule]),
            el('label', { class: 'check', style: 'align-self:flex-end' }, [comma, '桁区切り'])
          );
        }
        if (f.type === 'date') {
          const pat = UI.select(RI.DATE_PATTERNS.map((p) => ({ value: p, label: p + '（' + CDB.formula.formatDate('2026/02/01', p) + '）' })), f.date || 'yyyy/mm/dd');
          pat.addEventListener('change', () => { f.date = pat.value; change(true); });
          box.append(el('div', { class: 'field' }, [el('label', { text: '日付の形' }), pat]));
        }
      };
      draw();
      return box;
    }

    /** 置き換えのルール（変換表）。上から順に照合し、* はほかの値すべて */
    function mapForm(it, change) {
      const box = el('div', { class: 'field' });
      const draw = () => {
        box.innerHTML = '';
        box.appendChild(el('label', { text: '値の置き換え（例：合格 → O.K.。* はほかの値すべて。空欄は「空欄時」で指定）' }));
        (it.map || []).forEach((m, i) => {
          box.appendChild(el('div', { class: 'row rp-map-row' }, [
            input(m.from, (v, done) => { m.from = v; change(done); }, { placeholder: '元の値', 'aria-label': '元の値' }),
            icon('fa-arrow-right'),
            input(m.to, (v, done) => { m.to = v; change(done); }, { placeholder: '帳票に出す値', 'aria-label': '置き換え後' }),
            el('button', { class: 'icon-btn', type: 'button', title: 'このルールを削除', onclick: () => { it.map.splice(i, 1); change(true); draw(); } }, [icon('fa-xmark')])
          ]));
        });
        box.appendChild(el('div', {}, [el('button', {
          class: 'btn btn-sm btn-ghost', type: 'button',
          onclick: () => {
            (it.map = it.map || []).push({ from: '', to: '' });
            draw();
            const rows = box.querySelectorAll('.rp-map-row input');
            if (rows.length) rows[rows.length - 2].focus();
          }
        }, [icon('fa-plus'), '置き換えを追加'])]));
      };
      draw();
      return box;
    }

    return {
      render,
      open(id) { openId = id; render(); const row = host.querySelector('tr.is-open'); if (row) row.scrollIntoView({ block: 'nearest' }); },
      add
    };
  }

  /* ── セルの小窓 ── */
  /**
   * @param {{anchor:HTMLElement, root:HTMLElement, place:object|null, preset:object, columns:object[], cellText:string,
   *          onPick:(item:object)=>void, onShow:(show:string, sep:string)=>void, onRemove:Function, onEdit:(id:string)=>void,
   *          valueText:string|null, onClose:Function}} o
   */
  function popover(o) {
    const pop = el('div', { class: 'rp-pop', role: 'dialog' });
    const close = () => {
      pop.remove();
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', onKey, true);
      if (o.onClose) o.onClose();
    };
    const outside = (e) => { if (!pop.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
    const item = o.place ? o.preset.items.find((x) => x.id === o.place.item) : null;

    if (item) {
      const kind = RI.kindOf(item);
      const sep = input(o.place.sep === undefined ? '：' : o.place.sep, (v, done) => { if (done) o.onShow(o.place.show, v); }, { style: 'width:48px', 'aria-label': '区切り' });
      sep.disabled = o.place.show !== 'both';
      pop.append(
        el('div', { class: 'rp-pop-head' }, [icon(kind.icon), el('b', { class: 'grow', text: item.label }), el('span', { class: 'muted', text: kind.summary(item) })]),
        el('div', { class: 'field' }, [el('label', { text: '帳票に出すもの' }), el('div', { class: 'row' }, [
          seg(RM.SHOW, o.place.show || 'value', (v) => { sep.disabled = v !== 'both'; o.onShow(v, sep.value); }),
          el('span', { class: 'muted', text: '区切り' }), sep
        ])]),
        o.valueText !== null ? el('div', { class: 'rp-result' }, [icon('fa-eye'), ' この位置の値：', el('b', { class: 'mono', text: o.valueText || '（空欄）' })]) : null,
        el('div', { class: 'row' }, [
          el('button', { class: 'btn btn-sm', type: 'button', onclick: () => { close(); o.onEdit(item.id); } }, [icon('fa-pen'), '変換表で編集']),
          el('div', { class: 'grow' }),
          el('button', { class: 'btn btn-sm', type: 'button', onclick: () => { close(); o.onRemove(); } }, [icon('fa-xmark'), '配置を外す'])
        ]),
        el('hr')
      );
    }

    // 項目・列の一覧（入力しながら絞り込む）
    const search = el('input', { class: 'input', type: 'text', placeholder: item ? '別の項目に変える…' : '配置する項目・DB の列を探す', 'data-enter': 'submit', 'aria-label': '探す' });
    const list = el('div', { class: 'rp-pop-list' });
    let first = null;
    const drawList = () => {
      list.innerHTML = '';
      first = null;
      const q = U.normKey(search.value).toLowerCase();
      const hit = (s) => !q || U.normKey(s).toLowerCase().includes(q);
      const choose = (fn) => () => { close(); fn(); };
      const groupTitle = (t) => list.appendChild(el('div', { class: 'menu-label', text: t }));
      const items = o.preset.items.filter((x) => hit(x.label) || hit(RI.kindOf(x).summary(x)));
      if (items.length) groupTitle('変換表の項目');
      items.forEach((x) => {
        const b = el('button', { type: 'button', onclick: choose(() => o.onPick(x)) }, [icon(RI.kindOf(x).icon), el('span', { class: 'grow', text: x.label }), el('span', { class: 'muted', text: RI.kindOf(x).summary(x) })]);
        list.appendChild(b);
        first = first || b;
      });
      const cols = dataColumns(o.columns).filter((c) => hit(c.label));
      if (cols.length) groupTitle('DB の列から新しく作る');
      cols.slice(0, 60).forEach((c) => {
        const b = el('button', { type: 'button', onclick: choose(() => o.onPick(RI.create('field', { label: c.label, col: c.id }), true)) }, [
          icon('fa-database'), el('span', { class: 'grow', text: c.label }), el('span', { class: 'muted', text: c.side === 'master' ? '元データ' : '板' })]);
        list.appendChild(b);
        first = first || b;
      });
      groupTitle('そのほかを新しく作る');
      RI.kinds().filter((k) => k.kind !== 'field').forEach((k) => {
        const label = U.normValue(search.value) && k.kind === 'text' ? search.value : k.label;
        list.appendChild(el('button', { type: 'button', title: k.desc, onclick: choose(() => o.onPick(RI.create(k.kind, k.kind === 'text' ? { label, text: U.normValue(search.value) ? search.value : o.cellText } : { label }), true)) }, [
          icon(k.icon), el('span', { class: 'grow', text: k.kind === 'text' && U.normValue(search.value) ? `固定の文字「${search.value}」` : k.label }), el('span', { class: 'muted', text: k.desc })]));
      });
    };
    search.addEventListener('input', drawList);
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && first) { e.preventDefault(); first.click(); } });
    pop.append(search, list);
    drawList();

    o.root.appendChild(pop);
    const a = o.anchor.getBoundingClientRect();
    const r = o.root.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    let left = a.left - r.left;
    let top = a.bottom - r.top + 4;
    if (left + pw > r.width - 8) left = Math.max(8, r.width - pw - 8);
    if (top + ph > r.height - 8) top = Math.max(8, a.top - r.top - ph - 4);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    setTimeout(() => {
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', onKey, true);
      search.focus();
    }, 0);
    return { close };
  }

  CDB.ui.reportItems = { createTable, popover, columnSelect, nameSelect };
})();
