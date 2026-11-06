/* =========================================================
   web/report/js/boot.js : 帳票の画面を開く（report.html の最後に読む）
   docMaker の画面（親）が DM.reportBridge を用意していれば、そこから「データの列・行・まとまり」を受け取る。
   閉じたら親に知らせる（親が iframe を外す）。?samples が付いていれば、先にサンプル帳票を入れる。
   ========================================================= */
(function () {
  'use strict';
  const CDB = window.CDB;
  if (!/^https?:$/.test(location.protocol)) {
    document.body.innerHTML = '<div class="dm-offline"><b>帳票の画面は、サーバー（Start.bat）で開いたときに使えます。</b><br>帳票は共有フォルダに保存するため、サーバーが要ります。</div>';
    return;
  }
  let bridge = null;
  try { bridge = window.parent !== window && window.parent.DM && window.parent.DM.reportBridge ? window.parent.DM.reportBridge : null; } catch (_) { bridge = null; }
  const empty = { getColumns: () => [], getViewRows: () => [], getMasters: () => [] };
  const ctx = (bridge && bridge.ctx()) || empty;

  CDB.bus.on('report:closed', () => { if (bridge) bridge.close(); });
  // 帳票の保存・削除のたびに、親（トレーの帳票の一覧）へ知らせる
  ['put', 'deleteMany'].forEach((k) => {
    const orig = CDB.db[k].bind(CDB.db);
    CDB.db[k] = async (...a) => { const r = await orig(...a); if (bridge && bridge.changed) bridge.changed(); return r; };
  });

  (async () => {
    if (new URLSearchParams(location.search).has('samples')) { try { await CDB.docSamples.install(); } catch (_) { /* 通知は samples.js が出す */ } }
    CDB.ui.report.open(ctx);
    if (bridge && bridge.opened) bridge.opened();
  })();
})();
