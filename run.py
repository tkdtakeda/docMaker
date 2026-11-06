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
    from app.version import APP_VERSION
    print("=" * 52)
    print(f"  docMaker  v{APP_VERSION}  帳票作成ツール")
    print("=" * 52)
    print(f"  画面: {url}")
    print("  終了するには、この窓で Ctrl+C を押すか、窓を閉じてください。")
    print()
    app.run(host=srv["host"], port=port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
