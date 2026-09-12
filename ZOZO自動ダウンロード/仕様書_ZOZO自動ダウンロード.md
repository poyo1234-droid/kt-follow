# ZOZO BACK OFFICE goods_cs 自動ダウンロード 仕様書

ZOZO BACK OFFICE から展開単位CSV（`goods_cs.csv`・約970MB・約40万行）を
毎朝自動で取得する。今回の範囲は**ダウンロードまで**。kintone の削除・取込には繋げない。

- リポジトリ: `260907-フォローデータ`（origin: `poyo1234-droid/kt-follow`）
- 実行環境: 会社PC 1台（ログオン済み・電源ON）。Python 3.13.9 / Playwright 1.62.0 / Chromium 151
- 着手: 2026-09-13

---

## 1. 調べて分かったこと（実測・2026-09-13）

### 1.1 ログインは二段構え

| 段 | 方式 | 内容 |
|---|---|---|
| 1段目 | **HTTP Basic認証** | `https://to.zozo.jp/to/` が `WWW-Authenticate: Basic realm="to.zozo.jp"` を返す。Playwright の `http_credentials` で通す |
| 2段目 | ログインフォーム | `form action=/to/Default.asp` method=POST |

2段目のフォーム構成:

```
hidden  c = "Login"
hidden  csrf_token = "bo_sec_tkn_..."   毎回変わる（フォームから読んで送る必要がある）
hidden  TerminalID = ""                  空のまま送って通る
input   name='LoginName'  id='UserID'
input   name='Password'   (idなし)
button  type='submit'  text='ログイン'
```

セレクタは `#UserID` / `input[name='Password']` / `button[type='submit']`。

### 1.2 商品検索

メニューはドロップダウンで隠れていてクリックできないため、**URLを直接開く**。

| 画面 | URL |
|---|---|
| 商品検索 | `https://to.zozo.jp/to/GoodsSearch.asp?c=Init` |

検索実行は `form1` の `button[name='search'][value='SEARCH']`（hidden `c=Search`）。

**検索条件は既定のまま触らない。** 検索は1〜2秒で終わる。

| 項目 | 既定値 | 備考 |
|---|---|---|
| `Top`（対象） | `1` = 50件 | **CSVの中身には影響しない（実測で確認済み）**。画面表示の件数だけ |
| `SearchDb` | `1` = アクティブ商品 | もう一方は `2` = アーカイブ商品 |
| `StockType` / `SellType` / `ShowWebFlag` / `CustomerTypeID` / `ExternalStockType` | すべて「指定なし」 | |
| `OrderBy` | `1` = 販売順 | |

> `Top=0`（指定なし・全件）にしても結果は同じ。ラジオは装飾で隠れているため
> `check()` すると待ち続ける。設定する場合は JS で `e.checked = true` を入れる。

### 1.3 CSVのダウンロード

検索結果画面に3つのCSVリンクが現れる。

| リンク | URL |
|---|---|
| 商品単位CSV | `GoodsSearch.asp?c=ListDownLoadGoods` |
| **展開単位CSV** | **`GoodsSearch.asp?c=ListDownLoadCS`** ← goods_cs はこれ |
| 一括委託返却用CSV | `GoodsSearch.asp?c=TenantDeliveryCSV` |

応答ヘッダ:

```
HTTP 200
Content-Type: Application/vnd.ms-excel-csv
Content-Disposition: attachment; filename=goods_cs.csv
（Content-Length は返らない。生成しながら流している）
```

`Content-Length` が無いので**進捗率は出せない**。受信済みバイト数のみ表示できる。

### 1.4 実測値（2026-09-13 07:14〜07:31）

| 項目 | 値 |
|---|---|
| サイズ | **1,017,407,147 バイト（970.3 MB）** |
| 文字コード | **CP932（Shift-JIS）** |
| 列数 | **28列** |
| 行数 | **399,786行**（改行基準） |
| 所要時間 | **約15分**（受信 892〜898秒。約1.1 MB/s） |

**手動でChromeから落としたファイルと、サイズ・先頭20MB・末尾20MBのハッシュがすべて一致**。
自動取得の中身が手動と同じであることを実データで確認済み。

### 1.5 ヘッダ28列

```
 1 モール                     15 販売価格（税抜）
 2 ショップ                   16 価格タイプ
 3 親カテゴリ                 17 プロパー価格（税抜）
 4 子カテゴリ                 18 販売開始前価格（税抜）
 5 親商品タイプ               19 Web表示
 6 子商品タイプ               20 販売開始日
 7 性別                       21 素材表記
 8 ブランド品番               22 原産国
 9 商品コード                 23 販売タイプ
10 CS別品番                   24 商品コメント
11 商品名                     25 おすすめ設定
12 カラー                     26 バーコード
13 サイズ                     27 商品展開ID（GoodsDetailID）
14 登録日                     28 副性別
```

