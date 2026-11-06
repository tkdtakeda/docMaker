# -*- coding: utf-8 -*-
"""画面・版・起動の確認（/api/instance）・心拍・利用状況。"""
import os
import re
import sys
import time

from flask import current_app, jsonify, make_response

import app_build

from .. import APP_ID
from ..fsio import now_iso
from ..services import presence
from ..version import APP_VERSION, CHANGELOG
from .common import bp, me

_ASSET = re.compile(r'''((?:href|src)=")((?:css|js)/[^"?]+)(")''')


@bp.get("/")
def index():
    """画面。css・js の URL に指紋を付ける（古い JS を使い回さない）。画面はいつもサーバーから（キャッシュしない）。"""
    build = current_app.config.get("BUILD", "")
    path = current_app.config["WEB_DIR"] / "index.html"
    html = _ASSET.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={build}{m.group(3)}", path.read_text(encoding="utf-8"))
    resp = make_response(html)
    resp.headers["Content-Type"] = "text/html; charset=utf-8"
    resp.headers["Cache-Control"] = "no-store"
    return resp


@bp.get("/api/build")
def build():
    return jsonify(version=APP_VERSION)


@bp.get("/api/changelog")
def changelog():
    return jsonify(version=APP_VERSION, entries=CHANGELOG)


@bp.get("/api/health")
def health():
    return jsonify(status="ok")


@bp.post("/api/heartbeat")
def heartbeat():
    """心拍のついでに利用状況を書き（20 秒ごと・裏で）、新しい版があるかを返す（見出しの札）。"""
    try:
        m = me()
        presence.touch_async(m["login"], m["pc"])
        return jsonify(version=presence.version_notice(), me=m)
    except Exception:
        return jsonify(version=None)


@bp.get("/api/presence")
def presence_fleet():
    """利用状況（だれが・どの PC で・どの版を使っているか）。"""
    return jsonify(presence.fleet())


# ---------------- 起動の確認（画面・起動の仕組みが尋ねる） ----------------
_DISK_BUILD = {"at": 0.0, "value": ""}


def _disk_build():
    """いまのディスクの指紋（2 秒だけ覚える。何度も尋ねられるため）。"""
    now = time.monotonic()
    if now - _DISK_BUILD["at"] > 2:
        _DISK_BUILD.update(at=now, value=app_build.fingerprint(current_app.config["BASE_DIR"]))
    return _DISK_BUILD["value"]


@bp.get("/api/instance")
def instance():
    build = current_app.config.get("BUILD", "")
    return jsonify(
        app=APP_ID, version=APP_VERSION, build=build,
        # 起動したあとにプログラムのファイルが入れ替わった（このサーバーは古い）。開き直す必要がある
        stale=_disk_build() != build,
        app_path=str(current_app.config["BASE_DIR"]), pid=os.getpid(), python=sys.executable,
        status="ready", server_time=now_iso(),
    )
