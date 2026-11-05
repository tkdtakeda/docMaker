# -*- coding: utf-8 -*-
"""起動: python run.py（Start.bat から）。ブラウザで画面を開く。--no-browser で開かない。"""
import sys
import threading
import webbrowser

from app import create_app


def main():
    app = create_app()
    srv = app.config["SETTINGS"]["server"]
    url = f"http://{srv['host']}:{srv['port']}/"
    if srv.get("open_browser", True) and "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    port = srv["port"]
    for a in sys.argv:
        if a.startswith("--port="):
            port = int(a.split("=", 1)[1])
    print(f"docMaker を起動しました: {url}（終了は Ctrl+C）")
    app.run(host=srv["host"], port=port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
