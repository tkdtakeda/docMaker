# -*- coding: utf-8 -*-
"""docMaker のサーバー（Flask）。"""
import atexit
import json
from pathlib import Path

from flask import Flask

APP_ID = "docMaker"
BASE_DIR = Path(__file__).resolve().parent.parent

DEFAULT_SETTINGS = {
    "server": {"host": "127.0.0.1", "port": 57830, "open_browser": True},
    "lot_list": {"source": "", "table": "", "page_size": 200, "interval_sec": 60, "stale_hours": 36},
    "reports": {"dir": ""},       # 帳票の置き場。空なら data/reports（この PC の中だけ）。共有フォルダを入れると全 PC で同じ帳票を使える
    "presence": {"dir": ""},      # 空なら data/presence_docmaker（この PC の中だけ）。共有フォルダを入れると、ほかの PC の版も見える
}


def load_settings(base=BASE_DIR):
    s = json.loads(json.dumps(DEFAULT_SETTINGS))
    try:
        data = json.loads((Path(base) / "config" / "settings.json").read_text(encoding="utf-8"))
        for k, v in (data or {}).items():
            s[k] = {**s.get(k, {}), **v} if isinstance(v, dict) else v
    except (OSError, ValueError):
        pass
    return s


USER_SETTINGS = "user_settings.json"        # 画面から変える設定（data/ に置く。config/ に書くと配る物の要約が変わるため）


def user_settings_path(base=BASE_DIR):
    return Path(base) / "data" / USER_SETTINGS


def effective_settings(app):
    """設定の初期値（config/settings.json）に、画面から変えた設定（data/user_settings.json）を重ねたもの。"""
    s = json.loads(json.dumps(app.config["SETTINGS"]))
    try:
        data = json.loads(user_settings_path(app.config["BASE_DIR"]).read_text(encoding="utf-8"))
        for k, v in (data or {}).items():
            s[k] = {**s.get(k, {}), **v} if isinstance(v, dict) else v
    except (OSError, ValueError):
        pass
    return s


def lot_list_params(settings):
    """ロット一覧の写しの係へ渡す値 → (元ファイル, 見に行く間隔(秒), 古いとみなす時間)。"""
    ll = settings.get("lot_list") or {}
    return (str(ll.get("source") or ""), int(ll.get("interval_sec") or 60), float(ll.get("stale_hours") if ll.get("stale_hours") is not None else 36))


def create_app(base=BASE_DIR, settings=None):
    import app_build
    from .routes import bp
    from .routes.common import me
    from .services import presence

    base = Path(base)
    app = Flask(__name__, static_folder=str(base / "web"), static_url_path="")
    app.config["MAX_CONTENT_LENGTH"] = 40 * 1024 * 1024      # ひな形（Excel）の保存のため
    app.config.update(BASE_DIR=base, WEB_DIR=base / "web", SETTINGS=settings or load_settings(base),
                      BUILD=app_build.fingerprint(base))     # 起動したときの指紋（いまのディスクと違えば stale）
    pdir = (app.config["SETTINGS"].get("presence") or {}).get("dir")
    if not pdir:       # この PC の中だけの既定の置き場は作る（共有フォルダの置き場そのものは作らない）
        pdir = str(base / "data" / "presence_docmaker")
        (base / "data").mkdir(parents=True, exist_ok=True)
    presence.configure(pdir)
    from .services.db_mirror import DbMirror
    (base / "data").mkdir(parents=True, exist_ok=True)
    want = lot_list_params(effective_settings(app))
    app.config["LOT_MIRROR"] = DbMirror("lot", want[0], base / "data" / "mirror", interval_sec=want[1], stale_hours=want[2])
    app.config["LOT_APPLIED"] = want
    app.register_blueprint(bp)
    m = me()
    atexit.register(lambda: presence.leave(m["login"], m["pc"]))
    return app
