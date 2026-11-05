/* ── core: 名前空間・EventBus・登録簿・状態（単一の置き場）──────────
   普通の <script> で読み込み、window.DM に登録する（ダブルクリックで動かすため §2）。 */
(function () {
  "use strict";
  const DM = (window.DM = window.DM || {});

  /* ── EventBus（部品どうしは購読と通知でつなぐ §9）── */
  DM.bus = (function () {
    const map = {};
    return {
      on(name, fn) { (map[name] = map[name] || []).push(fn); },
      emit(name, payload) { (map[name] || []).forEach((fn) => fn(payload)); },
    };
  })();

  /* ── 登録簿（仲間を足すだけで増やせる §9）── */
  DM.createRegistry = function () {
    const items = new Map();
    return {
      register(item) { items.set(item.id, item); return item; },
      get(id) { return items.get(id); },
      list() { return Array.from(items.values()); },
    };
  };

  /* ── 文字の正規化：全角半角・大文字小文字・ひらがなカタカナを同じとみなす（§6）── */
  DM.norm = function (v) {
    return String(v == null ? "" : v).normalize("NFKC").toLowerCase()
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  };
  DM.esc = function (v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  };
  DM.isEmpty = (v) => v == null || String(v).trim() === "";
  DM.safeStorage = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 保存できなくても動く */ } },
  };

  /* ── 状態（1 か所で管理する §9）── */
  DM.store = {
    columns: [],        // DB と同じ列名（_ で始まる内部項目は含めない）
    rows: [],           // 各行は {_id, _sample, ...列}
    selected: new Set(),
    formId: "",
    source: { kind: "none", label: "データ未読込", at: null },
    _seq: 0,

    setData(columns, rows, source) {
      this.columns = columns.slice();
      this.rows = rows;
      this.selected.clear();
      if (source) this.source = source;
      DM.bus.emit("data");
      DM.bus.emit("selection");
    },
    nextId() { return ++this._seq; },
    byId(id) { return this.rows.find((r) => r._id === id); },
    selectedRows() { return this.rows.filter((r) => this.selected.has(r._id)); },
    setSelected(ids) {
      this.selected = new Set(ids);
      DM.bus.emit("selection");
    },
    setForm(id) { this.formId = id || ""; DM.bus.emit("form"); DM.bus.emit("selection"); },
    sampleCount() { return this.rows.filter((r) => r._sample).length; },
  };

  /* ── 主操作（CTA）は 1 つ。状態でラベルだけを変える §1-2 ──
     件数はツールが数えて文言に入れる。押せないときは理由を返す §1-4。 */
  DM.nextAction = function () {
    const s = DM.store, n = s.selected.size;
    const form = DM.forms && DM.forms.get(s.formId);
    if (!s.rows.length) return { step: 1, label: "① データを読み込む", enabled: true, key: "load", hint: "まだデータを読み込んでいません。サンプルまたはDBを読み込みます。" };
    if (DM.flowOrder === "form-first" && !form) return { step: 2, label: "② 帳票を選ぶ", enabled: false, key: "pickform", reason: "左の一覧から帳票形式を選んでください。" };
    if (!n) return { step: 1, label: "① ロットを選ぶ", enabled: false, key: "pick", reason: "表でロットを選ぶと、次へ進めます。" };
    if (!form) return { step: 2, label: "② 帳票を選ぶ", enabled: true, key: "form", hint: `${n} 件のロットを選択中です。帳票形式を選んでください。` };
    return { step: 3, label: `③ ${n} 件を確認して印刷`, enabled: true, key: "preview", hint: `${form.name} で ${n} 枚` };
  };

  /* ── 通知（取り消し付き §1-5）── */
  DM.toast = function (message, opts) {
    opts = opts || {};
    let host = document.querySelector(".toasts");
    if (!host) { host = document.createElement("div"); host.className = "toasts"; host.setAttribute("role", "status"); document.body.appendChild(host); }
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `<i class="fa-solid ${opts.icon || "fa-circle-check"}"></i><span>${DM.esc(message)}</span>`;
    if (opts.undo) {
      const b = document.createElement("button");
      b.textContent = "元に戻す";
      b.onclick = () => { opts.undo(); el.remove(); };
      el.appendChild(b);
    }
    host.appendChild(el);
    setTimeout(() => el.remove(), opts.undo ? 7000 : 2600);
  };

  /* ── 表示密度 3 段階（§1-9）── */
  DM.density = {
    init() { this.set(DM.safeStorage.get("dm.density", "standard"), true); },
    set(v, silent) {
      if (!["compact", "standard", "comfortable"].includes(v)) v = "standard";
      document.documentElement.setAttribute("data-density", v);
      DM.safeStorage.set("dm.density", v);
      if (!silent) DM.bus.emit("density", v);
    },
    get() { return document.documentElement.getAttribute("data-density") || "standard"; },
  };

  /* ── 入力フォームの共通動作（§6）：全選択・Enter で次へ・IME 変換中は移らない ── */
  DM.enableFormNav = function (root) {
    root.addEventListener("focusin", (e) => {
      const t = e.target;
      if (t.matches && t.matches("input[type=text],input[type=search],input[type=number],input:not([type])")) setTimeout(() => t.select(), 0);
    });
    root.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
      const t = e.target;
      if (!t.matches || !t.matches("[data-nav]")) return;
      e.preventDefault();
      const list = Array.from(root.querySelectorAll("[data-nav]:not(:disabled)"));
      const i = list.indexOf(t) + (e.shiftKey ? -1 : 1);
      if (list[i]) list[i].focus();
    });
  };

  DM.fmtNum = (n) => Number(n).toLocaleString("ja-JP");
  document.addEventListener("DOMContentLoaded", () => DM.density.init());
})();
