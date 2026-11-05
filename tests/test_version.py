# -*- coding: utf-8 -*-
"""版管理のテスト。  python -m unittest discover -s tests -v   （リポジトリの最上階層で）

版を上げずにプログラムを変えると test_release_matches が失敗して、直し方を言う。
手順: プログラムを直す → app/version.py の APP_VERSION を上げ、CHANGELOG の先頭に1件足す → python app_build.py --release → テスト
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))

import app_build  # noqa: E402
from app import create_app  # noqa: E402
from app.services import presence  # noqa: E402
from app.version import APP_VERSION, CHANGELOG, RELEASE, version_key  # noqa: E402


def copy_tree(dst):
    """本体の最小のコピー（vendor・layouts は除く）。入れ替えの試しに使う。"""
    for d in ("app", "web", "config"):
        shutil.copytree(BASE / d, Path(dst) / d, ignore=shutil.ignore_patterns("vendor", "layouts", "__pycache__"))
    shutil.copy(BASE / "app_build.py", dst)


class VersionRules(unittest.TestCase):
    def test_changelog_head_is_current(self):
        self.assertEqual(CHANGELOG[0]["version"], APP_VERSION)
        keys = [version_key(e["version"]) for e in CHANGELOG]
        self.assertEqual(keys, sorted(keys, reverse=True), "更新履歴は新しい版が上")

    def test_version_key_compares_numbers(self):
        self.assertGreater(version_key("1.10.0"), version_key("1.9.3"))
        self.assertEqual(version_key("2"), (2, 0, 0))
        self.assertEqual(version_key("x.y"), (0, 0, 0))

    def test_release_matches(self):
        """配る物の中身が、記録（RELEASE）と同じか。違えば、版の上げ忘れ。"""
        now = app_build.release_digest()
        self.assertEqual(
            (RELEASE["version"], RELEASE["digest"]), (APP_VERSION, now),
            f"プログラムが変わっています（記録 {RELEASE['version']}・{RELEASE['digest']} → いま {APP_VERSION}・{now}）。"
            "版を上げて（app/version.py の APP_VERSION と CHANGELOG の先頭）から `python app_build.py --release`。"
            "まだ配っていない版の直しなら `python app_build.py --amend`。")


class Fingerprint(unittest.TestCase):
    def test_changes_when_a_file_changes(self):
        with tempfile.TemporaryDirectory() as t:
            copy_tree(t)
            a = app_build.fingerprint(t)
            (Path(t) / "web" / "index.html").write_text("<!-- changed -->", encoding="utf-8")
            self.assertNotEqual(a, app_build.fingerprint(t))

    def test_digest_ignores_line_endings_and_docs(self):
        with tempfile.TemporaryDirectory() as t:
            copy_tree(t)
            a = app_build.release_digest(t)
            (Path(t) / "README.md").write_text("説明だけ", encoding="utf-8")
            p = Path(t) / "web" / "index.html"
            p.write_bytes(p.read_bytes().replace(b"\n", b"\r\n"))
            self.assertEqual(a, app_build.release_digest(t))

    def test_record_release_refuses_without_bump(self):
        with tempfile.TemporaryDirectory() as t:
            copy_tree(t)
            app_build.record_release(t, amend=True)      # コピーは vendor などを除くので、先に記録し直す
            self.assertIn("記録済み", app_build.record_release(t))
            (Path(t) / "web" / "index.html").write_text("<!-- changed -->", encoding="utf-8")
            with self.assertRaises(SystemExit) as e:
                app_build.record_release(t)
            self.assertIn("版を上げて", str(e.exception))
            self.assertIn("記録しました", app_build.record_release(t, amend=True))


class Server(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        copy_tree(self.tmp.name)
        self.app = create_app(self.tmp.name, settings={"presence": {"dir": ""}})
        self.c = self.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_instance_and_stale(self):
        r = self.c.get("/api/instance").get_json()
        self.assertEqual((r["app"], r["version"], r["stale"]), ("docMaker", APP_VERSION, False))
        # 起動したあとにプログラムのファイルが入れ替わった → 古いサーバー
        (Path(self.tmp.name) / "web" / "js").mkdir(exist_ok=True)
        (Path(self.tmp.name) / "web" / "js" / "new.js").write_text("// new", encoding="utf-8")
        from app.routes import system
        system._DISK_BUILD["at"] = 0.0           # 2 秒の控えを捨てる
        self.assertTrue(self.c.get("/api/instance").get_json()["stale"])

    def test_index_has_fingerprint_urls_and_no_store(self):
        r = self.c.get("/")
        html = r.get_data(as_text=True)
        self.assertEqual(r.headers["Cache-Control"], "no-store")
        self.assertIn(f'js/core.js?v={self.app.config["BUILD"]}', html)
        self.assertIn(f'css/tokens.css?v={self.app.config["BUILD"]}', html)

    def test_changelog_and_build(self):
        self.assertEqual(self.c.get("/api/build").get_json()["version"], APP_VERSION)
        self.assertEqual(self.c.get("/api/changelog").get_json()["entries"][0]["version"], APP_VERSION)

    def test_heartbeat_writes_presence(self):
        presence._state["busy"] = False
        self.c.post("/api/heartbeat", json={"visible": True})
        for _ in range(50):
            if presence.fleet()["total"]:
                break
            time.sleep(0.05)
        f = self.c.get("/api/presence").get_json()
        self.assertEqual(f["total"], 1)
        self.assertTrue(f["items"][0]["online"])
        self.assertEqual(f["items"][0]["version"], APP_VERSION)


class Presence(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / "p"
        presence.configure(self.dir)

    def tearDown(self):
        self.tmp.cleanup()

    def _hist(self, key, version, login="u", pc="pc"):
        h = self.dir / "history"
        h.mkdir(parents=True, exist_ok=True)
        (h / f"{key}.json").write_text(json.dumps({"key": key, "login": login, "pc": pc, "version": version,
                                                   "lastAt": datetime.now().isoformat(timespec="seconds"), "sessions": 1}), encoding="utf-8")

    def test_latest_is_newest_of_all(self):
        self._hist("a", "0.9.0"); self._hist("b", "0.10.0"); self._hist("c", "0.2.0")
        self.assertEqual(presence.latest_version(), "0.10.0")        # 数で比べる（文字なら 0.9.0）
        presence.refresh_newest()
        n = presence.version_notice()
        self.assertEqual((n["latestVersion"], n["outdated"]), ("0.10.0", True))   # 自分は 0.2.0 → 新しい版あり

    def test_not_outdated_when_newest(self):
        self._hist("a", APP_VERSION)
        presence.refresh_newest()
        self.assertFalse(presence.version_notice()["outdated"])

    def test_unknown_is_none_not_false(self):
        self.assertIsNone(presence.version_notice())                  # 数えていないときは「分からない」

    def test_unreadable_file_is_kept(self):
        (self.dir / "history").mkdir(parents=True)
        bad = self.dir / "history" / "x.json"
        bad.write_text("{ broken", encoding="utf-8")
        presence.fleet()
        self.assertTrue(bad.exists())                                 # 読めないものは消さない

    def test_touch_then_leave(self):
        presence.configure(self.dir)
        self.assertTrue(presence.touch("u", "pc1", force=True))
        f = presence.fleet()
        self.assertEqual((f["total"], f["online"]), (1, 1))
        presence.leave("u", "pc1")
        f = presence.fleet()
        self.assertEqual((f["total"], f["online"]), (1, 0))           # 記録は残り、いま使っているは消える
        self.assertEqual(f["items"][0]["sessions"], 1)

    def test_key_is_safe_for_filenames(self):
        k = presence.terminal_key("a:b", "pc 1")
        self.assertNotRegex(k, r'[\\/:*?"<>|\s]')


if __name__ == "__main__":
    unittest.main()
