# -*- coding: utf-8 -*-
"""ロット一覧（SQLite の読み取り・写し・API）のテスト。  python -m unittest discover -s tests -v"""
import json
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
sys.path.insert(0, str(BASE / "tools"))
sys.path.insert(0, str(BASE / "tests"))

import make_sample_db  # noqa: E402
from app import create_app  # noqa: E402
from app.services import lot_list  # noqa: E402
from test_version import copy_tree  # noqa: E402

F = lambda *items: json.dumps([{"column": c, "op": o, "value": v} for c, o, v in items], ensure_ascii=False)  # noqa: E731


class Query(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = str(Path(cls.tmp.name) / "q.sqlite3")
        make_sample_db.build(cls.db, 400)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def q(self, **kw):
        return lot_list.query(self.db, **kw)

    def test_columns_and_defaults(self):
        r = self.q()
        self.assertEqual(r["table"], "仕掛")
        self.assertEqual(r["columns"][:3], ["ロット番号", "品名", "品番"])
        self.assertEqual(r["lotColumn"], "ロット番号")
        self.assertIn("製造日", r["dateColumns"])
        self.assertGreater(r["count"], 400)           # 一部のロットは複数行

    def test_search_ignores_width_case_and_kana(self):
        base = self.q(search="SHF")["count"]
        self.assertGreater(base, 0)
        self.assertEqual(self.q(search="ｓｈｆ")["count"], base)      # 全角・小文字
        self.assertEqual(self.q(search="しゃふと")["count"], self.q(search="シャフト")["count"])   # ひらがな・カタカナ
        self.assertGreater(self.q(search="シャフト")["count"], 0)

    def test_wildcards_are_plain_characters(self):
        n = self.q(search="100%")["count"]
        self.assertEqual(self.q(search="%")["count"], n)               # 「%」を含むのは「100%検査」の行だけ（何でも当たるわけではない）
        self.assertGreater(n, 0)
        self.assertLess(n, self.q()["count"])                         # % が「何でも」になっていない
        self.assertEqual(self.q(filters=F(("備考", "contains", "A_1")))["count"], self.q(filters=F(("備考", "contains", "a＿1")))["count"])
        self.assertEqual(self.q(filters=F(("備考", "contains", "A%1")))["count"], 0)

    def test_filter_ops(self):
        total = self.q()["count"]
        eq = self.q(filters=F(("状態", "eq", "完了")))["count"]
        neq = self.q(filters=F(("状態", "neq", "完了")))["count"]
        self.assertEqual(eq + neq, total)
        self.assertEqual(self.q(filters=F(("状態", "eq", "完了"), ("顧客", "contains", "東洋")))["count"],
                         self.q(filters=F(("顧客", "contains", "東洋"), ("状態", "eq", "完了")))["count"])
        self.assertEqual(self.q(filters=F(("担当者", "empty", "")))["count"] + self.q(filters=F(("担当者", "not_empty", "")))["count"], total)
        self.assertGreater(self.q(filters=F(("数量", "gte", "1000")))["count"], 0)
        self.assertEqual(self.q(filters=F(("ロット番号", "starts", "l26")))["count"], self.q(filters=F(("ロット番号", "starts", "Ｌ26")))["count"])

    def test_relative_date_filter(self):
        from datetime import date
        n = self.q(filters=F(("製造日", "within_days", "30")), today=date(2026, 11, 5))["count"]
        self.assertGreater(n, 0)
        self.assertLess(n, self.q()["count"])
        self.assertEqual(self.q(filters=F(("製造日", "within_days", "9999")), today=date(2026, 11, 5))["count"], self.q(filters=F(("製造日", "not_empty", "")))["count"])

    def test_unknown_columns_and_ops_are_ignored(self):
        total = self.q()["count"]
        self.assertEqual(self.q(filters=F(("存在しない列", "contains", "x"), ("状態", "ひどい演算", "x")))["count"], total)
        self.assertEqual(self.q(sorts="[{\"column\":\"存在しない列\"}]")["count"], total)
        self.assertEqual(self.q(filters="{壊れた json")["count"], total)

    def test_sort_and_paging(self):
        a = self.q(sorts=json.dumps([{"column": "数量", "dir": "desc"}]), page_size=10)
        qs = [int(r["数量"]) for r in a["rows"]]
        self.assertEqual(qs, sorted(qs, reverse=True))
        p1, p2 = self.q(page=1, page_size=50), self.q(page=2, page_size=50)
        self.assertEqual(p1["range"], [1, 50])
        self.assertEqual(p2["range"], [51, 100])
        self.assertNotEqual(p1["rows"][0], p2["rows"][0])

    def test_group_never_splits_a_lot_across_pages(self):
        pages, seen = [], []
        n = self.q(group=True, page_size=40)["count"]
        page = 1
        while True:
            r = self.q(group=True, page_size=40, page=page)
            if not r["rows"]:
                break
            lots = [row["ロット番号"] for row in r["rows"]]
            pages.append(lots)
            seen += lots
            self.assertEqual(len(r["groups"]), len(r["rows"]))
            page += 1
        self.assertEqual(len(seen), n)                                 # 取りこぼし・重複なし
        for i in range(len(pages) - 1):
            self.assertFalse(set(pages[i]) & set(pages[i + 1]), "ロットがページの境目で切れている")

    def test_zero_hits_explains_relative_filter(self):
        r = self.q(filters=F(("製造日", "within_days", "1")), today=__import__("datetime").date(2030, 1, 1))
        self.assertEqual(r["count"], 0)
        self.assertEqual(r["dateHints"][0]["column"], "製造日")


class Api(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        copy_tree(self.root)
        self.db = str(self.root / "src.sqlite3")
        make_sample_db.build(self.db, 120)
        self.app = create_app(self.root, settings={"presence": {"dir": ""}, "lot_list": {"source": "", "table": "", "page_size": 50, "interval_sec": 10, "stale_hours": 36}})
        self.c = self.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def set_source(self, path, table=""):
        return self.c.post("/api/settings", json={"lot_list": {"source": path, "table": table}})

    def test_unset_source_says_so(self):
        r = self.c.get("/api/lotlist")
        self.assertEqual(r.status_code, 400)
        self.assertIn("元ファイル", r.get_json()["error"])

    def test_settings_validation_and_storage(self):
        self.assertEqual(self.c.post("/api/settings", json={}).status_code, 400)
        self.assertEqual(self.c.post("/api/settings", json={"lot_list": {"source": 5}}).status_code, 400)
        self.assertEqual(self.c.post("/api/settings", json={"lot_list": {"source": "x" * 501}}).status_code, 400)
        r = self.set_source('  "C:\\data\\q.sqlite3"  ')
        self.assertEqual(r.get_json()["lot_list"]["source"], "C:\\data\\q.sqlite3")        # 引用符・空白を外す
        self.assertTrue((self.root / "data" / "user_settings.json").exists())
        cfg = json.loads((self.root / "config" / "settings.json").read_text(encoding="utf-8"))
        self.assertNotIn("lot_list", cfg)                                                      # 設定ファイル（配る物）は変えない

    def test_reads_through_mirror_and_reports_source(self):
        self.set_source(self.db)
        r = self.c.get("/api/lotlist?page_size=20")
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        j = r.get_json()
        self.assertEqual(len(j["rows"]), 20)
        self.assertTrue(j["source"]["mirrored"])
        self.assertFalse(j["source"]["unreachable"])
        self.assertIsNotNone(j["source"]["at"])
        self.assertIn("mirror", str(self.app.config["LOT_MIRROR"].mirror_path()))     # 写しを読んでいる（元を直接読まない）

    def test_unreachable_source_gives_reason(self):
        self.set_source(str(self.root / "nothing.sqlite3"))
        r = self.c.get("/api/lotlist")
        self.assertEqual(r.status_code, 503)
        j = r.get_json()
        self.assertIn("error", j)
        self.assertTrue(j["source"]["unreachable"] or "見つかりません" in j["error"])

    def test_refresh_picks_up_a_replaced_source(self):
        self.set_source(self.db)
        n0 = self.c.get("/api/lotlist").get_json()["count"]
        con = sqlite3.connect(self.db)
        con.execute("INSERT INTO 仕掛 (ロット番号, 品名) VALUES ('NEW-1', '追加')")
        con.commit(); con.close()
        r = self.c.post("/api/lotlist/refresh").get_json()
        self.assertTrue(r["result"]["updated"], r)
        self.assertEqual(self.c.get("/api/lotlist").get_json()["count"], n0 + 1)
        r2 = self.c.post("/api/lotlist/refresh").get_json()                                  # 変わっていなくても写し直す（再読込）
        self.assertTrue(r2["result"]["updated"])

    def test_bad_file_is_rejected_not_adopted(self):
        bad = self.root / "bad.sqlite3"
        bad.write_bytes(b"this is not a database" * 100)
        self.set_source(str(bad))
        r = self.c.get("/api/lotlist")
        self.assertEqual(r.status_code, 503)                                                  # 壊れた元は写しに採用しない

    def test_stale_source_is_flagged(self):
        self.set_source(self.db)
        self.c.get("/api/lotlist")
        m = self.app.config["LOT_MIRROR"]
        m.reconfigure(stale_hours=0.000001)
        time.sleep(0.05)
        self.assertTrue(m.source_info()["stale"])


if __name__ == "__main__":
    unittest.main()
