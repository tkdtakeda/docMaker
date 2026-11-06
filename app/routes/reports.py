# -*- coding: utf-8 -*-
"""帳票（プリセット）とひな形の保存（画面の report/js/adapter.js の CDB.db が呼ぶ）。"""
from flask import current_app, jsonify, request

from .. import effective_settings
from ..services.report_store import MAX_BYTES, ReportStore, StoreError
from .common import bp, error


def store():
    """設定の今の置き場（共有フォルダを入れ直したら、次の問い合わせから切り替わる）。"""
    d = (effective_settings(current_app).get("reports") or {}).get("dir") or str(current_app.config["BASE_DIR"] / "data" / "reports")
    return ReportStore(d)


@bp.get("/api/reports/<name>")
def reports_list(name):
    try:
        s = store()
        return jsonify(items=s.list(name), dir=str(s.root))
    except StoreError as e:
        return error(str(e), 400)
    except OSError as e:
        return error(f"帳票の保存先を読めません：{e}", 503)


@bp.get("/api/reports/<name>/<rid>")
def reports_get(name, rid):
    try:
        rec = store().get(name, rid)
    except StoreError as e:
        return error(str(e), 400)
    if rec is None:
        return error("帳票が見つかりません", 404)
    return jsonify(item=rec)


@bp.put("/api/reports/<name>/<rid>")
def reports_put(name, rid):
    size = request.content_length or 0
    if size > MAX_BYTES:
        return error(f"大きすぎます（{MAX_BYTES // 1024 // 1024}MB まで）", 413)
    rec = request.get_json(silent=True, force=True)
    try:
        store().put(name, rid, rec, size)
    except StoreError as e:
        return error(str(e), 400)
    except OSError as e:
        return error(f"帳票を保存できません（保存先：{e}）", 503)
    return jsonify(ok=True, id=rid)


@bp.post("/api/reports/<name>/delete")
def reports_delete(name):
    body = request.get_json(silent=True, force=True) or {}
    ids = body.get("ids")
    if not isinstance(ids, list):
        return error("ids が必要です", 400)
    try:
        n = store().delete(name, ids)
    except StoreError as e:
        return error(str(e), 400)
    return jsonify(ok=True, deleted=n)
