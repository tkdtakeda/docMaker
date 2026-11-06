/* =========================================================
   js/ui/block-side.js : ブロックの帳票の脇のパネル（ページ設定・データの列と変数・選んだセルの設定）
   ・ページ設定：用紙・向き・余白・フッターを出すページ・1 ページの板の行数（⚙ の中。用紙を広く使うため脇に畳む）
   ・データの列と変数：クリック（またはセルへドラッグ）で、選んだセルに {列名} を入れる
   ・選んだセルの設定：中身（長い式はここで編集）・値が空のときの文字・前後の文字
   状態と操作は block-state.js。ここは表示と、押された操作の受け渡しだけ
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const UI = CDB.ui;
  const { el, icon, fmt } = U;
  const SP = () => CDB.sheetPages;
  const BD = () => CDB.blockDoc;

  /** 値を打つ欄（確定で保存） */
  function field(label, value, onChange, o) {
    const x = o || {};
    const i = el('input', { class: 'input' + (x.cls ? ' ' + x.cls : ''), type: 'text', placeholder: x.placeholder || '', 'aria-label': label });
    i.value = value || '';
    i.addEventListener('change', () => { onChange(i.value); U.flash(i); });
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) i.blur(); });
    return el('label', { class: 'rp-cell-field' }, [el('span', { text: label }), i]);
  }

  /* ---------- ページ設定 ---------- */
  function createPage(host, api) {
    const st = api.st;
    const num = (label, value, min, max, onChange, unit) => {
      const i = el('input', { class: 'input rp-num', type: 'number', min, max, value: String(value), 'aria-label': label });
      i.addEventListener('change', () => onChange(Math.max(min, Math.min(max, Number(i.value) || 0))));
      return el('label', { class: 'rp-numbox' }, [label, i, unit ? el('span', { class: 'muted', text: unit }) : null]);
    };
    const summary = () => { const p = api.getPreset(); return p && p.doc ? SP().summary(p.doc, p.table) : ''; };

    function render() {
      host.innerHTML = '';
      const p = api.getPreset();
      if (!p || !p.blocks) return;
      const page = p.blocks.page;
      const paper = UI.select(SP().PAPERS.map((x) => ({ value: x.value, label: x.label })), page.paper, { 'aria-label': '用紙' });
      paper.addEventListener('change', () => st.ops.setPage({ paper: paper.value }));
      const orient = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': '用紙の向き' }, [['portrait', 'fa-file', '縦'], ['landscape', 'fa-image', '横']].map(([v, ic, label]) => {
        const r = el('input', { type: 'radio', name: 'bkOrient', value: v });
        r.checked = page.orientation === v;
        r.addEventListener('change', () => st.ops.setPage({ orientation: v }));
        return el('label', {}, [r, icon(ic), label]);
      }));
      const foot = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': '板の表より下の帯を出すページ' }, [['last', '最後のページだけ'], ['every', '毎ページ']].map(([v, label]) => {
        const r = el('input', { type: 'radio', name: 'bkFoot', value: v });
        r.checked = page.footer === v;
        r.addEventListener('change', () => st.ops.setPage({ footer: v }));
        return el('label', {}, [r, label]);
      }));
      const auto = p.table ? SP().capacity(p.doc, p.table) : 0;
      const manual = page.rows > 0;
      const autoChk = el('input', { type: 'checkbox' });
      autoChk.checked = !manual;
      autoChk.addEventListener('change', () => st.ops.setPage({ rows: autoChk.checked ? 0 : Math.max(1, auto) }));
      const warns = (p.warnings || []).map((w) => el('div', { class: 'note is-warn' }, [icon('fa-triangle-exclamation'), el('div', { text: w })]));
      const m = page.margin;
      host.append(
        el('div', { class: 'rule-line' }, [icon('fa-file-lines'), el('span', { text: '用紙' }), paper, orient]),
        el('div', { class: 'field-label', text: '余白（mm）' }),
        el('div', { class: 'row wrap' }, [
          num('上', m.t, 0, 100, (v) => st.ops.setPage({ margin: Object.assign({}, m, { t: v }) })), num('下', m.b, 0, 100, (v) => st.ops.setPage({ margin: Object.assign({}, m, { b: v }) })),
          num('左', m.l, 0, 100, (v) => st.ops.setPage({ margin: Object.assign({}, m, { l: v }) })), num('右', m.r, 0, 100, (v) => st.ops.setPage({ margin: Object.assign({}, m, { r: v }) }))
        ]),
        el('div', { class: 'field-label', text: '板の表より下の帯を出すページ' }), foot,
        el('span', { class: 'muted', text: 'ヘッダー・フッター（用紙の上端・下端の帯）と、板の表より上の帯は、全ページに出ます。あふれた板は次のページに送ります。' }),
        p.table
          ? el('div', { class: 'rule-line' }, [icon('fa-list-ol'), el('span', { text: '1 ページの板の行数' }), el('label', { class: 'check' }, [autoChk, `自動（${fmt(auto)} 行）`]),
            manual ? num('', page.rows, 1, 500, (v) => st.ops.setPage({ rows: v }), '行') : null])
          : el('span', { class: 'muted', text: '板の表がないため、1 枚で 1 ページです（板ごとに繰り返したいときは、全幅の帯に「板の表」を入れてください）' }),
        el('span', { class: 'muted', text: 'ページ番号は、文字の中に {ページ} {総ページ} と書きます（例：Page {ページ} / {総ページ}）。1 枚にまとめる単位ごとに数えます。' }),
        el('div', { class: 'row wrap' }, [num('ページ番号の開始', page.pageStart || 1, 1, 9999, (v) => st.ops.setPage({ pageStart: v }))]),
        ...warns
      );
    }
    st.onChange(render);
    return { render, summary };
  }

  /* ---------- データの列と変数 ---------- */
  const VAR_HELP = [
    ['ページ', '今のページ番号'], ['総ページ', '総ページ数（1 枚にまとめる単位ごと）'], ['出力日', '出力した日'],
    ['行番号', '板の表の中の行番号'], ['ロット名', '1 枚にまとめる単位の名前']
  ];

  /**
   * @param {HTMLElement} host
   * @param {{st:object, getColumns:Function, getPreset:Function, varName:(colId:string)=>string}} api
   */
  function createVars(host, api) {
    let word = '';
    let drawnOk = null; // 前に描いたときの「列を置けるか」。変わらないなら描き直さない（入力中に押しても、一覧の位置が先頭に戻らない）
    let drawnPreset = null;
    const st = api.st;
    const scroller = () => host.closest('.rp-panel') || host.parentElement;
    function render(force) {
      const p = api.getPreset();
      if (!p) { host.innerHTML = ''; return; }
      const okNow = st.kind() === 'cell';
      if (force !== true && host.firstChild && drawnOk === okNow && drawnPreset === p) return;
      drawnOk = okNow;
      drawnPreset = p;
      const sc = scroller();
      const top = sc ? sc.scrollTop : 0;
      host.innerHTML = '';
      const cols = api.getColumns().filter((c) => c.side === 'plate' || c.side === 'master');
      const ok = st.kind() === 'cell';
      host.appendChild(el('span', { class: 'muted', title: '選んだセルに {列名} の形で入ります（文字の途中にも書けます：注文 {注文番号}）。板の表の行に置くと、板の数だけ繰り返します', text: 'セルを選んで列をクリック（ドラッグでも入ります）' }));
      if (!ok) host.appendChild(el('span', { class: 'reason', text: '先に、表のセルを選んでください' }));
      const q = el('input', { class: 'input', type: 'search', placeholder: `列を探す（${fmt(cols.length)} 列）`, 'aria-label': '列を探す' });
      q.value = word;
      q.addEventListener('input', () => { word = q.value; paint(); });
      if (cols.length > 8) host.appendChild(q);
      const list = el('div', { class: 'rp-cols' });
      host.appendChild(list);
      function paint() {
        list.innerHTML = '';
        const w = U.normKey(word);
        if (!cols.length) list.appendChild(el('span', { class: 'muted', text: 'docMaker で DB かサンプルを読み込み、ロットを選んでから開くと、ここに列が出ます' }));
        [['plate', 'DB の列（ロットの各行）', 'fa-layer-group'], ['master', 'ロット・元データ', 'fa-table-list']].forEach(([side, title, ic]) => {
          const rows = cols.filter((c) => c.side === side && (!w || U.normKey(c.label).includes(w)));
          if (!rows.length) return;
          list.appendChild(el('div', { class: 'field-label' }, [icon(ic), ' ' + title]));
          rows.forEach((c) => {
            const b = el('button', { class: 'rp-col', type: 'button', draggable: 'true', disabled: !ok, title: ok ? `選んだセルに {${api.varName(c.id)}} を入れる（入力中は、カーソルの位置に入ります）` : '先にセルを選んでください', onclick: () => api.insert(`{${api.varName(c.id)}}`, `[${api.varName(c.id)}]`) },
              [icon('fa-grip-vertical', 'rp-col-grip'), el('span', { class: 'grow', text: c.label })]);
            b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'cdbcol:' + c.id); e.dataTransfer.effectAllowed = 'copy'; });
            list.appendChild(b);
          });
        });
        list.appendChild(el('div', { class: 'field-label' }, [icon('fa-square-root-variable'), ' 計算式を文字の途中に']));
        list.appendChild(el('button', { class: 'rp-col', type: 'button', disabled: !ok, title: '文字の途中に計算式を入れます。{=[板厚]-[公差]|桁=2} のように、= で始め、列は [列名] で書きます（入力中に列をクリックすると [列名] で入ります）', onclick: () => api.insert('{=}', '{=}', 1) }, [icon('fa-hashtag', 'rp-col-grip'), el('span', { class: 'grow', text: '{=式}' }), el('span', { class: 'muted', text: '例：{=[板厚]-[公差]|桁=2}' })]));
        list.appendChild(el('div', { class: 'field-label' }, [icon('fa-gear'), ' ツールの値（ページ・枚数など）']));
        VAR_HELP.forEach(([name, desc]) => list.appendChild(el('button', { class: 'rp-col', type: 'button', disabled: !ok, title: desc, onclick: () => api.insert(`{${name}}`, CDB.blockCompile.VARS[name]) },
          [icon('fa-hashtag', 'rp-col-grip'), el('span', { class: 'grow', text: `{${name}}` }), el('span', { class: 'muted', text: desc })])));
        list.appendChild(el('div', { class: 'note' }, [icon('fa-circle-info'), el('div', {}, [
          el('div', { text: '= で始めると式になります（例：=ROUND([幅],1) ／ =SUM(C3:C5)）。' }),
          el('div', { text: 'C3 や C3:C5 は、同じ表の別のセルの値です。' })])]));
      }
      paint();
      if (sc) sc.scrollTop = top;
    }
    // 入力中に押しても、入力欄からフォーカスが外れない（外れると入力が確定して、カーソル・選択が失われる）。入力中でなければ、ドラッグで置けるよう何もしない
    host.addEventListener('mousedown', (e) => { if (api.isEditing && api.isEditing() && e.target.closest('.rp-col')) e.preventDefault(); });
    st.onChange(() => render());
    return { render: () => render(true) };
  }

  /* ---------- 選んだセルの設定 ---------- */
  function createCell(host, api) {
    const st = api.st;
    function render() {
      host.innerHTML = '';
      if (st.kind() !== 'cell') {
        host.appendChild(el('span', { class: 'muted', text: '表のセルを選ぶと、中身と、空のときの文字・単位をここで決められます' }));
        return;
      }
      const t = st.table();
      const sel = st.sel();
      const cell = t.cells[BD().key(sel.ar, sel.ac)] || {};
      const x = cell.x || {};
      const text = cell.t === undefined ? '' : String(cell.t);
      const ta = el('textarea', { class: 'input bk-formula-bar', rows: 3, 'aria-label': '中身（文字・{変数}・式）', placeholder: '文字／{列名} や {=式} を混ぜた文字／=式', spellcheck: 'false' });
      ta.value = text;
      ta.addEventListener('change', () => { st.ops.setText(sel.tableId, sel.ar, sel.ac, ta.value); U.flash(ta); });
      // 変数ごとの書式（桁・区切り・前後・空・埋め）：セルの中の {…} を並べ、入力すると文字（{名前|桁=2|…}）に書き換える
      const toks = /^\s*[=＝]/.test(text) ? [] : CDB.blockCompile.tokensOf(text);
      const varBox = !toks.length ? null : el('div', { class: 'bk-vprops' }, [
        el('div', { class: 'field-label', text: '変数の書式（桁など）' }),
        ...toks.map((tk) => {
          const apply = (patch) => {
            const props = Object.assign({}, tk.props, patch);
            Object.keys(props).forEach((k) => { if (props[k] === '' || props[k] === undefined || props[k] === false || Number.isNaN(props[k])) delete props[k]; });
            const raw = CDB.blockCompile.serializeVar(tk.name, props);
            st.ops.setText(sel.tableId, sel.ar, sel.ac, text.slice(0, tk.start) + raw + text.slice(tk.end));
          };
          const num = (label, key, min, max, ph) => { const i = el('input', { class: 'input rp-short', type: 'number', min, max, value: tk.props[key] === undefined ? '' : String(tk.props[key]), placeholder: ph, 'aria-label': `${tk.name} の${label}` }); i.addEventListener('change', () => apply({ [key]: i.value === '' ? undefined : Math.max(min, Math.min(max, Number(i.value))) })); i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) i.blur(); }); return el('label', { class: 'rp-cell-field' }, [el('span', { text: label }), i]); };
          const txt = (label, key, ph) => field(label, tk.props[key], (v) => apply({ [key]: v }), { cls: 'rp-short', placeholder: ph });
          const comma = el('input', { type: 'checkbox' });
          comma.checked = !!tk.props.comma;
          comma.addEventListener('change', () => apply({ comma: comma.checked }));
          const ruleSel = UI.select([{ value: '', label: '指定なし' }, { value: 'half_up', label: '規則B（四捨五入）' }, { value: 'half_even', label: '規則A（偶数丸め）' }, { value: 'ceil', label: '切り上げ' }, { value: 'floor', label: '切り捨て' }], tk.props.round || '', { 'aria-label': `${tk.name} の丸め規則`, title: '桁と一緒に指定します。選ぶと、データ側の丸めの前の元の値から丸めます' });
          ruleSel.addEventListener('change', () => apply({ round: ruleSel.value }));
          // docMaker：CDB の【特別な機能】（板番号の連続まとめ・検査番号の自動付与）は取り込んでいない
          const hint = null;
          return el('div', { class: 'bk-vrow' }, [
            el('b', { class: 'bk-var', text: `{${tk.name}}` }),
            hint,
            el('div', { class: 'row wrap' }, [num('桁', 'digits', 0, 15, '自動'), el('label', { class: 'rp-cell-field' }, [el('span', { text: '丸め' }), ruleSel]), num('埋', 'pad', 0, 10, '0埋め')]),
            el('div', { class: 'bk-checks' }, [el('label', { class: 'check', title: '桁区切り（1,234）。桁も一緒に指定します' }, [comma, '桁区切り'])]),
            el('div', { class: 'row wrap' }, [txt('前', 'pre', '約'), txt('後', 'post', 'mm'), txt('空', 'blank', '－')]),
            tk.bad.length ? el('div', { class: 'reason', text: `読めない書式：${tk.bad.join('・')}` }) : null
          ]);
        }),
        toks.some((k) => k.props.range) ? null : el('span', { class: 'muted', text: '計算した値を文字の途中に入れるには {=[板厚]-[公差]|桁=2} のように書きます。手で書いても同じです：{板厚|桁=2}・{金額|桁=0|区切り|後=円}・{板番号|埋=3}・{板厚|桁=2|丸=A}。桁は四捨五入（丸めの規則を選べます）で、数値でない値はそのまま出します' })
      ]);
      const kind = /^\s*[=＝]/.test(text) ? '式' : /\{[^{}]+\}/.test(text) ? '文字と変数' : text ? '固定の文字' : '空';
      const inRep = !!t.rep && sel.ar === t.rep.top;
      const set = (k) => (v) => st.ops.setCellExtra({ [k]: v });
      const digits = x.fmt && x.fmt.type === 'number' ? x.fmt.digits : '';
      const digitsIn = el('input', { class: 'input rp-short', type: 'number', min: 0, max: 10, value: digits === undefined ? '' : String(digits), placeholder: '自動', 'aria-label': '小数の桁数' });
      const cellFmt = (patch) => { const f = Object.assign({ type: 'number', digits: x.fmt && x.fmt.digits !== undefined ? x.fmt.digits : '', comma: !!(x.fmt && x.fmt.comma) }, x.fmt && x.fmt.round ? { round: x.fmt.round } : {}, patch); if (!f.round) delete f.round; return f; };
      digitsIn.addEventListener('change', () => { const v = digitsIn.value; st.ops.setCellExtra({ fmt: v === '' ? '' : cellFmt({ digits: Number(v) }) }); });
      const comma = el('input', { type: 'checkbox' });
      comma.checked = !!(x.fmt && x.fmt.comma);
      comma.addEventListener('change', () => st.ops.setCellExtra({ fmt: cellFmt({ comma: comma.checked }) }));
      const cellRule = UI.select([{ value: '', label: '指定なし（四捨五入）' }, { value: 'half_up', label: '規則B（四捨五入）' }, { value: 'half_even', label: '規則A（偶数丸め）' }, { value: 'ceil', label: '切り上げ' }, { value: 'floor', label: '切り捨て' }], x.fmt && x.fmt.round ? x.fmt.round : '', { 'aria-label': 'セル全体の丸め規則', title: '小数桁数と一緒に指定します。選ぶと、データ側の丸めの前の元の値から丸めます' });
      cellRule.addEventListener('change', () => { if (digitsIn.value === '') { UI.toast({ type: 'info', text: '先に小数の桁数を入れてください（規則は桁と一緒に効きます）' }); cellRule.value = x.fmt && x.fmt.round ? x.fmt.round : ''; return; } st.ops.setCellExtra({ fmt: cellFmt({ round: cellRule.value }) }); });
      const rep = el('input', { type: 'checkbox' });
      try { rep.checked = localStorage.getItem('cdb.block.typeReplace') === '1'; } catch (_) { /* 保存できない環境では標準のまま */ }
      rep.addEventListener('change', () => { try { localStorage.setItem('cdb.block.typeReplace', rep.checked ? '1' : '0'); } catch (_) { /* 今回だけ */ } UI.toast({ type: 'info', text: rep.checked ? '選んだセルに打ち始めると、今の文字を置き換えます（Excel と同じ）' : '選んだセルに打ち始めると、今の文字の末尾に足します', duration: 3500 }); });
      // 板の表の行のセル：行ごとに出し分ける（1 行目だけ・2 行目以降だけ・1 行目だけ別の値）
      const inRepRows = !!t.rep && sel.ar >= t.rep.top && sel.ar <= t.rep.bottom;
      const rowsSel = UI.select([{ value: '', label: 'すべての行' }, { value: 'first', label: '1 行目だけ' }, { value: 'rest', label: '2 行目以降だけ' }], x.rows || '', { 'aria-label': '表示する行', title: '板の表の何行目に出すか' });
      rowsSel.addEventListener('change', () => st.ops.setCellExtra({ rows: rowsSel.value }));
      const repRows = !inRepRows ? null : el('div', { class: 'bk-reprows' }, [
        el('div', { class: 'field-label', text: '板の表の行ごとの出し分け' }),
        el('div', { class: 'row wrap' }, [el('label', { class: 'rp-cell-field' }, [el('span', { text: '表示する行' }), rowsSel])]),
        field('1 行目だけ別の値', x.first, set('first'), { placeholder: '例：規格値（{列名} も可）。以降の行は上の中身' }),
        el('span', { class: 'muted', text: '例：中身を空にして「1 行目だけ別の値」に固定値を入れると、1 行目だけに出ます。同じことは、中身に {=IF(ROWNO()=1,"固定値",[列名])} のように関数で書いても行えます（ROWNO() は板の表の行番号。ほかの関数や条件も自由に組み合わせられます）。' })
      ]);
      // 一定間隔の罫線：板の表は「全体の N 行ごと」、列は「N 列ごと」。普段の線は、罫線のメニューで決める（例：点線）。ここでは、区切りの線だけを決める
      const LINE_LABELS = { hair: '極細（実線）', thin: '細い実線', dotted: '点線', dashed: '破線', medium: '太い実線', thick: '極太', double: '二重線' };
      const ruleRow = (which, label, unit, rule, title) => {
        const n = el('input', { class: 'input rp-short', type: 'number', min: 1, max: 999, value: rule ? String(rule.every) : '', placeholder: '例：10', 'aria-label': `${label}の間隔` });
        const sty = UI.select(Object.keys(LINE_LABELS).map((v) => ({ value: v, label: LINE_LABELS[v] })), rule ? rule.style : 'medium', { 'aria-label': `${label}の線` });
        const go = () => st.ops.setRule(which, n.value === '' ? null : { every: Number(n.value), style: sty.value });
        n.addEventListener('change', go);
        n.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) n.blur(); });
        sty.addEventListener('change', () => { if (n.value !== '') go(); else UI.toast({ type: 'info', text: `先に間隔（何${unit}ごとか）を入れてください` }); });
        return el('div', { class: 'row wrap', title }, [el('span', { text: label }), n, el('span', { class: 'muted', text: `${unit}ごと` }), sty]);
      };
      const rules = t.rules || {};
      const ruleBox = el('div', { class: 'bk-rules' }, [
        el('div', { class: 'field-label', text: '一定間隔の罫線（区切り線）' }),
        t.rep ? ruleRow('rows', '板の行', '行', rules.rows, '板の表の、全体の何枚目ごとに、その行の下へ線を引くか（ページをまたいでも続きます）') : null,
        ruleRow('cols', '列', '列', rules.cols, '何列ごとに、その列の右へ線を引くか（表の全部の行）'),
        el('span', { class: 'muted', text: '色は黒です。普段の線（点線など）は「罫線」のメニューで決め、ここでは、10 行ごとなどの区切りの線だけを決めます。空にすると解除です。' })
      ]);
      // 板の表の行のまとめ方：板ごと（標準）／列の値ごと（検査番号ごとに 1 行など。昇順に並ぶ）
      const byCols = (api.getColumns ? api.getColumns() : []).filter((c) => c.side === 'plate' || c.side === 'master');
      const byOpts = [{ value: '', label: '板ごとに 1 行（標準）' }].concat(byCols.map((c) => ({ value: c.id, label: `${c.label} ごとに 1 行（${c.side === 'plate' ? '板' : '元データ'}の列）` })));
      if (t.repBy && !byCols.some((c) => c.id === t.repBy)) byOpts.push({ value: t.repBy, label: `${t.repBy.slice(2)} ごとに 1 行（今のデータにない列）` });
      const bySel = UI.select(byOpts, t.repBy || '', { 'aria-label': '板の表の行のまとめ方', title: '列を選ぶと、その列の値が同じ板を 1 行にまとめ、値の昇順に並べます' });
      bySel.addEventListener('change', () => { st.ops.setRepBy(bySel.value); });
      // 見出しのバッジ兼用：押すと、行のまとめ方を切り替えられる（板ごと／検査番号ごとなど）
      const badgeOpts = byOpts.map((o) => ({ value: o.value, label: '↓ ' + o.label.replace('ごとに 1 行', 'ごと').replace('（板の列）', '（板）').replace('（元データの列）', '（元）') }));
      const badgeSel = UI.select(badgeOpts, t.repBy || '', { 'aria-label': '板の表の行のまとめ方（押して切り替え）', title: '板の表の行です。押すと、1 行を「板 1 枚」にするか「検査番号が同じ板のまとまり」にするかを切り替えられます' });
      badgeSel.classList.add('bk-bybadge');
      badgeSel.addEventListener('change', () => { bySel.value = badgeSel.value; bySel.dispatchEvent(new Event('change')); });
      const byBox = !t.rep ? null : el('div', { class: 'bk-rules' }, [
        el('div', { class: 'field-label', text: '板の表の行のまとめ方' }),
        el('div', { class: 'row wrap' }, [bySel]),
        el('span', { class: 'muted', text: '列を選ぶと、その列の値が同じ行を 1 行にまとめます（値の昇順）。' })
      ]);
      host.append(...[
        el('div', { class: 'row' }, [el('b', { text: `${t.name} ${st.addr()}` }), el('span', { class: 'badge', text: kind }), inRep ? badgeSel: null]),
        ta,
        varBox,
        repRows,
        byBox,
        ruleBox,
        field('値が空のとき', x.blank, set('blank'), { placeholder: '例：－' }),
        field('この値も空とみなす', (x.blankAs || []).join('、'), (v) => st.ops.setCellExtra({ blankAs: v.split(/[、,]/).map((s) => s.trim()).filter(Boolean) }), { placeholder: '例：-、－（0 は指定しない限り空にしません）' }),
        el('div', { class: 'row wrap' }, [field('前の文字', x.pre, set('pre'), { cls: 'rp-short', placeholder: '約' }), field('後ろの文字（単位）', x.post, set('post'), { cls: 'rp-short', placeholder: '枚・mm' })]),
        el('div', { class: 'row wrap' }, [el('label', { class: 'rp-cell-field', title: 'セル全体の数値の小数桁数。変数ごとには、上の「変数の書式」で決めます' }, [el('span', { text: 'セル全体の小数桁数' }), digitsIn]), el('label', { class: 'rp-cell-field' }, [el('span', { text: '丸め' }), cellRule]), el('label', { class: 'check' }, [comma, '桁区切り（1,234）'])]),
        el('label', { class: 'check', title: '標準は、選んだセルに文字を打ち始めると今の文字の末尾に足します（うっかり上書きを防ぐため）。オンにすると、Excel と同じく置き換えます。この設定は、このパソコンのブラウザに保存されます' }, [rep, '打ち始めたら、今の文字を置き換える（Excel と同じ）'])
      ].filter(Boolean));
    }
    st.onChange(render);
    return { render };
  }

  UI.blockSide = { createPage, createVars, createCell };
})();