> **列名は変わることがある。** 既存の `_スクリプト/extract_unregistered_from_goods_cs.py`
> （kt リポジトリ）に「スナップショットにより列名が変わる（「商品タイプ(子)」⇔「子商品タイプ」、
> 「カテゴリ(親)」⇔「親カテゴリ」）」との記録がある。検査を列名の完全一致にすると
> 正常時に止まる恐れがあるため、**列数を主、列名を警告**とする方針（§3参照）。

### 1.6 つまずいた点と対処

| 事象 | 原因 | 対処 |
|---|---|---|
| `401 権限がありません` | `settings.txt` の値をクォートで囲っていた | クォートは書かない（`=` の右側がそのまま値） |
| 「推奨ブラウザはGoogle Chromeです」のalert | ヘッドレスのUAが `HeadlessChrome` | `user_agent` に Chrome を指定。ダイアログは `page.on("dialog")` で自動的に閉じる |
| ラジオの `check()` が終わらない | 装飾で要素が隠れている | JSで `e.checked = true` を入れる |
| ブラウザ経由DLが切れたように見えた | 実際は完了していた（15分かかる） | 待ち時間を十分に取る |

---

## 2. 採用する方式

**ログインと検索は Playwright、ファイル受信は Python で直接ストリーミング。**

```
Playwright (Chromium, headless, UA=Chrome)
  ├─ Basic認証つきで https://to.zozo.jp/to/ を開く
  ├─ #UserID / Password を埋めてログイン
  ├─ GoodsSearch.asp?c=Init を開く
  ├─ 検索ボタンを押す（条件は既定のまま）
  └─ context.cookies() を取り出してブラウザを閉じる
        ↓
Python urllib
  └─ Cookie + Basic認証ヘッダを付けて
     GoodsSearch.asp?c=ListDownLoadCS を GET し、1MBずつ書き出す
```

ブラウザのダウンロード機構を使う方式（`probe_download.py`）でも成功はするが、
一時ファイルからNASへ1GBをコピーし直すぶん18.7秒余計にかかり、進捗も見えない。

---

## 3. ダウンロード成否の判定（未確定・要決定）

ZOZO画面に件数表示が無いため自前で検査する。**検査を通過してから旧ファイルを OLD へ移す。**
通過しなければ旧ファイルはそのまま残す。

1. **ヘッダ検査** — 列数28と一致するか。列名は §1.5 と比較し、違えば**警告**（中断はしない）
2. **途中切れ検査** — 最終行の列数が揃っているか
3. **前回比較** — 行数・サイズが前回比 ±数% 以内か

### 未確定事項

- 「±数%」の具体的な閾値
- 行数の数え方（改行基準か、CSVとして解釈したレコード数か）。`商品コメント` 列に
  改行が入りうるため両者はズレる。改行基準なら7秒で済む
- 検査に落ちたときの通知方法（メール／ログのみ／その他）

---

## 4. ファイル構成

| ファイル | 役割 |
|---|---|
| `zozo_download.py` | 本番。**未着手** |
| `settings.txt` | 企業ID/PW・個人ID/PW・保存先。**.gitignore 済み** |
| `settings.txt.sample` | 記入例。これをコピーして `settings.txt` を作る |
| `log/` | 実行ログ。**.gitignore 済み** |
| `probe_login.py` | 調査用。ログイン画面の構造を出す |
| `probe_after_login.py` | 調査用。ログイン後のメニューを出す |
| `probe_search.py` | 調査用。商品検索画面の入力欄を出す |
| `probe_result.py` | 調査用。検索結果画面のボタン・リンクを出す |
| `probe_download.py` | 検証用（方式1・ブラウザ経由）。採用しない |
| `probe_download2.py` | 検証用（方式2・直接受信）。本番はこの方式 |

`settings.txt` は `削除ツール/kintone_delete.py`（kt リポジトリ）と同じ `key=value` 形式。
**値をクォートで囲まないこと。**

---

## 5. 残っている作業

1. `zozo_download.py` を書く（§2の方式＋§3の検査＋OLDへの退避）
2. §3の未確定事項を決める
3. タスクスケジューラに登録（毎朝8時）

---

## 6. 注意

- **多要素認証（MFA）の導入予定がある。** BACK OFFICE のお知らせに
  「【管理画面】多要素認証（MFA）導入のご案内」（2026-09-02付）がある。
  必須化されるとこの自動化は作り直しになる。内容の確認が必要
- パスワード変更モーダルは DOM にあるが現在は非表示。有効期限で強制変更が
  掛かると自動化は止まる
- ID/PW をコードやログに書かない。調査スクリプトは `type=password` の値を
  出力せず、文字数だけを表示する
- 1回の実行で約1GBを受信する。ディスク残量に注意
