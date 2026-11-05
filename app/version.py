# -*- coding: utf-8 -*-
"""アプリの版と更新履歴（WaveLog backend/changelog_data.py と同じ形）。

- APP_VERSION は「大.中.小」。配るたびに上げる（直した・足した: 小、画面や使い方が変わる: 中、作り直し: 大）。
- CHANGELOG の先頭は APP_VERSION と同じ。新しい版を上に足す。
- RELEASE は「配った版と、そのときの配る物の中身の要約」。手で書かず `python app_build.py --release` で書く。
  tests/test_version.py が、いまの中身と RELEASE を比べる（版を上げずにプログラムを変えると失敗する）。
  手順: プログラムを直す → APP_VERSION を上げ、CHANGELOG の先頭に1件足す → python app_build.py --release → テスト
- 「最新版」は、使っている人たちの版のうちいちばん新しいもの（services/presence.py）。
  古い版の人には見出しの版の札の横に「新しい版あり」を出す（止めはしない）。
"""
APP_VERSION = "0.2.0"
RELEASE = {"version": "0.2.0", "digest": "4304307029b99169"}

CHANGELOG = [
    {"version": "0.2.0", "date": "2026-11-05", "notes": [
        "版の管理を始めました。見出しの版の札を押すと、この更新履歴が開きます。",
        "ほかの人が新しい版を使い始めると、札の横に「新しい版あり」が出ます（止めはしません）。「利用状況」で、だれがどの PC でどの版を使っているかを見られます。",
        "プログラムのファイルが入れ替わったのに、前から動いていた古いサーバーが残っているときは、画面の上に「開き直してください」と出します。",
        "Python（Flask）のサーバーで動く形にしました。起動は Start.bat。画面の一式は web/ に移しました。",
    ]},
    {"version": "0.1.0", "date": "2026-11-05", "notes": [
        "画面（レイアウト）を作りました。ロットの検索・絞り込み・選択、帳票形式の選択（仮の3種）、転記内容の確認と印刷、サンプルデータ、取扱説明書。",
    ]},
]


def version_key(v):
    """'1.10.0' > '1.9.3' のように数で比べるための形。読めない部分は 0。"""
    out = []
    for part in str(v or "").split("."):
        try:
            out.append(int(part))
        except ValueError:
            out.append(0)
    return tuple(out + [0] * (3 - len(out)))
