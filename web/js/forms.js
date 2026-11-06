/* ── forms: 帳票の登録簿（仮）──────────────────────────
   帳票は事前登録済みの前提。いまは仮の 3 種で画面を作る。
   実際の転記・出力ロジックは参考ファイル受領後に、register() で差し替える／足す。
   各帳票は「項目 → DB の列」の対応（cols は候補の優先順）と、必須かどうかを持つ。 */
(function () {
  "use strict";
  const DM = window.DM;
  DM.forms = DM.createRegistry();

  DM.forms.register({
    id: "ship-insp", icon: "fa-clipboard-check", name: "出荷検査成績書", desc: "出荷前の検査結果を顧客へ提出する帳票",
    fields: [
      { key: "lot", label: "ロット番号", cols: ["ロット番号"], required: true, span: 1 },
      { key: "cust", label: "納入先", cols: ["顧客"], required: true, span: 1 },
      { key: "name", label: "品名", cols: ["品名"], required: true, span: 1 },
      { key: "code", label: "品番", cols: ["品番"], required: true, span: 1 },
      { key: "qty", label: "数量", cols: ["数量"], unit: "個", required: true, span: 1, num: true },
      { key: "made", label: "製造日", cols: ["製造日"], required: true, span: 1 },
      { key: "result", label: "検査結果", cols: ["検査結果"], required: true, span: 1 },
      { key: "who", label: "検査担当", cols: ["担当者"], required: true, span: 1 },
      { key: "note", label: "備考", cols: ["備考"], required: false, span: 2 },
    ],
  });
  DM.forms.register({
    id: "lot-card", icon: "fa-clipboard-list", name: "製造指示書（ロットカード）", desc: "現場で工程とともに流す指示書",
    fields: [
      { key: "lot", label: "ロット番号", cols: ["ロット番号"], required: true, span: 1 },
      { key: "name", label: "品名", cols: ["品名"], required: true, span: 1 },
      { key: "code", label: "品番", cols: ["品番"], required: true, span: 1 },
      { key: "proc", label: "現在工程", cols: ["工程"], required: true, span: 1 },
      { key: "qty", label: "投入数量", cols: ["数量"], unit: "個", required: true, span: 1, num: true },
      { key: "due", label: "納期", cols: ["納期"], required: true, span: 1 },
      { key: "who", label: "担当者", cols: ["担当者"], required: false, span: 1 },
      { key: "state", label: "状態", cols: ["状態"], required: false, span: 1 },
      { key: "note", label: "備考", cols: ["備考"], required: false, span: 2 },
    ],
  });
  DM.forms.register({
    id: "delivery", icon: "fa-truck-ramp-box", name: "納品書", desc: "納品内容を顧客へ渡す帳票",
    fields: [
      { key: "cust", label: "納入先", cols: ["顧客"], required: true, span: 2 },
      { key: "name", label: "品名", cols: ["品名"], required: true, span: 1 },
      { key: "code", label: "品番", cols: ["品番"], required: true, span: 1 },
      { key: "qty", label: "数量", cols: ["数量"], unit: "個", required: true, span: 1, num: true },
      { key: "due", label: "納期", cols: ["納期"], required: true, span: 1 },
      { key: "lot", label: "ロット番号", cols: ["ロット番号"], required: false, span: 2 },
    ],
  });

  /* 項目に DB の値を当てる。cols の優先順で最初に値のある列を使う。 */
  DM.forms.resolve = function (form, row) {
    return form.fields.map((f) => {
      let value = "", col = "";
      for (const c of f.cols) { if (!DM.isEmpty(row[c])) { value = row[c]; col = c; break; } }
      if (!col) col = f.cols[0];
      const missing = DM.isEmpty(value);
      return { field: f, value, col, missing, missingRequired: missing && !!f.required };
    });
  };
  /* 確認の要約：不足している必須項目の数と、どの列か */
  DM.forms.check = function (form, rows) {
    const per = rows.map((row) => ({ row, items: DM.forms.resolve(form, row) }));
    const bad = per.map((p) => ({ row: p.row, miss: p.items.filter((i) => i.missingRequired) })).filter((x) => x.miss.length);
    return { per, pages: rows.length, badRows: bad, missingCount: bad.reduce((a, b) => a + b.miss.length, 0) };
  };
  DM.forms.usedColumns = function (form) {
    const s = new Set(); form.fields.forEach((f) => f.cols.forEach((c) => s.add(c))); return s;
  };
  DM.forms.requiredColumns = function (form) {
    const s = new Set(); form.fields.filter((f) => f.required).forEach((f) => s.add(f.cols[0])); return s;
  };

  /* 帳票 1 枚ぶんの HTML（仮の見た目）。値が無い項目は「未入力」と文字でも示す §1-3 */
  DM.forms.renderSheet = function (form, row) {
    const items = DM.forms.resolve(form, row);
    const cells = items.map((i) => {
      const val = i.missing
        ? `<span class="sheet__missing"><i class="fa-solid fa-triangle-exclamation"></i> 未入力${i.field.required ? "（必須）" : ""}</span>`
        : `${DM.esc(i.field.num ? DM.fmtNum(i.value) : i.value)}${i.field.unit ? `<small> ${DM.esc(i.field.unit)}</small>` : ""}`;
      return `<div class="sheet__cell sheet__cell--span${i.field.span || 1}${i.missingRequired ? " is-missing" : ""}" title="DB列：${DM.esc(i.col)}">
        <div class="sheet__label">${DM.esc(i.field.label)}</div><div class="sheet__value">${val}</div></div>`;
    }).join("");
    return `<article class="sheet" data-form="${DM.esc(form.id)}">
      <header class="sheet__head"><h2>${DM.esc(form.name)}</h2><div class="sheet__meta">ロット ${DM.esc(row["ロット番号"] || "—")}</div></header>
      <div class="sheet__grid">${cells}</div>
      <footer class="sheet__foot"><span>承認</span><span>確認</span><span>作成</span></footer>
    </article>`;
  };
})();
