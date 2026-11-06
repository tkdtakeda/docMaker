# -*- coding: utf-8 -*-
"""帳票（プリセット・ひな形）の保存 API と、選んだロットの全行 API のテスト。"""
import base64
import json
import sys
import tempfile
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


class Store(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        copy_tree(self.root)
        self.shared = self.root / "shared_reports"
        self.app = create_app(self.root, settings={"presence": {"dir": ""}, "reports": {"dir": str(self.shared)}})
        self.c = self.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_put_get_list_delete(self):
        rec = {"id": "rp_1", "name": "成績書", "items": [], "blocks": {"bands": []}}
        self.assertEqual(self.c.put("/api/reports/reports/rp_1", json=rec).status_code, 200)
        self.assertTrue((self.shared / "reports" / "rp_1.json").exists())            # 共有フォルダに置く
        self.assertEqual(self.c.get("/api/reports/reports/rp_1").get_json()["item"]["name"], "成績書")
        self.assertEqual([x["id"] for x in self.c.get("/api/reports/reports").get_json()["items"]], ["rp_1"])
        self.assertEqual(self.c.post("/api/reports/reports/delete", json={"ids": ["rp_1", "nothing"]}).get_json()["deleted"], 1)
        self.assertEqual(self.c.get("/api/reports/reports/rp_1").status_code, 404)

    def test_template_binary_roundtrip(self):
        raw = bytes(range(256)) * 100
        rec = {"id": "tpl_1", "name": "ひな形", "buffer": {"__b64": base64.b64encode(raw).decode()}}
        self.c.put("/api/reports/templates/tpl_1", json=rec)
        got = self.c.get("/api/reports/templates/tpl_1").get_json()["item"]
        self.assertEqual(base64.b64decode(got["buffer"]["__b64"]), raw)

    def test_rejects_bad_ids_stores_and_mismatch(self):
        rec = {"id": "../x", "name": "x"}
        self.assertIn(self.c.put("/api/reports/reports/..%2Fx", json=rec).status_code, (400, 404, 405))   # 外へは書かない（ルートに当たらない）
        self.assertEqual(self.c.put("/api/reports/reports/a.b", json={"id": "a.b"}).status_code, 400)
        self.assertEqual(self.c.put("/api/reports/reports/ok1", json={"id": "other"}).status_code, 400)   # 中身と ID が違う
        self.assertEqual(self.c.get("/api/reports/masters").status_code, 400)                              # 保存先にない種類
        self.assertEqual(self.c.post("/api/reports/reports/delete", json={"ids": "x"}).status_code, 400)
        self.assertFalse((self.root / "x.json").exists())

    def test_too_large_is_refused(self):
        big = {"id": "big", "buffer": {"__b64": "A" * (41 * 1024 * 1024)}}
        r = self.c.put("/api/reports/templates/big", data=json.dumps(big), content_type="application/json")
        self.assertIn(r.status_code, (400, 413))

    def test_unreadable_file_is_skipped_not_deleted(self):
        d = self.shared / "reports"
        d.mkdir(parents=True)
        (d / "bad.json").write_text("{ broken", encoding="utf-8")
        self.assertEqual(self.c.get("/api/reports/reports").get_json()["items"], [])
        self.assertTrue((d / "bad.json").exists())

    def test_default_dir_is_local_data(self):
        app = create_app(self.root, settings={"presence": {"dir": ""}})
        app.test_client().put("/api/reports/reports/rp_9", json={"id": "rp_9"})
        self.assertTrue((self.root / "data" / "reports" / "reports" / "rp_9.json").exists())

    def test_report_page_is_served(self):
        r = self.c.get("/report.html")
        self.assertEqual(r.status_code, 200)
        self.assertIn(b"report/js/adapter.js", r.data)


class Lots(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = str(Path(cls.tmp.name) / "q.sqlite3")
        make_sample_db.build(cls.db, 300)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_all_rows_of_the_lots(self):
        g = lot_list.query(self.db, group=True, page_size=400)
        multi = [row["ロット番号"] for row, (n, _) in zip(g["rows"], g["groups"]) if n > 1][:2]
        self.assertTrue(multi, "複数行のロットがサンプルにある")
        r = lot_list.rows_of_lots(self.db, [multi[0].lower(), " " + multi[1] + " ", multi[0]])   # 大小・空白・重なり
        expect = sum(n for row, (n, i) in zip(g["rows"], g["groups"]) if row["ロット番号"] in multi and i == 1)
        self.assertEqual(len(r["rows"]), expect)
        self.assertEqual({x["ロット番号"] for x in r["rows"]}, set(multi))
        self.assertEqual(r["lotColumn"], "ロット番号")

    def test_limits(self):
        with self.assertRaises(ValueError):
            lot_list.rows_of_lots(self.db, [f"L{i}" for i in range(lot_list.MAX_LOTS + 1)])
        self.assertEqual(lot_list.rows_of_lots(self.db, [])["rows"], [])

    def test_api(self):
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
        copy_tree(root)
        app = create_app(root, settings={"presence": {"dir": ""}, "lot_list": {"source": self.db, "table": "", "page_size": 50, "interval_sec": 10, "stale_hours": 36}})
        c = app.test_client()
        lot = lot_list.query(self.db, page_size=1)["rows"][0]["ロット番号"]
        r = c.post("/api/lotlist/lots", json={"lots": [lot]})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True))
        self.assertTrue(all(x["ロット番号"] == lot for x in r.get_json()["rows"]))
        self.assertEqual(c.post("/api/lotlist/lots", json={"lots": "x"}).status_code, 400)
        tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
