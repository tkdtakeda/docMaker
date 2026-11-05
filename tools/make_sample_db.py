# -*- coding: utf-8 -*-
"""動作確認用の品質データ（SQLite）を作る。  python tools/make_sample_db.py 出力先.sqlite3 [行数]
本物の SIKADEF.sqlite3 に似せた「仕掛」「品質情報」の 2 表。乱数の種は固定（毎回同じ内容）。
同名の列が 2 つある・日付の書き方が混ざる・空欄がある、など現実のデータの癖も入れてある。"""
import random
import sqlite3
import sys
from datetime import date, timedelta

PRODUCTS = [("ブラケットA", "BRK-1001"), ("シャフト φ12", "SHF-2012"), ("カバー（大）", "CVR-3300"), ("ギアハウジング", "GHS-4100"),
            ("フランジ 50A", "FLG-5050"), ("ピストンロッド", "PST-6120"), ("端子台 6P", "TRM-7006"), ("ベースプレート", "BPL-8800")]
CUSTOMERS = ["東洋精機（株）", "北辰工業（株）", "三和電装（株）", "（有）明星製作所", "大和プレシジョン（株）"]
PROCESSES = ["切削", "研削", "熱処理", "メッキ", "組立", "検査", "梱包"]
STATES = ["仕掛中", "検査待ち", "保留", "完了", "出荷待ち"]
PEOPLE = ["山田", "佐藤", "鈴木", "高橋", "田中", "伊藤"]


def build(path, n=3000, seed=7):
    r = random.Random(seed)
    today = date(2026, 11, 5)
    con = sqlite3.connect(path)
    con.execute("DROP TABLE IF EXISTS 仕掛")
    con.execute("DROP TABLE IF EXISTS 品質情報")
    con.execute("CREATE TABLE 仕掛 (ロット番号 TEXT, 品名 TEXT, 品番 TEXT, 顧客 TEXT, 工程 TEXT, 数量 INTEGER, 単位 TEXT, 製造日 TEXT, 納期 TEXT, 状態 TEXT, 担当者 TEXT, 検査結果 TEXT, 備考 TEXT)")
    con.execute("CREATE TABLE 品質情報 (ロット番号 TEXT, 項目 TEXT, 値 TEXT)")
    rows = []
    for i in range(1, n + 1):
        name, code = r.choice(PRODUCTS)
        made = today - timedelta(days=r.randrange(0, 400))
        lot = f"L{made.year % 100}{i:05d}"
        fmt = r.choice(["%Y/%m/%d", "%Y/%m/%d", "%Y-%m-%d", "%y/%m/%d"])         # 日付の書き方が混ざる
        due = made + timedelta(days=r.randrange(14, 45))
        blank = lambda v: "" if r.random() < 0.08 else v                          # 空欄がある
        rows.append((lot, name, code, r.choice(CUSTOMERS), r.choice(PROCESSES), 50 * r.randrange(1, 41), "個",
                     made.strftime(fmt), due.strftime(fmt), r.choice(STATES), blank(r.choice(PEOPLE)),
                     blank(r.choice(["合格", "合格", "合格", "条件付合格", "不合格"])), r.choice(["", "", "", "特急", "再検査あり", "100%検査", "A_1 ロット"])))
        if r.random() < 0.15:                                                        # 一部のロットは複数行
            rows.append(rows[-1][:4] + (r.choice(PROCESSES),) + rows[-1][5:])
    con.executemany("INSERT INTO 仕掛 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.executemany("INSERT INTO 品質情報 VALUES (?,?,?)", [(x[0], "外観", "良") for x in rows[:50]])
    con.commit()
    con.close()
    return len(rows)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "sample_quality.sqlite3"
    print(f"{out}: {build(out, int(sys.argv[2]) if len(sys.argv) > 2 else 3000)} 行")
