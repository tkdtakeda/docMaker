# -*- coding: utf-8 -*-
"""ロット一覧（品質データ SQLite の写し）。WaveLog routes/lotlist.py と同じ作り。"""
from flask import current_app, jsonify, request

from .. import effective_settings, lot_list_params
from ..services import lot_list
from .common import bp, error


def lot_mirror():
    """設定の今の値に合わせてから返す（画面で参照先を直したら、次の問い合わせで切り替わる）。
    → (写しの係, いまのロット一覧の設定)。設定は1回の問い合わせで1回だけ読む。"""
    settings = effective_settings(current_app)
    m = current_app.config["LOT_MIRROR"]
    want = lot_list_params(settings)
    if want != current_app.config.get("LOT_APPLIED"):     # 前に当てた値から変わったときだけ切り替える
        m.reconfigure(remote=want[0], interval_sec=want[1], stale_hours=want[2])
        current_app.config["LOT_APPLIED"] = want
    m.start()    # 始まっていなければここで始める（何度呼んでもよい）。元が空なら何もしない
    return m, settings.get("lot_list") or {}


@bp.get("/api/lotlist")
def lotlist():
    """page, page_size, search, filters, sorts, group で、写しから引く（lot_list.query）。"""
    m, ll = lot_mirror()
    path = m.read_path()
    if not path:
        return error("品質データの元ファイルが決まっていません。左の「データ」でファイルを指定してください。", 400, source=m.source_info())
    a = request.args
    try:
        out = lot_list.query(path, table=a.get("table", ""), preferred_table=ll.get("table", ""),
                             page=a.get("page", 1), page_size=a.get("page_size", ll.get("page_size", 200)),
                             search=a.get("search", ""), filters=a.get("filters", ""), sorts=a.get("sorts", ""),
                             group=a.get("group") == "1")
    except Exception as e:
        return error(str(e), 503, source=m.source_info())
    out["source"] = m.source_info()
    return jsonify(out)


@bp.get("/api/lotlist/source")
def lotlist_source():
    """いま読んでいるデータはいつのものか（共有は見に行かない）。"""
    return jsonify(lot_mirror()[0].source_info())


@bp.post("/api/lotlist/refresh")
def lotlist_refresh():
    """「再読込」: 共有から取り直す（変わっていなくても写し直す）。"""
    m, _ = lot_mirror()
    if not m.enabled:
        return error("品質データの元ファイルが決まっていません。", 400, source=m.source_info())
    res = m.refresh(force=True)
    return jsonify(result=res, source=m.source_info())


@bp.post("/api/lotlist/lots")
def lotlist_lots():
    """選んだロットの全行（帳票の 1 枚＝同じロット番号の行のまとまり）。body: {lots: [ロット番号…]}"""
    m, ll = lot_mirror()
    path = m.read_path()
    if not path:
        return error("品質データの元ファイルが決まっていません。", 400, source=m.source_info())
    body = request.get_json(silent=True, force=True) or {}
    lots = body.get("lots")
    if not isinstance(lots, list) or not all(isinstance(x, (str, int, float)) for x in lots):
        return error("lots（ロット番号の一覧）が必要です。", 400)
    try:
        out = lot_list.rows_of_lots(path, [str(x) for x in lots], preferred_table=ll.get("table", ""))
    except ValueError as e:
        return error(str(e), 400)
    except Exception as e:
        return error(str(e), 503, source=m.source_info())
    return jsonify(out)
