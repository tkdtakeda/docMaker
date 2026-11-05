/* ── sample-data: サンプルデータ（§11）──────────────────────
   使い方ごとの複数パターン。乱数の種を固定し、毎回同じデータを出す。
   読み込むだけで動作確認でき、「サンプルだけ」を消せる（実データは残す）。 */
(function () {
  "use strict";
  const DM = window.DM;

  DM.COLUMNS = ["ロット番号", "品名", "品番", "顧客", "工程", "数量", "単位", "製造日", "納期", "状態", "担当者", "検査結果", "備考"];

  function rng(seed) {                      // 乱数の種を固定（mulberry32）
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pad = (n, w) => String(n).padStart(w, "0");
  const ymd = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1, 2)}/${pad(d.getDate(), 2)}`;
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

  const PRODUCTS = [["ブラケットA", "BRK-1001"], ["シャフト φ12", "SHF-2012"], ["カバー（大）", "CVR-3300"], ["ギアハウジング", "GHS-4100"],
    ["フランジ 50A", "FLG-5050"], ["ピストンロッド", "PST-6120"], ["端子台 6P", "TRM-7006"], ["ベースプレート", "BPL-8800"]];
  const CUSTOMERS = ["東洋精機（株）", "北辰工業（株）", "三和電装（株）", "（有）明星製作所", "大和プレシジョン（株）"];
  const PROCESSES = ["切削", "研削", "熱処理", "メッキ", "組立", "検査", "梱包"];
  const STATES = ["仕掛中", "検査待ち", "保留", "完了", "出荷待ち"];
  const PEOPLE = ["山田", "佐藤", "鈴木", "高橋", "田中", "伊藤"];
  const RESULTS = ["合格", "合格", "合格", "条件付合格", "不合格"];
  const NOTES = ["", "", "", "特急", "再検査あり", "顧客指定ロット", "外観注意"];
  const pick = (r, a) => a[Math.floor(r() * a.length)];

  function makeRow(r, lotNo, today, opt) {
    const [name, code] = pick(r, PRODUCTS);
    const made = addDays(today, -Math.floor(r() * (opt.span || 90)));
    const row = {
      "ロット番号": lotNo, "品名": name, "品番": code, "顧客": pick(r, CUSTOMERS), "工程": pick(r, PROCESSES),
      "数量": 50 * (1 + Math.floor(r() * 40)), "単位": "個", "製造日": ymd(made), "納期": ymd(addDays(made, 14 + Math.floor(r() * 30))),
      "状態": pick(r, STATES), "担当者": pick(r, PEOPLE), "検査結果": pick(r, RESULTS), "備考": pick(r, NOTES),
    };
    (opt.blank || []).forEach((col) => { if (r() < (opt.blankRate || 0.3)) row[col] = ""; });
    return row;
  }

  /* パターンを足すときは register するだけ（開放閉鎖 §9） */
  DM.samples = DM.createRegistry();

  DM.samples.register({
    id: "standard", icon: "fa-table-list", name: "標準（仕掛一覧）", desc: "60 ロット。検索・フィルター・並べ替えの基本確認に。",
    build(today) { const r = rng(101); return Array.from({ length: 60 }, (_, i) => makeRow(r, `L${today.getFullYear() % 100}${pad(i + 1, 4)}`, today, {})); },
  });
  DM.samples.register({
    id: "multi", icon: "fa-layer-group", name: "同一ロットが複数行", desc: "12 ロット × 工程別 2〜4 行。ロット番号でまとめる確認に。",
    build(today) {
      const r = rng(202), out = [];
      for (let i = 1; i <= 12; i++) {
        const lot = `M${today.getFullYear() % 100}${pad(i, 4)}`, base = makeRow(r, lot, today, {});
        const n = 2 + Math.floor(r() * 3);
        for (let k = 0; k < n; k++) out.push(Object.assign({}, base, { "工程": PROCESSES[(k + i) % PROCESSES.length], "担当者": pick(r, PEOPLE) }));
      }
      return out;
    },
  });
  DM.samples.register({
    id: "missing", icon: "fa-triangle-exclamation", name: "必須項目の欠け", desc: "30 ロット。検査結果・担当者・納期の空欄を含む（不足の確認に）。",
    build(today) { const r = rng(303); return Array.from({ length: 30 }, (_, i) => makeRow(r, `X${today.getFullYear() % 100}${pad(i + 1, 4)}`, today, { blank: ["検査結果", "担当者", "納期"], blankRate: 0.3 })); },
  });
  DM.samples.register({
    id: "large", icon: "fa-gauge-high", name: "大量（5,000 行）", desc: "表示の速さの確認に。",
    build(today) { const r = rng(404); return Array.from({ length: 5000 }, (_, i) => makeRow(r, `B${pad(i + 1, 5)}`, today, { span: 365 })); },
  });

  /* 読み込み：同じパターンは入れ替え、実データ（_sample でない行）はそのまま残す */
  DM.sampleLoad = function (id) {
    const p = DM.samples.get(id);
    if (!p) return 0;
    const s = DM.store;
    const keep = s.rows.filter((r) => r._sample !== id);          // 実データと別パターンは残し、同じパターンだけ入れ替える
    const fresh = p.build(new Date()).map((row) => Object.assign({ _id: s.nextId(), _sample: id }, row));
    s.setData(DM.COLUMNS, keep.concat(fresh), { kind: "sample", label: "サンプル：" + p.name, at: Date.now() });
    return fresh.length;
  };

  /* サンプルだけを消す（自分で作ったデータは消さない §11） */
  DM.sampleClear = function () {
    const s = DM.store, before = s.rows.slice(), removed = before.filter((r) => r._sample).length;
    const keepSel = Array.from(s.selected).filter((id) => { const r = s.byId(id); return r && !r._sample; });
    const prevSource = s.source;
    s.setData(DM.COLUMNS, before.filter((r) => !r._sample), { kind: "none", label: "データ未読込", at: null });
    s.setSelected(keepSel);
    return { removed, undo() { s.setData(DM.COLUMNS, before, prevSource); } };
  };
})();
