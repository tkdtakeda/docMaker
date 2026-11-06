# -*- coding: utf-8 -*-
"""ルートの共通部品。"""
import getpass
import socket

from flask import Blueprint, jsonify

bp = Blueprint("api", __name__)


def me():
    """この PC・このログインの識別（サーバーは利用者の PC で動くので、サーバーが見た名前を使う）。"""
    try:
        login = getpass.getuser()
    except Exception:
        login = "?"
    return {"login": login, "pc": socket.gethostname() or "?"}


def error(message, status=400, **extra):
    return jsonify(error=message, **extra), status
