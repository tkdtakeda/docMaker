/* ── preview: ③ 確認して印刷 ──────────────────────────
   選択したロット × 選んだ帳票を、1 ロット 1 枚で並べて見せる。
   不足している必須項目は「赤＋アイコン＋『未入力』の文字」で示し、印刷前に気づけるようにする。
   印刷は画面の部品を出さず、帳票だけを出す（sheet.css の @media print）。
   mountPreview(host) は画面内にもモーダルにも置ける。 */
(function () {
  "use strict";
  const DM = window.DM;
  let modal = null;

  DM.print = function (form, rows) {
    let root = document.getElementById("print-root");
    if (!root) { root = document.createElement("div"); root.id = "print-root"; document.body.appendChild(root); }
    root.innerHTML = rows.map((r) => DM.forms.renderSheet(form, r)).join("");
    const done = () => { root.innerHTML = ""; window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
  };

  /* host の中へ、確認画面（上：要約／左：ロット一覧／中央：帳票／下：印刷）を作る */
  DM.mountPreview = function (host, opts) {
    opts = opts || {};
    const form = DM.forms.get(DM.store.formId), rows = DM.store.selectedRows();
    if (!form || !rows.length) { host.innerHTML = `<div class="state"><i class="fa-regular fa-file-lines"></i><strong>確認する帳票がありません</strong><span>ロットと帳票形式を選んでください。</span></div>`; return; }
    const chk = DM.forms.check(form, rows), badIds = new Set(chk.badRows.map((b) => b.row._id));
    host.innerHTML = `
      <div class="preview__head"><span class="tag" style="background:var(--color-step2-soft);color:var(--color-step2)"><i class="fa-solid ${form.icon}"></i>${DM.esc(form.name)}</span>
        ${chk.missingCount ? `<span class="tag tag--warn"><i class="fa-solid fa-triangle-exclamation"></i>${chk.badRows.length} ロットに不足 ${chk.missingCount} 項目</span>` : `<span class="tag tag--ok"><i class="fa-solid fa-circle-check"></i>全 ${rows.length} 枚、必須項目がそろっています</span>`}
        <span class="topbar__spacer"></span>${opts.onClose ? `<button class="btn btn--ghost" data-close title="閉じる（Esc）"><i class="fa-solid fa-xmark"></i>閉じる</button>` : ""}</div>
      <div class="preview__main"><nav class="preview__nav" aria-label="ロット一覧">${rows.map((r, i) => { const m = chk.badRows.find((b) => b.row._id === r._id);
        return `<button class="nav-item ${m ? "is-bad" : ""}" data-go="${r._id}"><span class="nav-item__no">${i + 1}</span><span>${DM.esc(r["ロット番号"] || "—")}${DM.queryState.group && r["工程"] ? ` <small>${DM.esc(r["工程"])}</small>` : ""}</span>${m ? `<span class="tag tag--warn"><i class="fa-solid fa-triangle-exclamation"></i>${m.miss.length}</span>` : '<i class="fa-solid fa-circle-check" style="color:var(--color-ok)" title="必須項目そろっています"></i>'}</button>`; }).join("")}</nav>
        <div class="preview__pages">${rows.map((r) => `<div class="preview__page" data-id="${r._id}">${DM.forms.renderSheet(form, r)}</div>`).join("")}</div></div>
      <div class="preview__foot"><span class="note">${chk.missingCount ? "赤い欄は DB に値がありません。DB を直すか、このまま印刷してください。（印刷では赤色は出ません）" : "各枚の内容を確認して印刷します。"}</span><span class="topbar__spacer"></span>
        <label class="inline"><input type="checkbox" class="check" data-onlymiss ${chk.missingCount ? "" : "disabled"}> 不足のあるロットだけ見る${chk.missingCount ? "" : "（不足はありません）"}</label>
        <button class="btn btn--primary" data-print><i class="fa-solid fa-print"></i> ${chk.missingCount ? `不足を承知で ${rows.length} 枚を印刷` : `${rows.length} 枚を印刷`}</button></div>`;
    const pages = host.querySelector(".preview__pages");
    if (host._pvClick) host.removeEventListener("click", host._pvClick);   // 再描画しても二重に付けない
    host._pvClick = (e) => {
      if (e.target.closest("[data-close]") && opts.onClose) return opts.onClose();
      const g = e.target.closest("[data-go]"); if (g) { const t = pages.querySelector(`[data-id="${g.dataset.go}"]`); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); }
      if (e.target.closest("[data-print]")) DM.print(form, rows);
    };
    host.addEventListener("click", host._pvClick);
    host.querySelector("[data-onlymiss]").addEventListener("change", (e) => pages.querySelectorAll(".preview__page").forEach((p) => p.classList.toggle("hidden", e.target.checked && !badIds.has(+p.dataset.id))));
    const pb = host.querySelector("[data-print]"); if (pb && opts.focusPrint) pb.focus();
  };

  DM.openPreview = function () {
    close();
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal preview" role="dialog" aria-modal="true" aria-label="印刷前の確認" style="width:min(1100px,96vw);height:94dvh"></div>`;
    document.body.appendChild(back); modal = back;
    DM.mountPreview(back.firstChild, { onClose: close, focusPrint: true });
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  };
  function close() { if (modal) { modal.remove(); modal = null; } }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modal) close(); });
  DM.closePreview = close;
})();
