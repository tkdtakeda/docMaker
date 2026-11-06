# 帳票部品（CDB から取り込み）

`web/report/` は、[tkdtakeda/CDB](https://github.com/tkdtakeda/CDB) の帳票部品を取り込んだものです。
CDB 側で直したときに取り込み直しやすいよう、CDB のコードは**なるべくそのまま**にし、docMaker との違いは `js/adapter.js`（つなぎ役）に寄せています。

- 取り込み元：CDB `main` の `bc05959`（2026-11-06）
- 画面：`web/report.html`（docMaker の画面の上に iframe で開く。CSS・JS を docMaker と分けるため）
- 外部ライブラリ：ExcelJS 4.4.0（`web/vendor/exceljs`。ネットに出られなくても動くよう同梱）

## 取り込んだもの

| CDB | ここ |
|---|---|
| `js/report/` のうち `rules.js` 以外（式・項目・セル型・ページ送り・ブロック・ひな形の読み書き・描画・自由に置く物） | `js/report/` |
| `js/ui/report.js` `report-items.js` `block-*.js` `sheet-paper.js` `common.js` `jobs.js` `density.js` | `js/ui/` |
| `js/core/util.js` `undo.js`、`js/domain/jobs.js` | `js/core/` |
| `css/tokens.css` `layout.css` `components.css` `report.css` `sheet.css` `block.css` | `css/` |

## 取り込まなかったもの（依頼により）

- **検査番号・板番号の特別対応**：板番号を検査番号ごとに分けた連続まとめ（`RANGESBY`、`{…|まとめ}`・`|間`・`|行`、バーの「連続まとめ」、脇の「板番号をまとめて出す」、検査番号の列の自動探索）
  - 汎用の `RANGES`（連続部まとめ）・`{…|連続}`・「列の値ごとに 1 行」は残している
- **作成済の記録・使い切り・ステータス・NG を載せない**（`rules.js`・`issued`・出力ルールの欄）
- CDB の「フォルダ」（システム項目・出力の条件の表示）
- 取り込み・紐付け・判定など、帳票以外の CDB の機能

## CDB のコードに入れた変更（取り込み直すときに当て直す）

`docMaker：` のコメントを付けてある。

| ファイル | 変更 |
|---|---|
| `js/ui/report.js` | ルールの当てはめを外す・出力ルールの欄を出さない・作成済の記録を何もしない形に・フォルダの表示を外す・`ctx.mode` で出力イメージから開ける・「紐付けデータ」の表記 |
| `js/ui/block-bar.js` | 「連続まとめ」（特別な機能）のボタンを外す |
| `js/ui/block-side.js` | 「板番号をまとめて出す」と、まとめの特別なヒントを外す・列の一覧の表記 |
| `js/report/formula.js` | `RANGESBY` を外す |
| `js/report/block-compile.js` | `|まとめ`・`|間`・`|行` を外す（書けば「読めない書式」と知らせる） |
| `js/report/block-doc.js` | 新しい帳票の骨組みの見出しを汎用に（ロット番号・品名・品番・数量・納入先／明細の表） |
| `js/report/items.js` | システム項目「フォルダ」を外す・表記 |
| `js/ui/report-items.js` | 表記 |

## docMaker のデータの渡し方

`web/js/report-bridge.js` が、CDB の帳票部品が読む形にして渡す。

- 1 枚＝同じロット番号の行のまとまり（選んだ行のロットの**全行**。DB はサーバーから取り直す）
- 列はすべて「板の側（`p:列名`）」にする。表の外のセルは、そのロットの行で値が 1 つならその値（違う値があれば空欄。CDB と同じ）、板の表はロットの行ごとに繰り返す
- 帳票（プリセット）とひな形は、サーバーの共有フォルダ（`config/settings.json` の `reports.dir`。空なら `data/reports`）に 1 帳票 1 ファイルで保存する
