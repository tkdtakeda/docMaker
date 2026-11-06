/* =========================================================
   web/report/js/samples.js : docMaker のサンプル帳票（基本設計 §11）
   docMaker のサンプルデータの列（ロット番号・品名・品番・顧客・工程・数量・製造日・納期・状態・担当者・検査結果・備考）を使う。
   ・ツールで作る帳票：出荷検査成績書（A4 縦・ロットの情報・明細の表（ロットの行ごとに繰り返す）・承認欄・ページ番号）
   ・Excel のひな形の帳票：製造指示書（ExcelJS でひな形を作り、項目を配置する）
   どちらも sample:true。docMaker の「サンプルだけを消す」で消える。同じ ID で入れ直すので、何度入れても増えない。
   ========================================================= */
(function () {
  'use strict';
  const CDB = (window.CDB = window.CDB || {});
  const BD = () => CDB.blockDoc;
  const NATIVE_ID = 'dm_sample_rp_ship';
  const TPL_ID = 'dm_sample_tpl_order';
  const TPL_RP_ID = 'dm_sample_rp_order';
  const SHEET = '製造指示書';

  const tableOf = (p, name) => BD().tables(p.blocks).find((t) => t.name === name);
  function put(t, r, c, text, style) {
    BD().setText(t, r, c, text);
    if (style) CDB.sheetDoc.setStyle(BD().L(t), { r0: r, c0: c, r1: r, c1: c }, style);
  }

  /** ツールで作る帳票：出荷検査成績書 */
  function buildShip() {
    const p = CDB.reportModel.newNativePreset('【サンプル】出荷検査成績書（ツールで作成）');
    p.id = NATIVE_ID;
    p.sample = true;
    put(tableOf(p, '表題'), 0, 0, '出 荷 検 査 成 績 書');
    const info = tableOf(p, 'ロットの情報');
    put(info, 0, 1, '{ロット番号}'); put(info, 0, 3, '{品番}');
    put(info, 1, 1, '{品名}'); put(info, 1, 3, '{数量|桁=0|桁区切り} 個');
    put(info, 2, 1, '{顧客}');
    const rows = tableOf(p, '明細');
    ['No.', '工程', '数量', '製造日', '担当者', '検査結果'].forEach((t, c) => put(rows, 0, c, t));
    put(rows, 1, 1, '{工程}'); put(rows, 1, 2, '{数量|桁=0|桁区切り}'); put(rows, 1, 3, '{製造日}'); put(rows, 1, 4, '{担当者|空=－}'); put(rows, 1, 5, '{検査結果|空=未入力}');
    CDB.blockCompile.apply(p);
    return p;
  }

  /** Excel のひな形：製造指示書（ExcelJS で作る） */
  async function buildTemplate() {
    if (!window.ExcelJS) throw new Error('Excel を扱う部品（ExcelJS）を読み込めませんでした');
    const wb = new window.ExcelJS.Workbook();
    const ws = wb.addWorksheet(SHEET, { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1 } });
    ws.columns = [8, 16, 12, 16, 14, 22].map((width) => ({ width }));
    const thin = { style: 'thin', color: { argb: 'FF000000' } };
    const box = { top: thin, left: thin, bottom: thin, right: thin };
    const head = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBE7F4' } };
    const set = (addr, value, o) => {
      const c = ws.getCell(addr);
      c.value = value;
      c.font = Object.assign({ name: '游ゴシック', size: 10 }, (o && o.font) || {});
      c.alignment = Object.assign({ vertical: 'middle' }, (o && o.alignment) || {});
      if (o && o.border) c.border = o.border;
      if (o && o.fill) c.fill = o.fill;
    };
    ws.mergeCells('A1:F1'); set('A1', '製 造 指 示 書', { font: { size: 16, bold: true }, alignment: { horizontal: 'center' } });
    ws.getRow(1).height = 30;
    [['A3', 'ロット番号'], ['D3', '品番'], ['A4', '品名'], ['D4', '投入数量'], ['A5', '納期'], ['D5', '状態']].forEach(([a, t]) => set(a, t, { border: box, fill: head, font: { bold: true } }));
    ['B3:C3', 'B4:C4', 'B5:C5'].forEach((r) => { ws.mergeCells(r); set(r.split(':')[0], '', { border: box }); });
    ['E3:F3', 'E4:F4', 'E5:F5'].forEach((r) => { ws.mergeCells(r); set(r.split(':')[0], '', { border: box }); });
    ['No.', '工程', '数量', '製造日', '担当者', '備考'].forEach((t, i) => set(String.fromCharCode(65 + i) + '7', t, { border: box, fill: head, font: { bold: true }, alignment: { horizontal: 'center' } }));
    for (let r = 8; r <= 17; r++) for (let i = 0; i < 6; i++) set(String.fromCharCode(65 + i) + r, '', { border: box });
    set('A19', '出力日', {}); set('E19', 'ページ', {});
    return wb.xlsx.writeBuffer();
  }
  function buildTemplatePreset() {
    const RI = CDB.reportItems;
    const items = {};
    const add = (key, item) => { items[key] = Object.assign(item, { id: 'dm_sample_it_' + key }); };
    const field = (key, label, col, extra) => add(key, Object.assign(RI.create('field', { label, col: 'p:' + col }), extra || {}));
    field('lot', 'ロット番号', 'ロット番号'); field('code', '品番', '品番'); field('name', '品名', '品名'); field('due', '納期', '納期'); field('state', '状態', '状態');
    add('qty', Object.assign(RI.create('formula', { label: '投入数量', expr: 'TEXT([数量], "#,##0") & " 個"' })));
    field('proc', '工程', '工程'); field('rqty', '数量', '数量'); field('made', '製造日', '製造日'); field('who', '担当者', '担当者', { blank: '－' }); field('note', '備考', '備考', { blank: '－' });
    add('no', Object.assign(RI.create('system', { label: 'No.' }), { sys: 'rowNo' }));
    add('today', Object.assign(RI.create('system', { label: '出力日' }), { sys: 'today' }));
    add('page', Object.assign(RI.create('system', { label: 'ページ' }), { sys: 'pageNo' }));
    const pl = (key, r, c) => ({ id: 'dm_sample_pl_' + key + '_' + r + '_' + c, r, c, item: items[key].id, show: 'value', sep: '：' });
    const TOP = 7;
    return {
      id: TPL_RP_ID, name: '【サンプル】製造指示書（Excel のひな形）', templateId: TPL_ID, sheet: SHEET,
      items: Object.keys(items).map((k) => items[k]),
      places: [pl('lot', 2, 1), pl('code', 2, 4), pl('name', 3, 1), pl('qty', 3, 4), pl('due', 4, 1), pl('state', 4, 4),
        pl('no', TOP, 0), pl('proc', TOP, 1), pl('rqty', TOP, 2), pl('made', TOP, 3), pl('who', TOP, 4), pl('note', TOP, 5),
        pl('today', 18, 1), pl('page', 18, 5)],
      table: { top: TOP, bottom: TOP + 9 }, sample: true, updatedAt: Date.now()
    };
  }

  /** サンプル帳票を入れる（同じ ID なので入れ直し）。入れたあと帳票の一覧を読み直す */
  async function install() {
    const UI = CDB.ui;
    try {
      const buf = await buildTemplate();
      const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      await CDB.reportModel.saveTemplate({ id: TPL_ID, name: '【サンプル】製造指示書', fileName: 'サンプル_製造指示書.xlsx', size: ab.byteLength, buffer: ab, sheets: [SHEET], addedAt: Date.now(), sample: true });
      await CDB.reportModel.savePreset(buildTemplatePreset());
      await CDB.reportModel.savePreset(buildShip());
      CDB.bus.emit('view:changed', {});
      if (UI && UI.toast) UI.toast({ type: 'ok', text: 'サンプルの帳票を 2 種入れました（出荷検査成績書・製造指示書）。docMaker の「サンプルだけを消す」で消せます' });
      return 2;
    } catch (err) {
      if (UI && UI.toast) UI.toast({ type: 'err', text: 'サンプルの帳票を入れられませんでした：' + err.message });
      throw err;
    }
  }

  CDB.docSamples = { install, IDS: { reports: [NATIVE_ID, TPL_RP_ID], templates: [TPL_ID] } };
})();
