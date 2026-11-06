# -*- coding: utf-8 -*-
"""帳票（プリセット）とひな形（Excel）の保存。CDB では各 PC のブラウザ内（IndexedDB）だったものを、共有フォルダに置く。

置き場: 設定 reports.dir（共有フォルダ）の下。空なら data/reports（この PC の中だけ）。
    reports/<id>.json    … 帳票プリセット（CDB の preset そのまま）
    templates/<id>.json  … ひな形（Excel は base64 で { "__b64": … } の形。画面の adapter.js が変換する）
1 つの帳票は 1 つのファイル。書くときは一時ファイル → 置き換え（読む側が書きかけを見ない）。
同じ帳票を 2 台で同時に直したときは、後から保存したほうが残る（いまは衝突を知らせない）。
読めないファイルは一覧から外すが、消さない。
"""
import json
import re
from pathlib import Path

from ..fsio import retrying, write_json_atomic

STORES = ("reports", "templates")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
MAX_BYTES = 30 * 1024 * 1024          # ひな形 15MB の base64 が入る大きさ


class StoreError(ValueError):
    pass


class ReportStore:
    def __init__(self, root):
        self.root = Path(root)

    def _dir(self, store):
        if store not in STORES:
            raise StoreError(f"「{store}」は保存先にありません")
        return self.root / store

    def _path(self, store, rid):
        if not ID_RE.match(str(rid or "")):
            raise StoreError("帳票の ID が正しくありません（英数字・_・- の 80 文字まで）")
        return self._dir(store) / f"{rid}.json"

    def list(self, store):
        d = self._dir(store)
        out = []
        if not d.exists():
            return out
        for p in sorted(d.glob("*.json")):
            try:
                rec = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue                    # 読めないものは出さない（消さない）
            if isinstance(rec, dict) and rec.get("id") == p.stem:
                out.append(rec)
        return out

    def get(self, store, rid):
        p = self._path(store, rid)
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None

    def put(self, store, rid, rec, raw_size=0):
        p = self._path(store, rid)
        if not isinstance(rec, dict) or rec.get("id") != rid:
            raise StoreError("帳票の中身と ID が合いません")
        if raw_size > MAX_BYTES:
            raise StoreError(f"大きすぎます（{MAX_BYTES // 1024 // 1024}MB まで）。ひな形の不要なシートや画像を消してください")
        write_json_atomic(p, rec, indent=None, retry_budget=2.0)
        return rid

    def delete(self, store, ids):
        n = 0
        for rid in ids or []:
            p = self._path(store, rid)
            try:
                retrying(p.unlink, 1.0)
                n += 1
            except FileNotFoundError:
                pass
        return n
