/* ── work-panel: 作業セット（設定一式に名前を付けて保存・切り替え）と自動保存の状態 ──────────
   - 名前を入れて Enter（または「保存」）。同じ名前なら上書き（元に戻せる）
   - 一覧から「当てはめる」。上書き・名前の変更・削除は ⋮ の中（危ない操作を主動線に置かない §1-5）
   - 書き出し（JSON）・読み込み（ファイル選択・ドラッグ＆ドロップ）
   - 自動保存（列の構成ごと）の状態と、保存の量を出す（§1-6 §8） */
(function () {
  "use strict";
  const DM = window.DM;
  const when = (t) => new Date(t).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

  DM.mountWorkPanel = function (el) {
    let editing = "";
    const draw = () => {
      const typed = el.querySelector("[data-setname]") ? el.querySelector("[data-setname]").value : "";
      const focusName = document.activeElement && document.activeElement.matches && document.activeElement.matches("[data-setname]");
      const sets = DM.prefs.sets().sort((a, b) => b.at - a.at), used = DM.prefs.usage();
      const hasData = DM.store.columns.length > 0;
      el.innerHTML = `
        <div class="group"><div class="group__title"><i class="fa-solid fa-bookmark"></i>作業セット（設定一式に名前を付ける）</div>
          <div class="note"><i class="fa-solid fa-circle-info"></i><span>いまの条件・並べ替え・ロットでまとめる・列・列幅を保存します（検索欄の文字は含めません）。</span></div>
          <div class="row"><div class="field"><label>名前</label><input class="input" type="text" data-setname maxlength="${DM.prefs.MAX_NAME}" value="${DM.esc(typed)}" placeholder="例：東洋精機 出荷前" ${hasData ? "" : "disabled"}></div>
            <button class="btn btn--primary" data-save style="min-width:0" ${hasData ? "" : "disabled"} title="${hasData ? "Enter でも保存します" : "データを読み込むと保存できます"}"><i class="fa-solid fa-floppy-disk"></i>保存</button></div>
          ${hasData ? "" : '<span class="note">データを読み込むと保存できます。</span>'}
          <ul class="setlist">${sets.map((s) => `<li class="setlist__row" data-id="${DM.esc(s.id)}">
            ${editing === s.id ? `<input class="input" type="text" data-rename maxlength="${DM.prefs.MAX_NAME}" value="${DM.esc(s.name)}" aria-label="新しい名前（Enter で決定・Esc でやめる）">`
              : `<div class="setlist__main"><b>${DM.esc(s.name)}</b><small>${DM.esc(DM.prefs.describe(s.state))}・${when(s.at)}</small></div>`}
            <button class="btn" data-apply ${hasData ? "" : "disabled"} title="${hasData ? "この設定を表に当てはめる" : "データを読み込むと当てはめられます"}"><i class="fa-solid fa-check"></i>当てはめる</button>
            <details class="menu-d"><summary class="btn btn--icon btn--ghost" title="この作業セットの操作" aria-label="${DM.esc(s.name)} の操作"><i class="fa-solid fa-ellipsis-vertical"></i></summary>
              <div class="menu-d__box"><button class="btn btn--ghost" data-overwrite ${hasData ? "" : "disabled"}><i class="fa-solid fa-floppy-disk"></i>いまの設定で上書き</button>
              <button class="btn btn--ghost" data-edit><i class="fa-solid fa-pen"></i>名前を変える</button>
              <button class="btn btn--ghost btn--danger" data-remove><i class="fa-solid fa-trash-can"></i>削除（元に戻せます）</button></div></details></li>`).join("") || '<li class="note">まだ作業セットはありません。</li>'}</ul></div>
        <div class="group"><div class="group__title"><i class="fa-solid fa-right-left"></i>書き出し・読み込み（ほかの PC へ渡す）</div>
          <div class="row"><button class="btn" data-export ${sets.length ? "" : "disabled"} title="${sets.length ? "" : "書き出す作業セットがありません"}"><i class="fa-solid fa-download"></i>書き出す（JSON）</button>
            <button class="btn" data-import><i class="fa-solid fa-upload"></i>読み込む</button></div>
          <div class="dropzone" data-drop tabindex="0"><i class="fa-solid fa-file-import"></i> 書き出した JSON をここへドロップ</div>
          <input type="file" accept=".json,application/json" data-file hidden></div>
        <div class="group"><div class="group__title"><i class="fa-solid fa-clock-rotate-left"></i>自動保存</div>
          <div class="note"><span>条件・並べ替え・列・列幅は、列の構成ごとに自動で覚え、同じ構成の表を読み込んだら当てはめます（覚えている表 ${DM.prefs.tableCount()}）。</span></div>
          <button class="btn btn--ghost" data-clearauto ${DM.prefs.hasAuto() ? "" : "disabled"} title="${DM.prefs.hasAuto() ? "この表の設定を忘れて、初期の表示に戻します" : "この表の自動保存はまだありません"}"><i class="fa-solid fa-eraser"></i>この表の自動保存を消す</button>
          <span class="note">保存の量：${DM.fmtNum(Math.ceil(used / 1000))} KB / ${DM.fmtNum(DM.prefs.LIMIT / 1000)} KB（この PC・このブラウザ）</span></div>`;
      if (focusName) { const f = el.querySelector("[data-setname]"); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }
      const r = el.querySelector("[data-rename]"); if (r) { r.focus(); r.select(); }
    };
    const save = () => {
      const inp = el.querySelector("[data-setname]"), res = DM.prefs.saveSet(inp.value);
      if (!res.ok) { if (res.reason) DM.toast(res.reason, { icon: "fa-circle-exclamation" }); inp.focus(); return; }
      const name = inp.value.trim();
      const cur = el.querySelector("[data-setname]"); if (cur) cur.value = "";   // 保存で描き直したあとの欄を空にする
      DM.toast(`作業セット「${name}」を${res.overwrote ? "上書き" : "保存"}しました`, { icon: "fa-bookmark", undo: res.undo });
      draw();
    };
    const importText = (text) => {
      const r = DM.prefs.importJson(text);
      if (!r.ok) { if (r.reason) DM.toast("読み込めませんでした：" + r.reason, { icon: "fa-circle-exclamation" }); return; }
      DM.toast(`作業セットを ${r.added} 件読み込みました${r.skipped ? `（${r.skipped} 件は読めない・上限のため入れていません）` : ""}`, { icon: "fa-upload", undo: r.undo });
    };
    const readFile = (f) => {
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) { DM.toast("ファイルが大きすぎます（2MB まで）", { icon: "fa-circle-exclamation" }); return; }
      f.text().then(importText).catch(() => DM.toast("ファイルを読めませんでした", { icon: "fa-circle-exclamation" }));
    };
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const row = b.closest("[data-id]"), id = row && row.dataset.id;
      if (b.dataset.save !== undefined) save();
      else if (b.dataset.apply !== undefined) { const r = DM.prefs.applySet(id); if (r) DM.toast(`「${r.name}」を当てはめました（${r.text}）${r.dropped ? `。この表に無い列の条件・並べ替え ${r.dropped} 件は外しました` : ""}`, { icon: "fa-check", undo: r.undo }); }
      else if (b.dataset.overwrite !== undefined) { const s = DM.prefs.sets().find((x) => x.id === id); if (s) { const r = DM.prefs.saveSet(s.name); if (r.ok) DM.toast(`「${s.name}」をいまの設定で上書きしました`, { icon: "fa-floppy-disk", undo: r.undo }); } }
      else if (b.dataset.edit !== undefined) { editing = id; draw(); }
      else if (b.dataset.remove !== undefined) { const r = DM.prefs.removeSet(id); if (r) DM.toast(`作業セット「${r.name}」を削除しました`, { icon: "fa-trash-can", undo: r.undo }); }
      else if (b.dataset.export !== undefined) {
        const blob = new Blob([DM.prefs.exportJson()], { type: "application/json" }), a = document.createElement("a"), d = new Date();
        a.href = URL.createObjectURL(blob); a.download = `docMaker_作業セット_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.json`;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        DM.toast(`作業セット ${DM.prefs.sets().length} 件を書き出しました（${a.download}）`, { icon: "fa-download" });
      }
      else if (b.dataset.import !== undefined) el.querySelector("[data-file]").click();
      else if (b.dataset.clearauto !== undefined) { const r = DM.prefs.clearAuto(); if (r) DM.toast("この表の自動保存を消しました（いまの表示はそのまま）", { icon: "fa-eraser", undo: r.undo }); }
    });
    el.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.target.matches("[data-setname]") && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); save(); }
      if (e.target.matches("[data-rename]")) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); editing = ""; draw(); }
        if (e.key === "Enter") {
          e.preventDefault(); e.stopPropagation();
          const r = DM.prefs.renameSet(editing, e.target.value);
          if (!r.ok) { if (r.reason) DM.toast(r.reason, { icon: "fa-circle-exclamation" }); return; }
          editing = ""; draw(); DM.toast("名前を変えました", { icon: "fa-pen" });
        }
      }
    }, true);
    el.addEventListener("change", (e) => { if (e.target.matches("[data-file]")) { readFile(e.target.files[0]); e.target.value = ""; } });
    el.addEventListener("dragover", (e) => { const z = e.target.closest("[data-drop]"); if (z) { e.preventDefault(); z.classList.add("is-over"); } });
    el.addEventListener("dragleave", (e) => { const z = e.target.closest("[data-drop]"); if (z) z.classList.remove("is-over"); });
    el.addEventListener("drop", (e) => { const z = e.target.closest("[data-drop]"); if (!z) return; e.preventDefault(); z.classList.remove("is-over"); readFile(e.dataTransfer.files[0]); });
    ["prefs", "data"].forEach((n) => DM.bus.on(n, draw)); draw();
  };
})();
