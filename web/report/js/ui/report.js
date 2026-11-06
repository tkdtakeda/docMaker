/* =========================================================
   js/ui/report.js : 帳票出力の画面（テンプレートの登録・プレビュー・配置・Excel／PDF 出力）
   レイアウト：［脇のパネル：帳票名・テンプレート・変換表・出力］［プレビュー（主役）］
   ・プレビューのセルをクリック → その位置に出す項目を選ぶ（出力先はプレビューで選ぶ）
   ・「配置」と「出力イメージ」を切り替えて、置いた場所と実際の値を見比べる
   ・主要動作は右下の「Excel を出力」1 つ。PDF は隣の通常ボタン（印刷画面で PDF に保存）
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const U = CDB.util;
  const UI = CDB.ui;
  const RM = CDB.reportModel;
  const RX = CDB.reportXlsx;
  const RR = CDB.reportRender;
  const RI = CDB.reportItems;
  const { el, icon, fmt } = U;

  const LAST_PREF = 'cdb.report.last';
  const PANEL_PREF = 'cdb.report.panel';
  const MAX_TEMPLATE_MB = 15;
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 2;

  const pref = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* 保存できない環境では今回限り */ } }
  };

  /**
   * @param {{getColumns:Function, getViewRows:Function, getMasters:Function}} ctx
   */
  function open(ctx) {
    const st = {
      presets: [], preset: null, templates: [], template: null,
      wbCache: new Map(), model: null, modelError: '',
      lots: [], // 1 枚ごとのまとまり（プリセットを選んだときに作る）
      lotIdx: 0, pageIdx: 0,
      mode: ctx.mode || 'design', zoom: 1, fitted: false, // docMaker：③ から開くときは出力イメージで開く（ctx.mode）
      placing: null, pickTable: null, pickTop: null,
      panelOpen: pref.get(PANEL_PREF, '1') === '1',
      scope: 'all', job: null, flashKey: null,
      records: [], issued: new Map(), applied: null // 作成済の履歴・有効なキー・ルールを当てた結果
    };
    const columns = () => ctx.getColumns().filter((c) => c.side === 'master' || c.side === 'plate');
    const lot = () => st.lots[st.lotIdx] || null;
    const groupBy = () => (st.preset && st.preset.groupBy) || '';
    /** 1 枚の呼び名（まとめる単位。既定は「ロット」） */
    const unit = () => RM.unitName(groupBy(), columns());
    /** 1 枚ごとのまとまりを作り直す（データ・プリセット・まとめる単位が変わったとき） */
    function rebuildLots() {
      const built = RM.buildLots(ctx.getViewRows(), ctx.getMasters(), groupBy());
      // 帳票ごとのルール（載せない板・使い切り）を当てる。メイン画面のデータは変えない
      // docMaker：帳票ごとのルール（NG・ステータス・使い切り）は取り込んでいない。まとまりをそのまま使う
      st.applied = { lots: built, excluded: 0, skippedDone: 0, plates: 0, perGroup: [] };
      st.lots = st.applied.lots;
      st.lotIdx = Math.min(st.lotIdx, Math.max(0, st.lots.length - 1));
      st.pageIdx = 0;
    }

    /* ---------- 要素 ---------- */
    const presetSel = el('select', { class: 'select', title: '帳票プリセットを切り替える', 'aria-label': '帳票プリセット' });
    const saveState = el('span', { class: 'rp-save muted' });
    const presetMenu = el('div', { class: 'menu', role: 'menu', hidden: true }, [
      el('button', { type: 'button', onclick: () => { presetMenu.hidden = true; duplicatePreset(); } }, [icon('fa-copy'), '複製']),
      el('button', { type: 'button', class: 'is-danger', onclick: () => { presetMenu.hidden = true; removePreset(); } }, [icon('fa-trash-can'), '削除（取り消せます）'])
    ]);
    document.addEventListener('click', () => { presetMenu.hidden = true; });
    const headExtra = el('div', { class: 'row' }, [
      icon('fa-file-invoice'), presetSel,
      el('button', { class: 'icon-btn', type: 'button', title: '新しい帳票プリセット', onclick: () => newPreset() }, [icon('fa-plus')]),
      // 複製・削除は主要な操作ではないので ⋮ の中に置く（閉じる ✕ の隣に削除を置かない）
      el('div', { class: 'menu-wrap' }, [
        el('button', { class: 'icon-btn', type: 'button', title: 'この帳票の操作（複製・削除）', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); presetMenu.hidden = !presetMenu.hidden; } }, [icon('fa-ellipsis-vertical')]),
        presetMenu
      ]),
      saveState
    ]);

    const nameBox = el('div', { class: 'sec-body' });
    const templateBox = el('div', { class: 'sec-body' });
    const itemsHost = el('div', { class: 'sec-body' });
    const outputBox = el('div', { class: 'sec-body' });
    const rulesBox = el('div', { class: 'sec-body' });
    const secTemplate = el('details', { class: 'sec' }, [el('summary', {}, [icon('fa-file-excel'), 'テンプレート', icon('fa-chevron-right', 'chev')]), templateBox]);
    const secItems = el('details', { class: 'sec', open: true }, [el('summary', {}, [icon('fa-table-list'), '変換表（項目）', icon('fa-chevron-right', 'chev')]), itemsHost]);
    const secOutput = el('details', { class: 'sec' }, [el('summary', {}, [icon('fa-file-export'), '出力の範囲', icon('fa-chevron-right', 'chev')]), outputBox]);
    const secRules = el('details', { class: 'sec', open: true }, [el('summary', {}, [icon('fa-ban'), '出力ルール・履歴', icon('fa-chevron-right', 'chev')]), rulesBox]);
    // 出力ルール・履歴は、出すたびに見る（件数・解除）ので、長い変換表の上に置く
    const cellBox = el('div', { class: 'sec-body' });
    const colsBox = el('div', { class: 'sec-body' });
    const secCell = el('details', { class: 'sec', open: true }, [el('summary', {}, [icon('fa-object-group'), '選んだセルの設定', icon('fa-chevron-right', 'chev')]), cellBox]);
    const secCols = el('details', { class: 'sec', open: true }, [el('summary', {}, [icon('fa-database'), 'データの列と変数（クリックでセルに入れる）', icon('fa-chevron-right', 'chev')]), colsBox]);
    const pageBox = el('div', { class: 'sec-body' });
    const secPage = el('details', { class: 'sec', open: true }, [el('summary', {}, [icon('fa-file-lines'), 'ページ設定（用紙・余白・ページ送り）', icon('fa-chevron-right', 'chev')]), pageBox]);
    // 帳票の基本（名前・1 枚にまとめる単位）は、作り始めに 1 回決めたらあまり触らないので、ツールで作る帳票では一番下に折りたたむ
    const basicSum = el('span', { class: 'muted rp-basic-sum' });
    const secBasic = el('details', { class: 'sec' }, [el('summary', {}, [icon('fa-id-card'), '帳票の基本', basicSum, icon('fa-chevron-right', 'chev')]), nameBox]);
    const panel = el('div', { class: 'rp-panel' });
    /** パネルの並び：ツールで作る帳票は「選んだセル → データの列 → 用紙 → ルール → 変換表 → 出力 → 基本」、ひな形の帳票は従来どおり */
    function layoutPanel() {
      const kind = native() ? 'n' : 'l';
      if (panel.dataset.kind === kind) return;
      panel.dataset.kind = kind;
      if (kind === 'n') {
        panel.replaceChildren(secCell, secCols, secPage, secItems, secOutput, secBasic);
        secPage.open = false; secRules.open = false; secItems.open = false; secBasic.open = false;
      } else {
        panel.replaceChildren(secBasic, secTemplate, secItems, secOutput);
        secBasic.open = true; secRules.open = true; secItems.open = true;
      }
    }

    const toolbar = el('div', { class: 'rp-toolbar' });
    const banner = el('div', { class: 'rp-banner', hidden: true });
    const notes = el('div');
    const zoomBox = el('div', { class: 'rp-zoom-box' });
    const scroll = el('div', { class: 'rp-scroll', tabindex: '0' }, [zoomBox]);
    const sheetBar = el('div', { class: 'rp-sheetbar', hidden: true });
    const center = el('div', { class: 'rp-center' }, [toolbar, sheetBar, banner, notes, scroll]);
    const body = el('div', { class: 'rp-body' }, [panel, center]);
    const reasons = el('div', { class: 'grow' });
    const pdfBtn = el('button', { class: 'btn', type: 'button' });
    const xlsBtn = el('button', { class: 'btn btn-primary', type: 'button' });
    const foot = el('div', { class: 'row grow' }, [reasons, pdfBtn, xlsBtn]);
    const fileInput = el('input', { type: 'file', accept: '.xlsx,.xlsm', hidden: true });

    const modal = UI.openModal({ title: '帳票', icon: 'fa-file-invoice', size: 'full', body, foot, headExtra, onClose: cleanup });
    modal.root.querySelector('.modal-body').style.overflow = 'hidden';
    scroll.tabIndex = 0;
    modal.root.appendChild(fileInput);

    const itemsTable = UI.reportItems.createTable(itemsHost, {
      getPreset: () => st.preset,
      getColumns: columns,
      getLot: lot,
      changed,
      startPlacing,
      placingId: () => st.placing
    });

    const rulesUi = { render() {} }; // docMaker：出力ルール・作成済の履歴は取り込んでいない

    /* ---------- ツールで作る帳票の編集（js/ui/block-state.js・block-canvas.js・block-bar.js・block-side.js） ---------- */
    const native = () => RM.isNative(st.preset);
    const blocky = () => RM.isBlock(st.preset);
    /** 式・{変数} で使う列の名前（元データと板で同じ名前があるときは 元: / 板: を付ける） */
    const varName = (colId) => { const c = columns().find((x) => x.id === colId); return c ? RM.refName(c, columns()) : String(colId).slice(2); };
    const bs = UI.blockState.create({ getPreset: () => st.preset, changed: () => onLayoutChanged() });
    const canvas = UI.blockCanvas.create({
      st: bs, host: scroll, root: modal.root, getPreset: () => st.preset, getZoom: () => st.zoom, varName, getColumns: columns,
      redraw: () => { zoomBox.innerHTML = ''; const wrap = canvas.render(zoomBox); wrap.style.zoom = String(st.zoom); }
    });
    const bar = UI.blockBar.create(sheetBar, { st: bs, canvas, getColumns: columns });
    // 操作バーの高さは選んだもので変わる（セルは 2 段・そのほかは 1 段）。変わった分だけ用紙をスクロールして、見えている位置を動かさない
    // （動くと、「もう一度クリック」が別のセルに当たる）
    let barH = 0;
    const barWatch = new ResizeObserver(() => {
      const h = sheetBar.hidden ? 0 : sheetBar.offsetHeight;
      if (barH > 0 && h > 0 && h !== barH && st.mode === 'design') scroll.scrollTop += h - barH;
      barH = h;
    });
    barWatch.observe(sheetBar);
    const pageUi = UI.blockSide.createPage(pageBox, { st: bs, getPreset: () => st.preset });
    const cellUi = UI.blockSide.createCell(cellBox, { st: bs, getColumns: columns });
    const colsUi = UI.blockSide.createVars(colsBox, { st: bs, getColumns: columns, getPreset: () => st.preset, varName, insert: (text, expr, back) => canvas.insertText(text, expr, back), isEditing: () => canvas.isEditing() });

    /** 行・列・書式・用紙が変わった：モデルと 1 ページの行数が変わるので、ロットのまとまりとプレビューを作り直す */
    function onLayoutChanged() {
      if (!native()) return;
      st.model = CDB.sheetPages.toModel(st.preset.doc, st.preset.name);
      rebuildLots();
      changed('table');
      pageUi.render();
      itemsTable.render();
      rulesUi.render();
      renderOutputBox();
    }

    /* ---------- 作成済の記録（docMaker：取り込んでいない。出力の呼び出しはそのまま残すため、何もしない形で置く） ---------- */
    async function loadIssued() { st.records = []; st.issued = new Map(); }
    async function recordIssue() { /* 作成済は記録しない */ }

    /* ---------- 保存（自動） ---------- */
    const saveSoon = U.debounce(async () => {
      if (!st.preset) return;
      await RM.savePreset(st.preset);
      st.dirty = false;
      saveState.innerHTML = '';
      saveState.append(icon('fa-circle-check'), ' 保存しました');
      U.flash(saveState);
    }, 400);
    const previewSoon = U.debounce(() => renderPreview(), 150);

    /** 変更の通知。what: 'items'|'places'|'table'|'label'|'value'|'meta' */
    function changed(what) {
      st.dirty = true; // 保存前の変更（一覧を読み直しても、この変更を捨てない）
      saveSoon();
      if (what === 'label' || what === 'value') previewSoon();
      else { renderPreview(); renderToolbar(); renderFoot(); }
      if (what === 'meta') renderPresetSel();
    }

    /* ---------- 読み込み ---------- */
    async function reloadLists(selectId) {
      const editing = st.dirty ? st.preset : null; // 保存前の変更がある帳票は、保存済みの古い内容で上書きしない
      st.presets = await RM.listPresets();
      if (editing) { const i = st.presets.findIndex((x) => x.id === editing.id); if (i >= 0) st.presets[i] = editing; }
      st.templates = await RM.listTemplates();
      const id = selectId || (st.preset && st.preset.id) || pref.get(LAST_PREF, '');
      st.preset = st.presets.find((p) => p.id === id) || st.presets[0] || null;
      await selectPreset(st.preset);
    }

    async function selectPreset(p) {
      // 別の帳票に替えたときだけ、選択・取り消しの控え・前の出力結果の表示を捨てる（メイン画面の絞り込みを変えただけでは残す）
      if (!st.preset || !p || st.preset.id !== p.id) {
        bs.reset();
        if (st.job && st.job.job.ended) st.job = null;
      }
      st.preset = p;
      st.placing = null;
      st.pickTable = null;
      if (p) pref.set(LAST_PREF, p.id);
      st.template = p ? st.templates.find((t) => t.id === p.templateId) || null : null;
      await loadIssued();
      rebuildLots();
      await loadModel();
      secTemplate.open = !st.template;
      renderAll();
    }

    async function loadModel() {
      st.model = null;
      st.modelError = '';
      st.fitted = false;
      if (native()) { st.model = CDB.sheetPages.toModel(st.preset.doc, st.preset.name); return; }
      const t = st.template;
      if (!t || !st.preset) return;
      try {
        let wb = st.wbCache.get(t.id);
        if (!wb) { wb = await RX.load(t.buffer); st.wbCache.set(t.id, wb); }
        if (!t.sheets.includes(st.preset.sheet)) st.preset.sheet = t.sheets[0];
        st.model = RX.sheetModel(wb, st.preset.sheet);
      } catch (err) {
        st.modelError = err.message;
      }
    }

    /* ---------- 帳票プリセットの操作 ---------- */
    function renderPresetSel() {
      presetSel.innerHTML = '';
      if (!st.presets.length) presetSel.appendChild(el('option', { value: '', text: '（帳票プリセットがありません）' }));
      st.presets.forEach((p) => presetSel.appendChild(el('option', { value: p.id, text: (p.sample ? '【サンプル】' : '') + p.name.replace(/^【サンプル】/, '') })));
      presetSel.value = st.preset ? st.preset.id : '';
    }
    presetSel.addEventListener('change', () => selectPreset(st.presets.find((p) => p.id === presetSel.value) || null));

    async function newPreset(template) {
      const t = template;
      // ひな形の Excel を渡されたときだけ従来の帳票。ふだんの「新しい帳票」は、ツールで一から作る
      const p = t ? RM.newPreset(t.name, t.id, t.sheets[0]) : RM.newNativePreset(`帳票 ${st.presets.length + 1}`);
      await RM.savePreset(p);
      st.presets.push(p);
      await selectPreset(p);
      UI.toast({ type: 'ok', text: `帳票プリセット「${p.name}」を作りました`, undo: async () => { await RM.removePreset(p.id); await reloadLists(); } });
      const nameInput = nameBox.querySelector('input');
      if (nameInput) { nameInput.focus(); nameInput.select(); }
    }

    async function duplicatePreset() {
      if (!st.preset) return;
      const p = RM.duplicate(st.preset);
      await RM.savePreset(p);
      st.presets.push(p);
      await selectPreset(p);
      UI.toast({ type: 'ok', text: `「${p.name}」を作りました`, undo: async () => { await RM.removePreset(p.id); await reloadLists(); } });
    }

    async function removePreset() {
      if (!st.preset) return;
      const p = st.preset;
      const res = await RM.removePreset(p.id);
      st.preset = null;
      await reloadLists('none');
      UI.toast({ type: 'ok', text: `帳票プリセット「${p.name}」を削除しました`, undo: async () => { await res.undo(); await reloadLists(p.id); } });
    }

    /* ---------- テンプレート ---------- */
    async function addTemplateFile(file) {
      if (!file) return;
      if (!/\.(xlsx|xlsm)$/i.test(file.name)) {
        UI.toast({ type: 'warn', text: `「${file.name}」は使えません。Excel で .xlsx 形式に保存し直してから入れてください（.xls・.csv は不可）` });
        return;
      }
      if (file.size > MAX_TEMPLATE_MB * 1024 * 1024) {
        UI.toast({ type: 'warn', text: `ファイルが大きすぎます（${MAX_TEMPLATE_MB}MB まで）。不要なシートや画像を消してから入れてください` });
        return;
      }
      try {
        const buffer = await file.arrayBuffer();
        const info = await RX.inspect(buffer);
        const t = { id: U.uid('tpl'), name: file.name.replace(/\.[^.]+$/, ''), fileName: file.name, size: file.size, buffer, sheets: info.sheets, addedAt: Date.now() };
        await RM.saveTemplate(t);
        st.templates.unshift(t);
        if (!st.preset) { await newPreset(t); }
        else {
          st.preset.templateId = t.id;
          st.preset.sheet = t.sheets[0];
          st.template = t;
          await loadModel();
          changed('table');
          renderAll();
        }
        UI.toast({ type: 'ok', text: `テンプレート「${t.fileName}」（${t.sheets.length} シート）を登録しました`, undo: async () => { await RM.removeTemplate(t.id); await reloadLists(); } });
      } catch (err) {
        UI.toast({ type: 'err', text: `テンプレートを読めませんでした：${err.message}` });
      }
    }

    async function useTemplate(t) {
      st.preset.templateId = t.id;
      if (!t.sheets.includes(st.preset.sheet)) st.preset.sheet = t.sheets[0];
      st.template = t;
      await loadModel();
      changed('table');
      renderAll();
    }

    async function deleteTemplate(t) {
      const res = await RM.removeTemplate(t.id);
      st.wbCache.delete(t.id);
      const users = st.presets.filter((p) => p.templateId === t.id).length;
      await reloadLists();
      UI.toast({ type: 'ok', text: `テンプレート「${t.fileName}」を削除しました${users ? `（${users} 件の帳票プリセットが使っていました）` : ''}`, undo: async () => { await res.undo(); await reloadLists(); } });
    }

    function dropzone(big) {
      const dz = el('div', { class: 'dropzone' + (big ? ' rp-drop-big' : ''), tabindex: '0', role: 'button' }, [
        icon('fa-file-excel'),
        el('b', { text: 'テンプレートの Excel（.xlsx）を入れる' }),
        el('span', { class: 'muted', text: 'ドラッグ＆ドロップ／クリックで選ぶ／ファイルをコピーして Ctrl+V' })
      ]);
      dz.addEventListener('click', () => fileInput.click());
      dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('is-over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('is-over'));
      dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('is-over'); addTemplateFile(e.dataTransfer.files[0]); });
      return dz;
    }
    fileInput.addEventListener('change', () => { addTemplateFile(fileInput.files[0]); fileInput.value = ''; });
    const onPaste = (e) => {
      const f = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
      if (f && /\.(xlsx|xlsm)$/i.test(f.name)) { e.preventDefault(); addTemplateFile(f); }
    };
    document.addEventListener('paste', onPaste);

    function renderTemplateBox() {
      templateBox.innerHTML = '';
      if (native()) { templateBox.appendChild(el('span', { class: 'muted', text: 'ツールで作った帳票です（Excel のひな形は使いません）' })); return; }
      // 入れる場所は 1 か所だけにする：プレビューが空の間は中央の大きな枠、プレビューが出たらここ（差し替え用）
      if (st.preset && st.model) templateBox.appendChild(dropzone(false));
      else templateBox.appendChild(el('div', { class: 'muted', text: '中央の枠にテンプレートの Excel を入れてください' }));
      if (!st.templates.length) return;
      templateBox.appendChild(el('div', { class: 'field-label', text: '登録済みのテンプレート（クリックで使う）' }));
      st.templates.forEach((t) => {
        const cur = st.template && st.template.id === t.id;
        templateBox.appendChild(el('div', { class: 'list-item' + (cur ? ' is-current' : '') }, [
          el('button', { class: 'btn btn-ghost btn-sm grow', type: 'button', disabled: !st.preset, title: cur ? '使用中' : 'この帳票プリセットで使う', onclick: () => useTemplate(t) }, [
            icon(cur ? 'fa-circle-check' : 'fa-file-excel'), el('span', { class: 'grow', text: t.fileName }),
            el('span', { class: 'muted', text: `${t.sheets.length}シート` })
          ]),
          el('button', { class: 'icon-btn is-danger', type: 'button', title: 'テンプレートを削除（取り消せます）', onclick: () => deleteTemplate(t) }, [icon('fa-trash-can')])
        ]));
      });
      if (st.template && st.template.sheets.length > 1) {
        const sel = UI.select(st.template.sheets.map((s) => ({ value: s, label: s })), st.preset.sheet);
        sel.addEventListener('change', async () => { st.preset.sheet = sel.value; await loadModel(); changed('table'); renderAll(); });
        templateBox.appendChild(el('div', { class: 'field' }, [el('label', { text: '使うシート' }), sel]));
      }
    }

    /* ---------- 帳票名・出力の範囲 ---------- */
    function renderName() {
      nameBox.innerHTML = '';
      if (!st.preset) return;
      const input = el('input', { class: 'input', type: 'text', 'aria-label': '帳票名' });
      input.value = st.preset.name;
      input.addEventListener('change', () => { st.preset.name = U.normValue(input.value) || '帳票'; U.flash(input); changed('meta'); });
      basicSum.textContent = `${st.preset.name}／${unit()}ごと`;
      nameBox.appendChild(el('div', { class: 'field rp-name' }, [el('label', { text: '帳票名（プリセット名・出力ファイル名に使います）' }), input]));
      // 1 枚にまとめる単位（帳票ごとに違う：ロット番号・注文番号など）
      const cols = columns();
      const opts = [{ value: '', label: '元データの行ごと（引当番号ごと）' }]
        .concat(cols.filter((c) => c.side === 'master').map((c) => ({ value: c.id, label: `${c.label}（元データ）` })))
        .concat(cols.filter((c) => c.side === 'plate').map((c) => ({ value: c.id, label: c.label })));
      const gcols = RM.groupCols(groupBy());
      const setGroup = (a, b) => {
        const list = [a, b].filter(Boolean);
        st.preset.groupBy = list.length > 1 ? list : list[0] || '';
        rebuildLots();
        changed('meta');
        renderName();
        renderOutputBox();
        rulesUi.render();
      };
      const mkOpts = (cur) => (cur && !opts.some((o) => o.value === cur) ? opts.concat([{ value: cur, label: `${cur.slice(2)}（表示中のデータにありません）` }]) : opts);
      const sel = UI.select(mkOpts(gcols[0]), gcols[0] || '', { 'aria-label': '1 枚にまとめる単位（1 つ目）' });
      sel.addEventListener('change', () => { U.flash(sel); setGroup(sel.value, gcols[1]); });
      // 2 つ目（任意）：注文番号＋検査番号のように、組が同じ板を 1 枚にまとめる
      const second = UI.select([{ value: '', label: '（なし）' }].concat(opts.filter((o) => o.value)), gcols[1] || '', { 'aria-label': '1 枚にまとめる単位（2 つ目・組み合わせ）' });
      second.disabled = !gcols[0];
      second.addEventListener('change', () => { U.flash(second); setGroup(gcols[0], second.value); });
      nameBox.appendChild(el('div', { class: 'field rp-name' }, [
        el('label', { text: '1 枚にまとめる単位（組み合わせも可）' }), el('div', { class: 'row' }, [sel, el('span', { class: 'muted', text: '＋' }), second]),
        el('span', { class: 'muted', text: '同じ値（2 つ選ぶと、2 つとも同じ組）の板を 1 枚にまとめます。表の外のセルで、1 枚の中に値が複数ある項目は空欄にします（帳票には出しません）' })
      ]));
    }

    function targetLots() {
      return st.scope === 'one' ? (lot() ? [lot()] : []) : st.lots;
    }

    function renderOutputBox() {
      outputBox.innerHTML = '';
      const nAll = st.lots.length;
      const s = el('div', { class: 'seg' }, [['all', `表示中の ${fmt(nAll)} ${unit()}`], ['one', `プレビュー中の${unit()}だけ`]].map(([v, label]) => {
        const r = el('input', { type: 'radio', name: 'rpScope', value: v });
        r.checked = st.scope === v;
        r.addEventListener('change', () => { st.scope = v; renderOutputBox(); renderFoot(); });
        return el('label', {}, [r, label]);
      }));
      const lots = targetLots();
      const pages = st.preset ? lots.reduce((a, l) => a + RM.pageCount(st.preset, l, columns()), 0) : 0;
      const per = st.preset ? RM.rowsPerPage(st.preset) : Infinity;
      outputBox.append(
        s,
        el('span', { class: 'muted', text: `${fmt(lots.length)} ${unit()} → ${fmt(pages)} ページ（${st.preset && RM.isGrouped(st.preset) ? '検番などの行ごとに、行の高さでページを分けます' : `1 ページに板 ${per === Infinity ? '全部' : per + ' 枚'}`}）。対象は、メイン画面のフォルダ・絞り込み・並び順に従います。` }),
        el('div', { class: 'note' }, [icon('fa-circle-info'), el('div', {}, [
          el('div', { text: 'Excel：テンプレートの書式のまま、1 ページを 1 シートにして 1 つのファイルに出します。' }),
          el('div', { text: 'PDF：印刷の画面が開きます。送信先で「PDF に保存」を選んでください。1 ページを用紙 1 枚に収めます。' })
        ])])
      );
    }

    /* ---------- ツールバー ---------- */
    function renderToolbar() {
      toolbar.innerHTML = '';
      if (!st.preset || !st.model) return;
      const p = st.preset;
      const modeSeg = el('div', { class: 'seg' }, [['design', 'fa-location-crosshairs', '配置'], ['output', 'fa-eye', '出力イメージ']].map(([v, ic, label]) => {
        const r = el('input', { type: 'radio', name: 'rpMode', value: v });
        r.checked = st.mode === v;
        r.addEventListener('change', () => { st.mode = v; st.fitted = false; renderAll(); }); // 編集と出力イメージで、パネルの出し分け・ズームを合わせ直す
        return el('label', { title: v === 'design' ? 'どのセルに何を出すかを表示' : `選んだ${unit()}の実際の値を表示` }, [r, icon(ic), label]);
      }));
      const lotSel = el('select', { class: 'select rp-lot', 'aria-label': `プレビューする${unit()}`, title: `プレビューする${unit()}` },
        st.lots.length ? st.lots.map((l, i) => el('option', { value: i, text: l.name })) : [el('option', { value: 0, text: `（${unit()}がありません）` })]);
      lotSel.value = String(st.lotIdx);
      lotSel.addEventListener('change', () => { st.lotIdx = Number(lotSel.value); st.pageIdx = 0; renderAll(); });
      const go = (d) => () => { if (!st.lots.length) return; st.lotIdx = (st.lotIdx + d + st.lots.length) % st.lots.length; st.pageIdx = 0; renderAll(); };
      const pages = lot() ? RM.pageCount(p, lot(), columns()) : 1;
      const goPage = (d) => () => { st.pageIdx = Math.min(pages - 1, Math.max(0, st.pageIdx + d)); renderPreview(); renderToolbar(); };
      const t = p.table;
      const tableBtn = el('button', {
        class: 'btn btn-sm' + (st.pickTable ? ' is-active' : ''), type: 'button',
        title: '板を 1 枚ずつ書き込む行の範囲を、プレビューの 1 行目と最後の行をクリックして指定します',
        onclick: () => { st.pickTable = st.pickTable ? null : 'top'; st.placing = null; renderAll(); }
      }, [icon('fa-grip-lines'), t ? `板の表：${t.top + 1}～${t.bottom + 1} 行（${t.bottom - t.top + 1} 枚/ページ）` : '板の表の範囲を指定']);
      toolbar.append(...[
        el('button', { class: 'icon-btn', type: 'button', title: st.panelOpen ? '設定のパネルを閉じる' : '設定のパネルを開く', onclick: togglePanel }, [icon(st.panelOpen ? 'fa-angles-left' : 'fa-sliders')]),
        modeSeg,
        el('div', { class: 'row rp-nav' }, [
          el('button', { class: 'icon-btn', type: 'button', title: `前の${unit()}`, onclick: go(-1), disabled: st.lots.length < 2 }, [icon('fa-chevron-left')]),
          lotSel,
          el('button', { class: 'icon-btn', type: 'button', title: `次の${unit()}`, onclick: go(1), disabled: st.lots.length < 2 }, [icon('fa-chevron-right')]),
          pages > 1 ? el('span', { class: 'row' }, [
            el('button', { class: 'icon-btn', type: 'button', title: '前のページ', onclick: goPage(-1), disabled: st.pageIdx === 0 }, [icon('fa-caret-left')]),
            el('span', { class: 'muted', text: `${st.pageIdx + 1}/${pages} ページ` }),
            el('button', { class: 'icon-btn', type: 'button', title: '次のページ', onclick: goPage(1), disabled: st.pageIdx >= pages - 1 }, [icon('fa-caret-right')])
          ]) : null
        ]),
        native() ? el('span', { class: 'muted', title: '用紙・ページ送りは左のパネル「ページ設定」で変えます', text: pageUi.summary() }) : tableBtn,
        !native() && t ? el('button', { class: 'icon-btn', type: 'button', title: '板の表の範囲を解除', onclick: clearTable }, [icon('fa-xmark')]) : null,
        el('div', { class: 'grow' }),
        el('div', { class: 'row rp-zoom' }, [
          el('button', { class: 'icon-btn', type: 'button', title: '縮小', onclick: () => setZoom(st.zoom - 0.1) }, [icon('fa-magnifying-glass-minus')]),
          el('span', { class: 'muted', title: '表示だけの倍率です（帳票には保存されません）。印刷・PDF は用紙の大きさのままです', text: Math.round(st.zoom * 100) + '%' }),
          el('button', { class: 'icon-btn', type: 'button', title: '拡大', onclick: () => setZoom(st.zoom + 0.1) }, [icon('fa-magnifying-glass-plus')]),
          el('button', { class: 'icon-btn', type: 'button', title: '幅に合わせる', onclick: fit }, [icon('fa-compress')])
        ])
].filter(Boolean));
    }

    function togglePanel() {
      st.panelOpen = !st.panelOpen;
      pref.set(PANEL_PREF, st.panelOpen ? '1' : '0');
      panel.hidden = !st.panelOpen;
      renderToolbar();
    }

    function setZoom(z) {
      st.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
      const t = zoomBox.firstElementChild;
      if (t) t.style.zoom = String(st.zoom);
      renderToolbar();
    }

    function fit() {
      const t = zoomBox.firstElementChild;
      if (!t) return;
      const tb = t.matches('table') ? t : t.querySelector('table');
      const w = parseFloat(t.dataset && t.dataset.w) || parseFloat(tb.style.width) || 1; // 用紙の幅（ツールで作る帳票）か、表の幅
      let z = Math.min(1.2, (scroll.clientWidth - 24) / w);
      // 出力イメージ：用紙の下端まで 1 ページ全体が見える大きさにする（ツールで作った帳票）
      const h = parseFloat(t.dataset && t.dataset.h);
      if (native() && !blocky() && st.mode === 'output' && h) z = Math.min(z, (scroll.clientHeight - 24) / h);
      setZoom(Math.max(ZOOM_MIN, z));
    }

    scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(st.zoom + (e.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });

    /* ---------- 配置 ---------- */
    function startPlacing(id) {
      st.placing = id;
      st.pickTable = null;
      if (id) st.mode = 'design';
      renderAll();
    }

    /** クリックした位置を、配置する位置に直す（結合セルは左上、板の表の中は 1 行目） */
    function normalize(r, c) {
      const at = RX.mergeTopLeft(st.model.merges, r, c);
      const t = st.preset.table;
      const inTable = !!t && at.r > t.top && at.r <= t.bottom;
      return { r: inTable ? t.top : at.r, c: at.c, moved: inTable };
    }

    function placeAt(r, c, itemId) {
      const p = st.preset;
      const at = normalize(r, c);
      const prev = p.places.find((x) => x.r === at.r && x.c === at.c);
      if (prev) prev.item = itemId;
      else p.places.push({ id: U.uid('pl'), r: at.r, c: at.c, item: itemId, show: 'value', sep: '：' });
      st.flashKey = RR.key(at.r, at.c);
      changed('places');
      itemsTable.render();
      const it = p.items.find((x) => x.id === itemId);
      if (at.moved) UI.toast({ type: 'info', text: `板の表の中なので、${at.r + 1} 行目に置き、板ごとに下の行へ繰り返します` });
      else if (it) UI.toast({ type: 'ok', text: `「${it.label}」を ${U.cellAddr(at.r, at.c)} に配置しました` });
    }

    function removePlace(pl) {
      const p = st.preset;
      const prev = p.places.slice();
      p.places = p.places.filter((x) => x !== pl);
      changed('places');
      itemsTable.render();
      UI.toast({ type: 'ok', text: `${U.cellAddr(pl.r, pl.c)} の配置を外しました`, undo: () => { p.places = prev; changed('places'); itemsTable.render(); } });
    }

    function setTable(a, b) {
      const p = st.preset;
      const oldTop = p.table ? p.table.top : null;
      const top = Math.min(a, b);
      const bottom = Math.max(a, b);
      // 1 行目に置いた項目は、新しい 1 行目へ移す
      if (oldTop !== null) p.places.forEach((x) => { if (x.r === oldTop) x.r = top; });
      p.table = { top, bottom };
      st.pickTable = null;
      st.pageIdx = 0;
      changed('table');
      renderAll();
      UI.toast({ type: 'ok', text: `板の表を ${top + 1}～${bottom + 1} 行にしました（1 ページに ${bottom - top + 1} 枚。超える分は次のページ）` });
    }

    function clearTable() {
      const prev = st.preset.table;
      st.preset.table = null;
      changed('table');
      renderAll();
      UI.toast({ type: 'ok', text: '板の表の範囲を解除しました', undo: () => { st.preset.table = prev; changed('table'); renderAll(); } });
    }

    function onCellClick(td) {
      const r = Number(td.dataset.r);
      const c = Number(td.dataset.c);
      if (st.pickTable === 'top') { st.pickTop = r; st.pickTable = 'bottom'; renderBanner(); renderPreview(); return; }
      if (st.pickTable === 'bottom') { setTable(st.pickTop, r); return; }
      if (st.placing) { placeAt(r, c, st.placing); return; }
      const at = normalize(r, c);
      const pl = st.preset.places.find((x) => x.r === at.r && x.c === at.c) || null;
      td.classList.add('rp-sel');
      let valueText = null;
      if (pl && lot()) {
        const v = RM.renderPage(st.preset, lot(), st.pageIdx, columns()).cells.get(RR.key(at.r, at.c));
        valueText = v ? v.text : '';
      }
      const base = st.model.cells.get(RR.key(at.r, at.c));
      UI.reportItems.popover({
        anchor: td, root: modal.root, place: pl, preset: st.preset, columns: columns(), valueText,
        cellText: base ? base.text : '',
        onPick(item, isNew) {
          if (isNew) { st.preset.items.push(item); itemsTable.render(); }
          placeAt(r, c, item.id);
          if (isNew && item.kind !== 'field') { openPanel(); itemsTable.open(item.id); }
        },
        onShow(show, sep) { pl.show = show; pl.sep = sep; changed('places'); },
        onRemove() { removePlace(pl); },
        onEdit(id) { openPanel(); itemsTable.open(id); },
        onClose() { td.classList.remove('rp-sel'); }
      });
    }

    function openPanel() {
      if (!st.panelOpen) togglePanel();
      secItems.open = true;
    }

    /* ---------- プレビュー ---------- */
    function renderBanner() {
      banner.innerHTML = '';
      banner.hidden = true;
      const item = st.placing && st.preset ? st.preset.items.find((x) => x.id === st.placing) : null;
      let text = '';
      if (item) text = `「${item.label}」を配置中：置きたいセルをクリック（続けて何か所でも置けます）`;
      else if (st.pickTable === 'top') text = '板の表の 1 行目（最初の板を書く行）をクリック';
      else if (st.pickTable === 'bottom') text = `${st.pickTop + 1} 行目から、板の表の最後の行をクリック`;
      if (!text) return;
      banner.hidden = false;
      banner.append(icon(item ? 'fa-location-crosshairs' : 'fa-grip-lines'), el('span', { class: 'grow', text }),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => { st.placing = null; st.pickTable = null; renderAll(); } }, [icon('fa-xmark'), '終える（Esc）']));
    }

    function chip(iconName, text, cls) {
      return el('span', { class: 'rp-chip ' + (cls || '') }, [icon(iconName), el('span', { text })]);
    }

    function designOverlay() {
      const p = st.preset;
      const ov = new Map();
      const items = new Map(p.items.map((x) => [x.id, x]));
      const t = p.table;
      p.places.forEach((pl) => {
        const it = items.get(pl.item);
        if (!it) return;
        const kind = RI.kindOf(it);
        const text = pl.show === 'label' ? it.label : pl.show === 'both' ? `${it.label}${pl.sep === undefined ? '：' : pl.sep}{値}` : `{${it.label}}`;
        const k = RR.key(pl.r, pl.c);
        // ツールで作る帳票では、固定の文字はそのまま見せる（見出しの見た目を整えながら作れるように）
        if (native() && kind.kind === 'text' && (pl.show || 'value') === 'value') {
          ov.set(k, { text: it.text || '', cls: 'rp-place rp-place-text' + (st.flashKey === k ? ' is-flash' : ''), title: `${U.cellAddr(pl.r, pl.c)}：固定の文字「${it.text || ''}」\nダブルクリックで変更` });
          return;
        }
        ov.set(k, {
          html: chip(pl.show === 'label' ? 'fa-tag' : native() && t && pl.r === t.top ? 'fa-arrow-down' : kind.icon, text),
          cls: 'rp-place' + (st.flashKey === k ? ' is-flash' : '') + (st.placing === it.id ? ' is-active' : ''),
          title: `${U.cellAddr(pl.r, pl.c)}：${it.label}（${kind.summary(it)}）／${RM.SHOW.find((s) => s.value === (pl.show || 'value')).label}\nクリックで変更`
        });
        if (t && pl.r === t.top) {
          for (let r = t.top + 1; r <= t.bottom; r++) ov.set(RR.key(r, pl.c), { html: chip('fa-arrow-down', it.label, 'is-repeat'), cls: 'rp-repeat', title: '板ごとに繰り返す行' });
        }
      });
      st.flashKey = null;
      return ov;
    }

    /** NG で外した行の板番号（「板 9 」）。板番号の列が分かるときだけ */
    function skipLabel(r) {
      const t = st.preset.table;
      const per = RM.rowsPerPage(st.preset);
      const row = lot() && t && per !== Infinity ? lot().plates[st.pageIdx * per + (r - t.top)] : null;
      const col = columns().find((c) => /^板(番号|No\.?)$/i.test(U.normValue(c.label)));
      const v = row && col ? U.normValue(row.v[col.id]) : '';
      return v ? `板 ${v} ` : '';
    }

    function outputOverlay() {
      const ov = new Map();
      if (!lot()) return ov;
      const res = RM.renderPage(st.preset, lot(), st.pageIdx, columns());
      const skipRows = new Map(); // NG で外した板の行 → その行で一番左の置いたセル
      res.cells.forEach((v, k) => {
        if (!v.skipped) return;
        const [r, c] = k.split(',').map(Number);
        if (!skipRows.has(r) || c < skipRows.get(r)) skipRows.set(r, c);
      });
      res.cells.forEach((v, k) => {
        const multi = v.multi ? `（1 枚の中に値が複数あるため空欄：${v.multi.map((id) => id.slice(2)).join('・')}）` : '';
        ov.set(k, { text: v.text, cls: 'rp-val' + (v.error ? ' rp-err' : '') + (v.empty || v.multi ? ' is-empty' : ''), title: `${v.item.label}${v.empty ? '（板のない行は空にします）' : ''}${multi}${v.error ? '\n' + v.error.code + '：' + v.error.message : ''}` });
      });
      // NG で外した板の行：データの欠落と見分けがつくよう、画面だけに札を出す（印刷・Excel には出ません）
      skipRows.forEach((c, r) => {
        ov.set(RR.key(r, c), { html: chip('fa-ban', `${skipLabel(r)}NG 除外`, 'is-skip'), cls: 'rp-val rp-skip', title: 'この板は NG のため、帳票に載せません（印刷・Excel では空の行になります）。メイン画面のデータは変わりません' });
        res.cells.forEach((v, k) => { if (v.skipped && k !== RR.key(r, c) && k.startsWith(r + ',')) ov.set(k, { text: '', cls: 'rp-val rp-skip-cell', title: 'NG のため外しています' }); });
      });
      return ov;
    }

    function renderPreview() {
      sheetBar.hidden = !(blocky() && st.mode === 'design'); // 操作バーは配置（編集）のときだけ
      zoomBox.innerHTML = '';
      notes.innerHTML = '';
      renderBanner();
      if (!st.preset) {
        zoomBox.appendChild(el('div', { class: 'empty-state' }, [
          icon('fa-file-invoice'),
          el('h2', { text: '帳票プリセットを作りましょう' }),
          el('p', { text: 'ツールの中で、セルの結合・罫線・文字の書式・用紙の大きさまで一から作れます。' }),
          el('div', { class: 'row' }, [el('button', { class: 'btn btn-primary', type: 'button', onclick: () => newPreset() }, [icon('fa-plus'), '新しい帳票を作る'])]),
          el('p', { class: 'muted', text: 'Excel で作ったひな形を使うときは、ここに入れてください。' }),
          dropzone(true),
          el('div', { class: 'row' }, [el('button', { class: 'btn', type: 'button', onclick: () => UI.sample.open(ctx) }, [icon('fa-flask'), 'サンプルで試す'])])
        ]));
        return;
      }
      if (!st.model) {
        zoomBox.appendChild(el('div', { class: 'empty-state' }, [
          icon('fa-file-excel'),
          el('h2', { text: st.modelError ? 'テンプレートを開けませんでした' : 'テンプレートの Excel を入れてください' }),
          st.modelError ? el('p', { class: 'reason', text: st.modelError }) : el('p', { text: '帳票のひな形（罫線や見出しを書いた Excel）を入れると、ここにプレビューが出ます。' }),
          dropzone(true)
        ]));
        return;
      }
      const chk = RM.check(st.preset, st.template, st.lots, columns());
      if (st.preset.warnings && st.preset.warnings.length) chk.warnings = st.preset.warnings.concat(chk.warnings);
      // 今の 1 枚で、値が複数あるため空欄にした項目（使わないなら配置を外す）
      const page = lot() ? RM.renderPage(st.preset, lot(), st.pageIdx, columns()) : null;
      if (page && page.multi.length) {
        chk.warnings.unshift(`この${unit()}では「${page.multi.map((id) => id.slice(2)).join('・')}」の値が複数あるため空欄にしています（帳票に出さないなら配置を外してください）`);
      }
      if (chk.warnings.length) {
        notes.appendChild(el('div', { class: 'note is-warn' }, [icon('fa-triangle-exclamation'), el('div', {}, chk.warnings.slice(0, 3).map((w) => el('div', { text: w })).concat(
          chk.warnings.length > 3 ? [el('div', { text: `ほか ${chk.warnings.length - 3} 件` })] : []))]));
      }
      // 出力イメージで #REF! などになったセル：理由を画面の上に出す（セルの上にマウスを置かなくても分かるように）
      if (page && page.errors && page.errors.length) {
        const seen = new Set();
        const list = page.errors.filter((x) => { const k = x.label + '\n' + x.message; if (seen.has(k)) return false; seen.add(k); return true; });
        notes.appendChild(el('div', { class: 'note is-err' }, [icon('fa-circle-exclamation'), el('div', {}, [el('div', { text: `計算できないセルが ${list.length} 件あります（出力イメージで赤く出るセル）` })].concat(
          list.slice(0, 4).map((x) => el('div', { text: `・${x.label}：${x.message}` })),
          list.length > 4 ? [el('div', { text: `ほか ${list.length - 4} 件` })] : [])) ]));
      }
      // ツールで作る帳票の編集（配置）：帯・区画・表を用紙の上に描く。旧形式（セル型）の帳票は編集できない
      if (native() && st.mode === 'design') {
        if (!blocky()) {
          zoomBox.appendChild(el('div', { class: 'empty-state bk-legacy' }, [
            icon('fa-file-circle-exclamation'),
            el('h2', { text: '旧形式（セル型）の帳票です' }),
            el('p', { text: 'この帳票は、帯・区画・表で作る新しい形式に置き換わったため、編集できません。「出力イメージ」で見ることと、出力は今までどおりできます。' }),
            el('div', { class: 'row' }, [
              el('button', { class: 'btn btn-primary', type: 'button', onclick: () => newPreset() }, [icon('fa-plus'), '新しい帳票を作る']),
              el('button', { class: 'btn', type: 'button', onclick: () => { st.mode = 'output'; renderAll(); } }, [icon('fa-eye'), '出力イメージを見る'])
            ])
          ]));
          return;
        }
        const wrap = canvas.render(zoomBox);
        wrap.style.zoom = String(st.zoom);
        if (!st.fitted) { st.fitted = true; requestAnimationFrame(fit); }
        return;
      }
      const t = st.preset.table;
      const pickRow = st.pickTable === 'bottom' ? st.pickTop : null;
      // ツールで作った帳票の出力イメージは、そのページの板の行数に増やしたモデルで描く
      let shown = st.model;
      let lay = null;
      if (native() && st.mode === 'output' && lot()) { lay = RM.pageLayout(st.preset, lot(), st.pageIdx, lot().name, columns()); shown = lay.model; }
      const table = RR.sheet(shown, {
        headers: !blocky(),
        overlay: st.mode === 'design' ? designOverlay() : outputOverlay(),
        rowCls: (r) => {
          if (native()) return '';
          if (pickRow === r) return 'rp-trow rp-trow-top';
          if (!t) return '';
          return r === t.top ? 'rp-trow rp-trow-top' : r > t.top && r <= t.bottom ? 'rp-trow' : '';
        }
      });
      if (native()) {
        // 自由に置く物（テキストボックス・図形・表・画像）：このページの値で描き、表の左上を原点に重ねる
        let floatLayer = null;
        if (blocky() && lay && page) {
          const list = CDB.reportFloats.build(st.preset, page, st.pageIdx, RM.pageCount(st.preset, lot(), columns()), lay);
          if (list.length) { floatLayer = el('div', { class: 'rp-floats' }); list.forEach((x) => floatLayer.appendChild(x.node)); }
        }
        const wrap = UI.sheetPaper.decorate(table, !blocky() && t ? { top: t.top, body: lay ? lay.rows : 1, nRows: shown.nRows, plates: !lay && lot() ? lot().plates.length : null } : null, st.preset.doc, { plain: blocky(), overlay: floatLayer });
        st.table = table;
        table.classList.add('is-output');
        table.classList.toggle('is-plain', blocky());
        wrap.style.zoom = String(st.zoom);
        zoomBox.appendChild(wrap);
        RR.shrinkFit(table);
        if (!st.fitted) { st.fitted = true; requestAnimationFrame(fit); }
        return;
      }
      table.classList.toggle('is-picking', !!(st.placing || st.pickTable));
      table.classList.toggle('is-output', st.mode === 'output');
      table.style.zoom = String(st.zoom);
      table.addEventListener('click', (e) => {
        const td = e.target.closest('td[data-r]');
        if (td) onCellClick(td);
      });
      zoomBox.appendChild(table);
      RR.shrinkFit(table);
      if (!st.fitted) { st.fitted = true; requestAnimationFrame(fit); }
    }

    /* ---------- 出力 ---------- */
    function renderFoot() {
      reasons.innerHTML = '';
      const chk = RM.check(st.preset, st.template, targetLots(), columns());
      const lots = targetLots();
      const pages = st.preset ? lots.reduce((a, l) => a + RM.pageCount(st.preset, l, columns()), 0) : 0;
      // 出力中は進み具合（工程・シート数・%・経過・中止）を出す。終わった直後は結果を残す
      // 押せない理由は、終わった出力の結果より優先して出す（基本設計 1-4）
      if (st.job && (!st.job.job.ended || !chk.blockers.length)) reasons.appendChild(UI.jobs.progressView(st.job, { compact: true, onReveal: false }));
      else if (chk.blockers.length) reasons.appendChild(UI.reasonList(chk.blockers));
      else reasons.appendChild(el('span', { class: 'muted', text: `${unit()} ${fmt(lots.length)} 件・${fmt(pages)} ページを出力します${st.applied && st.applied.excluded ? `（NG ${fmt(st.applied.excluded)} 板は外す）` : ''}` }));
      const running = !!(st.job && !st.job.job.ended);
      pdfBtn.innerHTML = '';
      pdfBtn.append(icon('fa-file-pdf'), 'PDF（印刷）');
      pdfBtn.disabled = chk.blockers.length > 0 || running;
      pdfBtn.title = running ? 'Excel の出力中は押せません（終わるか中止すると押せます）' : '';
      xlsBtn.innerHTML = '';
      xlsBtn.append(icon(running ? 'fa-spinner fa-spin' : 'fa-file-excel'), running ? 'Excel を出力中…' : `Excel を出力（${fmt(pages)} シート）`);
      xlsBtn.disabled = chk.blockers.length > 0 || running;
      xlsBtn.title = running ? '同じ出力を二重に始めないよう、終わるまで押せません' : '';
    }

    function buildJobs() {
      const cols = columns();
      const jobs = [];
      targetLots().forEach((l) => {
        const n = RM.pageCount(st.preset, l, cols);
        for (let i = 0; i < n; i++) {
          const res = RM.renderPage(st.preset, l, i, cols);
          const lay = native() ? RM.pageLayout(st.preset, l, i, l.name, cols) : null;
          jobs.push({ name: n > 1 ? `${l.name}_${i + 1}` : l.name, cells: res.cells, errors: res.errors, model: lay ? lay.model : null, floats: lay && blocky() ? CDB.reportFloats.build(st.preset, res, i, n, lay) : [] });
        }
      });
      return jobs;
    }

    /** 出力の条件（履歴に残す） */
    const outputConditions = () => `帳票プリセット「${st.preset ? st.preset.name : ''}」${st.applied && st.applied.excluded ? `（NG ${st.applied.excluded} 板を外す）` : ''}・${st.scope === 'all' ? `表示中のすべての${unit()}` : `プレビュー中の${unit()}`}`; // docMaker：CDB の「フォルダ」は無いので外した

    const errorSummary = (jobs) => {
      const errs = jobs.reduce((a, j) => a + j.errors.length, 0);
      return errs ? `（計算できなかった値 ${fmt(errs)} 件。出力イメージで赤いセルを確かめてください）` : '';
    };

    /** Excel のブックを作る（ツールで作った帳票は新しいブック、ひな形の帳票はひな形を複製） */
    const writeBook = (jobs, cb) => (native() ? CDB.sheetXlsx.write(jobs, cb) : RX.write(st.template.buffer, st.preset.sheet, jobs, cb));

    xlsBtn.addEventListener('click', async () => {
      if (st.job && !st.job.job.ended) return;
      let stop = false;
      const api = CDB.jobs.start({
        name: 'Excel 出力', kind: 'excel', steps: ['ページの組み立て', 'シートの書き込み', 'ファイルの保存'], unit: 'シート',
        input: st.template ? st.template.name : '', conditions: outputConditions(),
        cancel: () => { stop = true; }
      });
      st.job = api;
      renderFoot();
      await new Promise((res) => setTimeout(res, 0)); // 押したことを先に返す
      let jobs = [];
      try {
        jobs = buildJobs();
        api.step(1);
        api.progress(0, jobs.length, 'シート');
        const blob = await writeBook(jobs, (done, total) => {
          if (stop) throw Object.assign(new Error('中止しました'), { aborted: true });
          api.progress(done, total, 'シート');
          return new Promise((res) => setTimeout(res, 0)); // 画面が固まらないように小分けにする
        });
        if (stop) throw Object.assign(new Error('中止しました'), { aborted: true });
        api.step(2);
        const name = RM.fileName(st.preset, 'xlsx');
        RX.download(blob, name);
        const errs = errorSummary(jobs);
        const nErr = jobs.reduce((a, j) => a + j.errors.length, 0);
        const summary = `${name} に ${fmt(jobs.length)} シートを出力しました${errs}`;
        api.finish({
          summary, output: `ダウンロード：${name}`, counts: { target: jobs.length, ok: jobs.length, unit: 'シート' },
          warnings: nErr ? [`計算できなかった値 ${fmt(nErr)} 件（出力イメージで赤いセルを確かめてください）`] : []
        });
        UI.toast({ type: errs ? 'warn' : 'ok', text: `${summary}（${((api.job.ended - api.job.started) / 1000).toFixed(1)} 秒）` });
        await recordIssue('xlsx', name);
      } catch (err) {
        if (err.aborted || stop) {
          api.aborted({ summary: '中止しました。ファイルは出力していません', counts: { target: jobs.length, ok: 0, unit: 'シート' }, next: 'もう一度「Excel を出力」を押すと、最初から出力します' });
          UI.toast({ type: 'info', text: 'Excel の出力を中止しました（ファイルは出力していません）' });
        } else {
          api.fail(err, { next: 'テンプレートと変換表を確かめて、もう一度出力してください' });
          UI.toast({ type: 'err', text: 'Excel を出力できませんでした：' + err.message, duration: 15000 });
        }
      } finally {
        renderFoot();
      }
    });

    pdfBtn.addEventListener('click', () => {
      const jobs = buildJobs();
      const range = native() ? null : RR.printRange(st.model, st.preset.table);
      const pages = jobs.map((j) => {
        const ov = new Map();
        j.cells.forEach((v, k) => ov.set(k, { text: v.text }));
        return native()
          ? { model: j.model, overlay: ov, floats: j.floats, range: { r0: 0, c0: 0, r1: j.model.nRows - 1, c1: j.model.nCols - 1 } }
          : { model: st.model, overlay: ov, range };
      });
      const title = RM.fileName(st.preset, 'pdf').replace(/\.pdf$/, '');
      RR.print(pages, { title });
      const summary = `${fmt(pages.length)} ページを印刷の画面に送りました。送信先で「PDF に保存」を選んでください${errorSummary(jobs)}`;
      UI.toast({ type: 'info', text: summary });
      const nErr = jobs.reduce((a, j) => a + j.errors.length, 0);
      recordIssue('pdf', title);
      CDB.jobs.record({ name: 'PDF（印刷）', kind: 'pdf', input: st.template ? st.template.name : '', conditions: outputConditions() }, {
        summary, output: `印刷の画面（${title}）`, counts: { target: pages.length, ok: pages.length, unit: 'ページ' },
        warnings: nErr ? [`計算できなかった値 ${fmt(nErr)} 件`] : []
      });
    });

    /* ---------- 全体 ---------- */
    function renderAll() {
      layoutPanel();
      panel.hidden = !st.panelOpen || !st.preset; // 帳票がないあいだは、中身のない折りたたみを出さない
      renderPresetSel();
      renderName();
      secTemplate.hidden = native();
      secPage.hidden = !native();
      secCell.hidden = !native() || st.mode === 'output'; // 選んだセルの設定は編集のときだけ
      secCols.hidden = !native() || st.mode === 'output'; // 出力イメージのあいだは、データの列を畳んで用紙の面積を広げる
      if (blocky()) { cellUi.render(); colsUi.render(); }
      sheetBar.hidden = !(blocky() && st.mode === 'design');
      secItems.hidden = blocky(); // ブロックの帳票の項目（変換表）は、セルの中身から自動で作る
      renderTemplateBox();
      pageUi.render();
      if (blocky()) bar.render();
      itemsTable.render();
      rulesUi.render();
      renderOutputBox();
      renderToolbar();
      renderPreview();
      renderFoot();
    }

    // 配置中・範囲の指定中の Esc は、画面を閉じずにその操作だけを終える
    const onKey = (e) => {
      if (e.key !== 'Escape' || !(st.placing || st.pickTable)) return;
      if (document.querySelector('.rp-pop')) return;
      e.stopPropagation();
      e.preventDefault();
      st.placing = null;
      st.pickTable = null;
      renderAll();
    };
    document.addEventListener('keydown', onKey, true);

    // サンプルの読み込みなどでメイン画面のデータが変わったら、ロットと設定を読み直す
    const onView = () => {
      rebuildLots();
      reloadLists().catch(() => { /* 次の操作で読み直す */ });
    };
    CDB.bus.on('view:changed', onView);

    function cleanup() {
      canvas.destroy();
      bar.destroy();
      barWatch.disconnect();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('paste', onPaste);
      CDB.bus.off('view:changed', onView);
      CDB.bus.emit('report:closed'); // メイン画面の主要動作（帳票を出す／ひな形を入れる）を更新する
    }

    renderAll();
    reloadLists().catch((err) => UI.toast({ type: 'err', text: '帳票の設定を読めませんでした：' + err.message }));
    return modal;
  }

  CDB.ui.report = { open };
})();
