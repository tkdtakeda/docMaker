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


def create_app(base=BASE_DIR, settings=None):
    import app_build
    from .routes import bp
    from .routes.common import me
    from .services import presence

    base = Path(base)
    app = Flask(__name__, static_folder=str(base / "web"), static_url_path="")
    app.config.update(BASE_DIR=base, WEB_DIR=base / "web", SETTINGS=settings or load_settings(base),
                      BUILD=app_build.fingerprint(base))     # 起動したときの指紋（いまのディスクと違えば stale）
    pdir = (app.config["SETTINGS"].get("presence") or {}).get("dir")
    if not pdir:       # この PC の中だけの既定の置き場は作る（共有フォルダの置き場そのものは作らない）
        pdir = str(base / "data" / "presence_docmaker")
        (base / "data").mkdir(parents=True, exist_ok=True)
    presence.configure(pdir)
    app.register_blueprint(bp)
    m = me()
    atexit.register(lambda: presence.leave(m["login"], m["pc"]))
    return app
