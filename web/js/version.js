/* ── version: 版の札・更新履歴・利用状況・古いサーバーの警告 ──────────
   サーバー（docmaker）につながっているときだけ働く。file:// で直接開いたときは何も出さず、画面の機能はそのまま使える。
   - 見出しの版の札 → 押すと更新履歴／利用状況のモーダル
   - 心拍（5 秒）で「新しい版あり」を札の横に出す（止めはしない）
   - 30 秒ごとにサーバーの指紋を確かめ、古いサーバーなら「開き直してください」を出す */
(function () {
  "use strict";
  const DM = window.DM;
  const online = /^https?:$/.test(location.protocol);
  let badge, modal = null, state = { version: "", notice: null, stale: false, lastBeatOk: null };

  const j = (url, opt) => fetch(url, opt).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const when = (s) => (s ? String(s).replace("T", " ").slice(0, 16) : "—");
  const dur = (sec) => { sec = Math.round(sec || 0); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? `${h}時間${m}分` : `${m}分`; };

  function drawBadge() {
    if (!badge) return;
    const n = state.notice;
    badge.innerHTML = `<i class="fa-solid fa-code-branch"></i>v${DM.esc(state.version)}` +
      (n && n.outdated ? ` <span class="tag tag--warn" title="最新は v${DM.esc(n.latestVersion)} です。いまの版のままでも使えます"><i class="fa-solid fa-circle-arrow-up"></i>新しい版あり</span>` : "");
    badge.title = "更新履歴と利用状況を開く";
  }

  /* 古いサーバーの警告：画面の最上部に出し続ける（色だけでなく、アイコンと文字で §1-3） */
  function drawStale() {
    let bar = document.getElementById("stale-bar");
    if (!state.stale) { if (bar) bar.remove(); return; }
    if (!bar) { bar = document.createElement("div"); bar.id = "stale-bar"; bar.className = "stale-bar"; bar.setAttribute("role", "alert"); document.body.prepend(bar); }
    bar.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i><span><b>プログラムが入れ替わりました。</b>この画面は古いサーバーで動いています。Start.bat の窓を閉じて、もう一度 Start.bat を開いてください。</span><button class="btn" data-reload><i class="fa-solid fa-rotate-right"></i>画面を読み込み直す</button>`;
    bar.querySelector("[data-reload]").onclick = () => location.reload();
  }

  function beat() {
    if (document.hidden) return;
    j("api/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visible: true }) })
      .then((r) => { state.notice = r.version; state.lastBeatOk = true; drawBadge(); }).catch(() => { state.lastBeatOk = false; });
  }
  function checkInstance() {
    j("api/instance").then((r) => { state.stale = !!r.stale; drawStale(); }).catch(() => {});
  }

  /* ── モーダル ── */
  function section(tab, body) {
    const h = modal.querySelector(".vm__body");
    modal.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-current", String(b.dataset.tab === tab)));
    DM.safeStorage.set("dm.verTab", tab);
    h.innerHTML = body;
  }
  function showChangelog() {
    section("log", '<div class="state"><i class="fa-solid fa-spinner fa-spin"></i><span>読み込み中…</span></div>');
    j("api/changelog").then((r) => section("log", r.entries.map((e) => `<article class="log"><h3>v${DM.esc(e.version)} <small>${DM.esc(e.date)}</small>${e.version === state.version ? ' <span class="tag tag--ok"><i class="fa-solid fa-circle-check"></i>使用中</span>' : ""}</h3><ul>${e.notes.map((n) => `<li>${DM.esc(n)}</li>`).join("")}</ul></article>`).join("")))
      .catch(() => section("log", '<div class="state state--error"><i class="fa-solid fa-circle-exclamation"></i><strong>更新履歴を読めませんでした</strong><span>サーバーに届きません。Start.bat が動いているか確かめてください。</span></div>'));
  }
  function showFleet() {
    section("use", '<div class="state"><i class="fa-solid fa-spinner fa-spin"></i><span>読み込み中…</span></div>');
    j("api/presence").then((f) => {
      if (!f.total) return section("use", '<div class="state"><i class="fa-regular fa-folder-open"></i><strong>まだ使用の記録がありません</strong><span>このアプリを使うと、PC ごとに記録されます。</span></div>');
      const rows = f.items.map((x) => `<tr><td>${DM.esc(x.pc)}</td><td>${DM.esc(x.login)}</td><td>v${DM.esc(x.version || "?")} ${x.outdated ? '<span class="tag tag--warn"><i class="fa-solid fa-circle-arrow-up"></i>古い版</span>' : ""}</td>
        <td>${x.online ? '<span class="tag tag--ok"><i class="fa-solid fa-circle"></i>使用中</span>' : '<span class="tag"><i class="fa-regular fa-circle"></i>使っていない</span>'}</td><td>${when(x.lastAt)}</td><td class="num">${DM.fmtNum(x.sessions)} 回</td><td class="num">${dur(x.totalSec)}</td></tr>`).join("");
      section("use", `<p class="note"><i class="fa-solid fa-circle-info"></i><span>最新版：<b>v${DM.esc(f.latest || "?")}</b>（使っている人たちの版のうち、いちばん新しいもの）／使用中 <b>${f.online}</b> 台／古い版 <b>${f.outdated}</b> 台<br>記録の置き場：${DM.esc(f.dir)}（${f.ttlSec} 秒以内に反応があれば「使用中」）</span></p>
        <table class="help-table"><thead><tr><th>PC</th><th>ログインID</th><th>版</th><th>状態</th><th>最終</th><th class="num">回数</th><th class="num">使った時間</th></tr></thead><tbody>${rows}</tbody></table>`);
    }).catch(() => section("use", '<div class="state state--error"><i class="fa-solid fa-circle-exclamation"></i><strong>利用状況を読めませんでした</strong><span>サーバーに届きません。</span></div>'));
  }
  DM.openVersion = function (tab) {
    if (modal) modal.remove();
    const back = document.createElement("div"); back.className = "modal-back";
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="版と利用状況" style="width:min(820px,96vw);height:min(560px,90dvh)">
      <div class="modal__head"><i class="fa-solid fa-code-branch"></i>docMaker v${DM.esc(state.version)}<span class="topbar__spacer"></span><button class="btn btn--ghost" data-close><i class="fa-solid fa-xmark"></i>閉じる</button></div>
      <div class="seg" style="margin:var(--space-3) var(--space-4) 0;width:300px"><button class="seg__btn" data-tab="log"><i class="fa-solid fa-clock-rotate-left"></i>更新履歴</button><button class="seg__btn" data-tab="use"><i class="fa-solid fa-users"></i>利用状況</button></div>
      <div class="vm__body modal__body" style="padding:var(--space-4)"></div></div>`;
    document.body.appendChild(back); modal = back;
    back.addEventListener("click", (e) => { if (e.target === back || e.target.closest("[data-close]")) { modal.remove(); modal = null; return; } const t = e.target.closest("[data-tab]"); if (t) (t.dataset.tab === "use" ? showFleet : showChangelog)(); });
    (tab || DM.safeStorage.get("dm.verTab", "log")) === "use" ? showFleet() : showChangelog();
  };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modal) { modal.remove(); modal = null; } });

  DM.version = {
    state: () => state,
    /* 見出しに版の札を足す。サーバーにつながらなければ何もしない（モック・file:// でも壊れない） */
    init(host) {
      if (!online) return;
      j("api/build").then((r) => {
        state.version = r.version;
        badge = document.createElement("button");
        badge.className = "btn btn--ghost ver-badge"; badge.id = "ver";
        const help = host.querySelector("#help");
        help ? host.insertBefore(badge, help) : host.appendChild(badge);
        badge.addEventListener("click", () => DM.openVersion());
        drawBadge(); beat(); checkInstance();
        setInterval(beat, 5000); setInterval(checkInstance, 30000);
        document.addEventListener("visibilitychange", () => { if (!document.hidden) { beat(); checkInstance(); } });
      }).catch(() => {});
    },
  };
})();
