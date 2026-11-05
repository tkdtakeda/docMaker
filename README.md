# docMaker

SQLite（品質データ）のロットを検索・選択し、帳票形式を選んで、必要事項を転記した帳票を印刷するツール。

> 現在：画面・版管理・**DB の読み込み**まで完了。帳票の実際の転記/出力は、参考ファイルを受け取ってから組み込む（帳票は仮の 3 種）。

## 開き方
- **ふだん**：`Start.bat`（= `python run.py`。Flask が必要）→ Edge で `http://127.0.0.1:57830/`。
- **画面だけ確かめる**：`web/index.html` を Edge でダブルクリック（サーバー不要。版の札など、サーバーが要る機能だけ出ない）。

最初の画面で「サンプル（標準）を読み込む」を押すと、すぐに動作を確かめられる。

## 作業の流れ（主操作は右上の青いボタン 1 つ。状態でラベルだけが変わる）
1. **① ロットを選ぶ**：検索欄（全項目対象）／左の「条件」で絞り込み → 行をクリック（Ctrl＝足す、Shift＝範囲）
2. **② 帳票を選ぶ**：選択すると下に帳票が出る。「OK／不足 n」が文字で出る
3. **③ n 件を確認して印刷**：1 ロット 1 枚で転記結果を確認。不足は赤＋「未入力」で示す

## 構成
```
run.py / Start.bat    起動
app/                  サーバー（Flask）：version.py（版・更新履歴）/ routes/
app/services/         presence（利用状況）/ sqlite_ro・db_mirror・lot_list（品質データの読み取り。WaveLog と同じ作法）
app_build.py          指紋と配る物の要約（版の上げ忘れ検知）
config/settings.json  ポート・利用状況の置き場
tests/                版管理・ロット一覧のテスト
tools/make_sample_db.py  動作確認用の SQLite を作る（python tools/make_sample_db.py 出力先 [行数]）
web/index.html        採用レイアウト（案C）
web/css/              tokens（値はここだけ）/ base / parts / sheet（帳票・印刷）/ layout-c
web/js/core.js            名前空間・EventBus・状態・主操作の判定
web/js/sample-data.js     サンプル 4 パターン（種固定）。読み込み／サンプルだけ消す
web/js/forms.js           帳票の登録簿（仮の 3 種）。項目 → DB の列の対応と必須指定
web/js/query.js           検索・フィルター・並べ替え（演算子は登録簿）
web/js/grid.js            表（列幅の自動調整・見出し固定・複数選択・キーボード）
web/js/filter-panel.js    検索ボックス・条件パネル・適用中の札
web/js/panels.js          データ／表示／帳票選択／主操作／手順表示
web/js/preview.js         ③ 確認画面と印刷
web/js/data-source.js   DB（サーバー）から 1 ページずつ引く／再読込
web/js/rail.js            アイコン列・パネル開閉・起動処理
web/js/help.js            取扱説明書
web/layouts/          採用しなかった 4 案（評価の記録）
docs/layout-evaluation.md   5 案の評価・採用理由・残件
tools/                確認スクリプト（check.js＝画面、check_server.js＝サーバー版）
web/vendor/fontawesome/ アイコン（ローカル同梱）
```

## 帳票を足すには
`web/js/forms.js` に `DM.forms.register({...})` を 1 つ足す（項目、対応する DB の列、必須かどうか）。画面側の変更は不要。

## 版を上げて配る手順
1. プログラムを直す
2. `app/version.py` の `APP_VERSION` を上げ、`CHANGELOG` の先頭に 1 件足す（直した・足した＝小、画面や使い方が変わる＝中、作り直し＝大）
3. `python app_build.py --release`（まだ配っていない版を直しただけなら `--amend`）
4. `python -m unittest discover -s tests`（版を上げずにプログラムを変えていると、ここで失敗して直し方を言う）

「最新版」は、使っている人たちの版のうちいちばん新しいもの。古い版の人には、見出しの版の札の横に「新しい版あり」が出る（止めはしない）。
利用状況は、`config/settings.json` の `presence.dir` に共有フォルダを入れると、ほかの PC の版も見える（空ならこの PC の中だけ）。

## 確認
```bash
python -m unittest discover -s tests      # 版管理（Flask が入った python で）
node tools/check.js                       # 画面（file:// で開いて確認。主要な作業経路・検索・フィルター・不足の検出・印刷のページ数・サンプルだけ消す・5,000 行・密度）
PYTHON=python node tools/check_server.js  # サーバー版（版の札・利用状況・古いサーバー・DB の読み込み）
```

## DB を使うには
Start.bat で開き、左の「データ」に SQLite のファイルの場所を入れて Enter。設定は `data/user_settings.json` に保存される（配る物の要約に影響しない）。
動作確認だけなら `python tools/make_sample_db.py sample.sqlite3` で作ったファイルを指定する。
間隔・古いとみなす時間・1 ページの件数は `config/settings.json` の `lot_list`。

## 次にやること
帳票の転記・出力（参考ファイル待ち）。残件は `docs/layout-evaluation.md`。
