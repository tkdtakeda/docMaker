/* ── rail: アイコン列と脇のパネルの開閉（§3）────────────────
   機能ごとの塊をアイコンで開く。パネルは非モーダルで、開いたままメイン画面を操作できる。
   同じ動作には同じアイコン・同じ位置（アイコンの上から作業の順）。 */
(function () {
  "use strict";
  const DM = window.DM;

  DM.mountRail = function (cfg) {
    const { rail, panel, items } = cfg;
    let openId = cfg.open || "";
    const bodies = {};
    panel.innerHTML = `<div class="panel__head"><i data-ico></i><span data-title></span><span class="topbar__spacer"></span><button class="btn btn--icon btn--ghost" data-shut title="閉じる" aria-label="パネルを閉じる"><i class="fa-solid fa-angles-left"></i></button></div><div class="panel__body"></div>`;
    const bodyHost = panel.querySelector(".panel__body");
    items.filter((it) => !it.action).forEach((it) => { const d = document.createElement("div"); d.className = "panel__pane"; d.hidden = true; bodyHost.appendChild(d); bodies[it.id] = d; if (it.mount) it.mount(d); });
    const draw = () => {
      rail.querySelectorAll(".rail-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === openId)));
      panel.classList.toggle("hidden", !openId);
      items.forEach((it) => { if (bodies[it.id]) bodies[it.id].hidden = it.id !== openId; });
      const cur = items.find((i) => i.id === openId);
      if (cur) { panel.querySelector("[data-title]").textContent = cur.title || cur.label; panel.querySelector("[data-ico]").className = "fa-solid " + cur.icon; }
      items.forEach((it) => { if (!it.badge) return; const b = rail.querySelector(`[data-id="${it.id}"] .badge`); const n = it.badge(); if (b) { b.textContent = n; b.classList.toggle("hidden", !n); } });
    };
    items.forEach((it) => {
      if (it.sepBefore) { const s = document.createElement("div"); s.className = it.spacer ? "rail__spacer" : "rail__sep"; rail.appendChild(s); }
      const b = document.createElement("button");
      b.className = "rail-btn"; b.dataset.id = it.id; b.title = it.title || it.label;
      b.innerHTML = `<i class="fa-solid ${it.icon}"></i><span>${DM.esc(it.label)}</span>${it.badge ? '<span class="badge hidden"></span>' : ""}`;
      b.addEventListener("click", () => { if (it.action) { it.action(); return; } openId = openId === it.id ? "" : it.id; draw(); });
      rail.appendChild(b);
    });
    panel.querySelector("[data-shut]").addEventListener("click", () => { openId = ""; draw(); });
    ["query", "data", "selection"].forEach((n) => DM.bus.on(n, draw));
    draw();
    return { open(id) { openId = id; draw(); }, close() { openId = ""; draw(); }, current: () => openId };
  };

  /* 起動の共通処理：サンプルを自動で読み込む（?empty で空の状態から）。検索・フィルターを配線する */
  DM.boot = function (o) {
    o = o || {};
    DM.enableFormNav(document.body);
    if (o.search) DM.mountSearch(o.search);
    if (o.chips) DM.mountActiveChips(o.chips);
    if (!o.empty && !/[?&]empty/.test(location.search)) { DM.sampleLoad("standard"); DM.sampleLoad("missing"); }
    else DM.bus.emit("data");
  };
})();
