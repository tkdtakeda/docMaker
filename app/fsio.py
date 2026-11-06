# -*- coding: utf-8 -*-
"""ファイル入出力の小さな部品（共有フォルダ越しでも壊さない書き方）。"""
import json
import os
import time
from datetime import datetime
from pathlib import Path


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def retrying(fn, budget=2.0, waits=(0.05, 0.1, 0.2, 0.4, 0.8)):
    """Windows では開かれている間、置き換え・削除が拒まれる。少し待ってやり直す（budget 秒まで）。"""
    start, err = time.monotonic(), None
    for w in (0,) + tuple(waits):
        if w:
            time.sleep(w)
        try:
            return fn()
        except (PermissionError, OSError) as e:
            err = e
            if time.monotonic() - start > budget:
                break
    raise err


def write_json_atomic(path, data, indent=1, retry_budget=2.0):
    """一時ファイルへ書いてから置き換える（読む側が書きかけを見ない）。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=indent), encoding="utf-8")
    try:
        retrying(lambda: os.replace(tmp, path), retry_budget)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
