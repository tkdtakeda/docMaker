/* ── panels: 脇のパネルの中身（機能ごとの塊）─────────────────
   データ（読み込み・サンプル）／表示（密度）／帳票の選択。置き場所は各レイアウトが決める。 */
(function () {
  "use strict";
  const DM = window.DM;

  /* ── データ：読み込み元・サンプルの読み込みとクリア（§11）── */
  DM.mountDataPanel = function (el) {
    const draw = () => {
      const n = DM.store.sampleCount();
      el.innerHTML = `
        <div class="group"><div class="group__title"><i class="fa-solid fa-database"></i>読み込み元（SQLite）</div>
          <div class="field"><label>品質データ DB のファイル</label><input class="input" type="text" disabled placeholder="例：\\\\server\\share\\SIKADEF.sqlite3"></div>
          <div class="note"><i class="fa-solid fa-circle-info"></i> DB への接続は、レイアウトを決めたあとの「機能組み込み」で有効にします。いまはサンプルで画面を確認できます。</div></div>
        <div class="group"><div class="group__title"><i class="fa-solid fa-flask"></i>サンプルデータ</div>
          ${DM.samples.list().map((p) => `<button class="btn sample-btn" data-sample="${p.id}"><i class="fa-solid ${p.icon}"></i><span><b>${DM.esc(p.name)}</b><small>${DM.esc(p.desc)}</small></span></button>`).join("")}
          <button class="btn btn--danger" data-clear-sample ${n ? "" : "disabled"}><i class="fa-solid fa-trash-can"></i>サンプルだけを消す${n ? `（${DM.fmtNum(n)} 行）` : ""}</button>
          ${n ? "" : '<div class="note">サンプルは読み込まれていません。</div>'}
          <div class="note">実データは消しません。消したあとも「元に戻す」で復元できます。</div></div>`;
    };
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.sample) { const c = DM.sampleLoad(b.dataset.sample); DM.toast(`サンプル ${DM.fmtNum(c)} 行を読み込みました`, { icon: "fa-flask" }); }
      else if (b.dataset.clearSample !== undefined) { const r = DM.sampleClear(); DM.toast(`サンプル ${DM.fmtNum(r.removed)} 行を消しました`, { icon: "fa-trash-can", undo: r.undo }); }
    });
    DM.bus.on("data", draw); draw();
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
    el.addEventListener("click", (e) => { const b = e.target.closest("[data-form]"); if (!b) return; DM.store.setForm(b.dataset.form); if (opts.onChoose) opts.onChoose(b.dataset.form); });
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
