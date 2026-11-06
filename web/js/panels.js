/* ── panels: 脇のパネルの中身（機能ごとの塊）─────────────────
   データ（読み込み・サンプル）／表示（密度）／帳票の選択。置き場所は各レイアウトが決める。 */
(function () {
  "use strict";
  const DM = window.DM;

  /* ── データ：読み込み元（SQLite）・サンプルの読み込みとクリア（§11）── */
  DM.mountDataPanel = function (el) {
    const draw = () => {
      const keepVal = (sel) => { const i = el.querySelector(sel); return i ? i.value : null; };
      const typed = { src: keepVal("[data-src]"), tbl: keepVal("[data-tbl]") }, active = el.contains(document.activeElement) ? document.activeElement : null;
      const focusKey = active && active.matches("[data-src]") ? "[data-src]" : active && active.matches("[data-tbl]") ? "[data-tbl]" : "";
      const nRep = DM.reports ? DM.reports.list.filter((x) => x.sample).length : 0;
      const n = DM.store.sampleCount(), d = DM.data || { online: false, settings: {} }, st = DM.store, remote = st.mode === "remote";
      const state = !d.online ? `<div class="note"><i class="fa-solid fa-circle-info"></i><span>サーバー（Start.bat）で開くと、DB を読み込めます。いまはサンプルで画面を確かめられます。</span></div>`
        : remote && st.error ? `<div class="note" style="color:var(--color-error)"><i class="fa-solid fa-circle-exclamation"></i><span>${DM.esc(st.error.message)}</span></div>`
        : remote && st.connected ? `<div class="note" style="color:var(--color-ok)"><i class="fa-solid fa-circle-check"></i><span>${DM.esc(st.source.label)}を ${DM.fmtNum(st.total)} 件読み込み中です。</span></div>`
        : `<div class="note"><i class="fa-solid fa-circle-info"></i><span>ファイルの場所を入れて Enter（または「読み込む」）。共有（\\\\server\\share\\…）も指定できます。</span></div>`;
      el.innerHTML = `
        <div class="group"><div class="group__title"><i class="fa-solid fa-database"></i>読み込み元（SQLite）</div>
          <div class="field"><label>品質データ DB のファイル</label><input class="input" type="text" data-src data-nav value="${DM.esc(typed.src != null ? typed.src : d.settings.source || "")}" ${d.online ? "" : "disabled"} placeholder="例：\\\\server\\share\\SIKADEF.sqlite3" spellcheck="false"></div>
          <details ${d.settings.table ? "open" : ""}><summary class="label">詳細（表の名前）</summary><div class="field"><input class="input" type="text" data-tbl data-nav value="${DM.esc(typed.tbl != null ? typed.tbl : d.settings.table || "")}" ${d.online ? "" : "disabled"} placeholder="空なら自動（仕掛 → 品質情報 → …）"></div></details>
          <div class="row"><button class="btn btn--primary" data-connect ${d.online ? "" : "disabled"} style="min-width:0;flex:1" title="${d.online ? "" : "サーバーで開いたときだけ使えます"}"><i class="fa-solid fa-plug"></i>読み込む</button>
            <button class="btn" data-refresh-src ${remote && st.connected ? "" : "disabled"} title="${remote && st.connected ? "共有から取り直す" : "先に読み込んでください"}"><i class="fa-solid fa-rotate"></i>再読込</button></div>
          ${state}</div>
        <div class="group"><div class="group__title"><i class="fa-solid fa-flask"></i>サンプルデータ</div>
          ${d.online ? `<button class="btn sample-btn" data-sample-reports><i class="fa-solid fa-file-invoice"></i><span><b>帳票のサンプル（2 種）</b><small>出荷検査成績書（ツールで作成）・製造指示書（Excel のひな形）。帳票の画面が開きます。</small></span></button>` : ""}
          ${DM.samples.list().map((p) => `<button class="btn sample-btn" data-sample="${p.id}"><i class="fa-solid ${p.icon}"></i><span><b>${DM.esc(p.name)}</b><small>${DM.esc(p.desc)}</small></span></button>`).join("")}
          <button class="btn btn--danger" data-clear-sample ${n || nRep ? "" : "disabled"}><i class="fa-solid fa-trash-can"></i>サンプルだけを消す${n || nRep ? `（${[n ? DM.fmtNum(n) + " 行" : "", nRep ? "帳票 " + nRep + " 種" : ""].filter(Boolean).join("・")}）` : ""}</button>
          ${n || nRep ? "" : '<div class="note">サンプルは読み込まれていません。</div>'}
          <div class="note"><span>サンプルを読み込むと DB の表示はいったん止まり、サンプルを消すと DB に戻ります。実データは消しません。</span></div></div>`;
      if (focusKey) { const f = el.querySelector(focusKey); if (f) f.focus(); }
    };
    const connect = async () => {
      const src = el.querySelector("[data-src]").value.trim(), tbl = el.querySelector("[data-tbl]").value.trim();
      if (!src) { DM.toast("ファイルの場所を入れてください", { icon: "fa-circle-exclamation" }); el.querySelector("[data-src]").focus(); return; }
      try { await DM.data.saveSettings({ source: src, table: tbl }); await DM.data.connect(); } catch (e) { DM.toast("保存できませんでした：" + e.message, { icon: "fa-circle-exclamation" }); }
    };
    el.addEventListener("click", async (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.sample) { const wasDb = DM.store.mode === "remote"; const c = DM.sampleLoad(b.dataset.sample); DM.toast(`サンプル ${DM.fmtNum(c)} 行を読み込みました${wasDb ? "（DB の表示は止めています）" : ""}`, { icon: "fa-flask" }); }
      else if (b.dataset.sampleReports !== undefined) DM.reportBridge.openDesign({ samples: true });
      else if (b.dataset.clearSample !== undefined) {
        const r = DM.sampleClear(); let rr = null;
        try { rr = DM.reports ? await DM.reports.clearSamples() : null; } catch (err) { DM.toast("サンプルの帳票を消せませんでした：" + err.message, { icon: "fa-circle-exclamation" }); }
        const parts = [r.removed ? `サンプル ${DM.fmtNum(r.removed)} 行` : "", rr && rr.count ? `サンプルの帳票 ${rr.count} 種` : ""].filter(Boolean);
        DM.toast(`${parts.join("・") || "サンプル"}を消しました`, { icon: "fa-trash-can", undo: async () => { r.undo(); if (rr) await rr.undo(); } });
        if (DM.data) DM.data.reconnectIfConfigured();
      }
      else if (b.dataset.connect !== undefined) connect();
      else if (b.dataset.refreshSrc !== undefined) DM.data.refresh();
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229 && e.target.matches("[data-src]")) { e.stopPropagation(); e.preventDefault(); connect(); } }, true);   // 場所の欄は Enter で読み込む（変換中は除く）
    ["data", "page", "datasettings", "form"].forEach((n) => DM.bus.on(n, draw)); draw();
  };

  /* ── 表示：密度 3 段階（§1-9）── */
  DM.mountViewPanel = function (el) {
    const opts = [["compact", "コンパクト", "fa-compress"], ["standard", "標準", "fa-equals"], ["comfortable", "ゆったり", "fa-expand"]];
    const draw = () => {
      el.innerHTML = `<div class="group"><div class="group__title"><i class="fa-solid fa-text-height"></i>表示の密度</div>
        <div class="seg" role="radiogroup">${opts.map(([v, l, i]) => `<button class="seg__btn" role="radio" aria-checked="${DM.density.get() === v}" data-density="${v}"><i class="fa-solid ${i}"></i>${l}</button>`).join("")}</div>
        <div class="note">文字・行の高さ・余白・入力欄の高さを一緒に切り替えます。選択や条件はそのまま残ります。</div></div>
        <div class="group"><div class="group__title"><i class="fa-solid fa-table-columns"></i>表の列幅</div>
          <button class="btn" data-reset-widths><i class="fa-solid fa-arrows-left-right-to-line"></i>列幅を初期に戻す</button></div>`;
    };
    el.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.density) { DM.density.set(b.dataset.density); draw(); } else if (b.dataset.resetWidths !== undefined && DM.grid) DM.grid.resetWidths(); });
    draw();
  };

  /* ── 帳票の選択：カード。選択中ロットで「不足」が出るかを先に見せる（§1-12）── */
  DM.mountFormChooser = function (el, opts) {
    opts = opts || {};
    const draw = () => {
      const rows = DM.store.selectedRows();
      if (!DM.forms.list().length) {
        el.innerHTML = DM.reports && DM.reports.error
          ? `<span class="tag tag--error"><i class="fa-solid fa-circle-exclamation"></i>帳票の一覧を読めません：${DM.esc(DM.reports.error)}</span>`
          : `<span class="note"><i class="fa-solid fa-circle-info"></i><span>登録済みの帳票がありません。</span></span><button class="btn" data-make-form><i class="fa-solid fa-file-pen"></i>帳票を作る</button><button class="btn" data-sample-forms><i class="fa-solid fa-flask"></i>サンプルの帳票を入れる</button>`;
        return;
      }
      el.innerHTML = DM.forms.list().map((f) => {
        const chk = rows.length ? DM.forms.check(f, rows) : null;
        if (opts.compact) {
          const st = chk ? (chk.missingCount ? `<span class="tag tag--warn"><i class="fa-solid fa-triangle-exclamation"></i>不足 ${chk.missingCount}</span>` : `<span class="tag tag--ok"><i class="fa-solid fa-circle-check"></i>OK</span>`) : "";
          return `<button class="pill" role="radio" aria-checked="${DM.store.formId === f.id}" data-form="${f.id}" title="${DM.esc(f.desc)}"><i class="fa-solid ${f.icon}"></i>${DM.esc(f.name)}${st}</button>`;
        }
        const meta = chk ? (chk.missingCount ? `<span class="tag tag--warn"><i class="fa-solid fa-triangle-exclamation"></i>不足 ${chk.missingCount} 項目（${chk.badRows.length} ロット）</span>` : `<span class="tag tag--ok"><i class="fa-solid fa-circle-check"></i>必須項目 そろっています</span>`) : `<span class="tag">必須 ${f.fields.filter((x) => x.required).length} 項目</span>`;
        return `<button class="form-card" role="radio" aria-checked="${DM.store.formId === f.id}" data-form="${f.id}"><span class="form-card__icon"><i class="fa-solid ${f.icon}"></i></span><span><div class="form-card__name">${DM.esc(f.name)}</div><div class="form-card__desc">${DM.esc(f.desc)}</div><div class="form-card__meta">${meta}</div></span></button>`;
      }).join("");
    };
    el.setAttribute("role", "radiogroup");
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-make-form]")) return DM.reportBridge.openDesign();
      if (e.target.closest("[data-sample-forms]")) return DM.reportBridge.openDesign({ samples: true });
      const b = e.target.closest("[data-form]"); if (!b) return; DM.store.setForm(b.dataset.form); if (opts.onChoose) opts.onChoose(b.dataset.form);
    });
    DM.bus.on("selection", draw); DM.bus.on("form", draw); draw();
  };

  /* ── 主操作ボタン（1 つ・位置固定・ラベルだけ変わる §1-2 §1-4）── */
  DM.mountCta = function (btn, hintEl, handlers) {
    const draw = () => {
      const a = DM.nextAction();
      btn.innerHTML = `${DM.esc(a.label)} <i class="fa-solid fa-arrow-right"></i>`;
      btn.disabled = !a.enabled;
      btn.title = a.reason || "";
      btn.dataset.key = a.key;
      if (hintEl) hintEl.textContent = a.reason || a.hint || "";
    };
    btn.addEventListener("click", () => { const a = DM.nextAction(); if (a.enabled && handlers[a.key]) handlers[a.key](a); });
    ["data", "selection", "form"].forEach((n) => DM.bus.on(n, draw)); draw();
    return { draw };
  };

  /* ── 処理の流れ ①②③：現在位置と完了を示す（§1-19）── */
  DM.mountSteps = function (el) {
    const draw = () => {
      const a = DM.nextAction(), cur = a.step, done = { 1: DM.store.selected.size > 0, 2: !!DM.forms.get(DM.store.formId) && DM.store.selected.size > 0, 3: false };
      const defs = [[1, "ロットを選ぶ", "fa-magnifying-glass"], [2, "帳票を選ぶ", "fa-file-lines"], [3, "確認して印刷", "fa-print"]];
      el.innerHTML = defs.map(([n, l, i]) => `<li class="step ${n === cur ? "is-current" : ""} ${done[n] ? "is-done" : ""}" data-step="${n}" ${n === cur ? 'aria-current="step"' : ""}><span class="step__no">${done[n] ? '<i class="fa-solid fa-check"></i>' : n}</span><span class="step__label">${l}</span></li>`).join('<li class="step__line" aria-hidden="true"></li>');
    };
    ["data", "selection", "form"].forEach((n) => DM.bus.on(n, draw)); draw();
  };
})();
