# -*- coding: utf-8 -*-
"""画面から変える設定（品質データの元ファイルなど）。data/user_settings.json に保存する。"""
import json

from flask import current_app, jsonify, request

from .. import effective_settings, user_settings_path
from ..fsio import write_json_atomic
from .common import bp, error

LOT_KEYS = {"source": str, "table": str}     # 画面から変えてよい項目（間隔などは設定ファイルで）
MAX_LEN = 500


@bp.get("/api/settings")
def settings_get():
    ll = effective_settings(current_app).get("lot_list") or {}
    return jsonify(lot_list={k: ll.get(k, "") for k in ("source", "table", "page_size")})


@bp.post("/api/settings")
def settings_put():
    body = request.get_json(silent=True, force=True) or {}
    ll = body.get("lot_list")
    if not isinstance(ll, dict):
        return error("lot_list が必要です。", 400)
    clean = {}
    for k, typ in LOT_KEYS.items():
        if k in ll:
            v = ll[k]
            if not isinstance(v, typ) or len(v) > MAX_LEN or "\0" in v:
                return error(f"{k} が正しくありません（{MAX_LEN} 文字までの文字列）。", 400)
            clean[k] = v.strip().strip('"')      # パスのコピーで付く引用符を外す
    path = user_settings_path(current_app.config["BASE_DIR"])
    try:
        cur = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cur = {}
    cur["lot_list"] = {**(cur.get("lot_list") or {}), **clean}
    write_json_atomic(path, cur)
    return settings_get()
