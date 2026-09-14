# -*- coding: utf-8 -*-
"""
ZOZO BACK OFFICE 展開単位CSV（goods_cs.csv）自動ダウンロード

毎朝タスクスケジューラから実行する。約970MB・約40万行を、登録日で7つに分けて
順に受信し、結合してから検査する。検査に通ったときだけ旧ファイルを OLD へ
退避して入れ替える。

  python zozo_download.py              通常の実行
  python zozo_download.py --show       ブラウザを表示して実行（動作確認用）
  python zozo_download.py --dry-run    受信だけして入れ替えない（検査結果は出す）

設定は settings.txt（このファイルと同じフォルダ）。値をクォートで囲まないこと。

--------------------------------------------------------------------------
なぜ分割するのか（2026-09-14）
--------------------------------------------------------------------------
1本で落とすと ZOZO 側の ASP が約30分で自らタイムアウトし（ASP 0113）、
途中までのデータにエラーページを足して正常終了してしまう。970MB を30分で
落とすには 0.54MB/s 以上が必要だが、実測は 0.45〜1.1MB/s とぶれる。
登録日で7分割すれば1本あたり150MB以下・5分程度になり、速度が半減しても収まる。
詳細は 仕様書_ZOZO自動ダウンロード.md の §1.7〜§2。

--------------------------------------------------------------------------
処理の流れ
--------------------------------------------------------------------------
 1. Playwright で Basic認証（1段目）とログインフォーム（2段目）を通す（1回だけ）
 2. チャンクごとに、商品検索を開いて登録日の範囲を入れて検索する
 3. そのときのCookieで CSV を直接ストリーミング受信し、.partNN に書く
 4. チャンクを検査する
      - 末尾に ASP 0113（ZOZO側のタイムアウト）が混ざっていないか
      - 改行で終わっているか / ヘッダ28列か / 0件でないか
      - 登録日が指定した範囲に収まっているか
    通らなければそのチャンクだけ再取得（最大2回・30秒あけて）
 5. 全チャンクが揃ったら、ヘッダ1つ・CP932のままバイト連結して .part を作る
 6. 結合後に前回ファイルと行数・サイズを比べる（-10%で中断）
 7. 通ったら、旧ファイルを OLD へ移し、.part を正式名にする
    通らなかったら .part を失敗の名前で残し、旧ファイルはそのままにする

**1本でも欠けたら結合も入れ替えもしない。**
通知はログのみ（log/zozo_download_YYYYMMDD.log に追記）。
"""
import argparse
import io
import os
import shutil
import sys
import time
import base64
import urllib.request
import urllib.error
import csv
from datetime import datetime, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(SCRIPT_DIR, "log")

TOP_URL = "https://to.zozo.jp/to/"
SEARCH_URL = "https://to.zozo.jp/to/GoodsSearch.asp?c=Init"
CSV_URL = "https://to.zozo.jp/to/GoodsSearch.asp?c=ListDownLoadCS"

# ヘッドレスだと「推奨ブラウザはGoogle Chromeです」と言われるので Chrome を名乗る
CHROME_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")

# 2026-09-13 時点のヘッダ。列名は変わることがあるので、一致しなくても警告にとどめる
EXPECTED_COLUMNS = [
    "モール", "ショップ", "親カテゴリ", "子カテゴリ", "親商品タイプ", "子商品タイプ",
    "性別", "ブランド品番", "商品コード", "CS別品番", "商品名", "カラー", "サイズ",
    "登録日", "販売価格（税抜）", "価格タイプ", "プロパー価格（税抜）",
    "販売開始前価格（税抜）", "Web表示", "販売開始日", "素材表記", "原産国",
    "販売タイプ", "商品コメント", "おすすめ設定", "バーコード",
    "商品展開ID（GoodsDetailID）", "副性別",
]
EXPECTED_COLUMN_COUNT = 28

TOLERANCE = 0.10          # 前回比較の許容幅（±10%）
ENCODING = "cp932"        # ZOZOのCSVは Shift-JIS
CHUNK = 1024 * 1024       # 1MBずつ受信する
HTTP_TIMEOUT = 180        # 無通信がこの秒数続いたら諦める

# --- 分割（2026-09-14 追加）---
FIRST_START = "2000/01/01"   # 先頭チャンクの始端。最古の登録日(2017/09)より前なら何でもよい
RETRY_MAX = 2                # チャンク1本あたりの再取得回数
RETRY_WAIT = 30              # 再取得までに待つ秒数
CHUNK_WARN_MB = 120          # 最終チャンクがこれを超えたら境界追加を促す
CHUNK_WARN_ROWS = 80000      # 同上（件数）
csv.field_size_limit(10 ** 9)   # 商品コメントが巨大なため


# ----------------------------------------------------------------- ログ

class Logger(object):
    def __init__(self):
        os.makedirs(LOG_DIR, exist_ok=True)
        self.path = os.path.join(
            LOG_DIR, "zozo_download_%s.log" % datetime.now().strftime("%Y%m%d"))
        self.f = io.open(self.path, "a", encoding="utf-8")
        self.errors = []

    def __call__(self, msg):
        line = "[%s] %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
        print(line, flush=True)
        self.f.write(line + "\n")
        self.f.flush()

    def error(self, msg):
        self("【エラー】" + msg)
        self.errors.append(msg)

    def close(self):
        self.f.close()


# ----------------------------------------------------------------- 設定

def load_settings():
    """settings.txt を読む。削除ツール/kintone_delete.py と同じ形式。"""
    s = {}
    path = os.path.join(SCRIPT_DIR, "settings.txt")
    if not os.path.exists(path):
        sys.exit("settings.txt がありません。settings.txt.sample をコピーして"
                 "作ってください。\n  " + path)
    with io.open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            s[k.strip()] = v.strip()

    required = ("company_id", "company_password", "user_id", "user_password",
                "download_dir", "file_name", "old_dir")
    missing = [k for k in required if not s.get(k)]
    if missing:
        sys.exit("settings.txt の項目が空です: %s" % ", ".join(missing))

    # クォートで囲むと値の一部になってしまうので、よくある間違いとして弾く
    for k in required:
        v = s[k]
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
            sys.exit("settings.txt の %s がクォートで囲まれています。"
                     "クォートは不要です（囲むと認証に失敗します）。" % k)
    return s


# ----------------------------------------------------------------- 取得

def build_ranges(s, log):
    """settings.txt の chunk_boundaries から (開始日, 終了日) の並びを作る。

    chunk_boundaries には各チャンクの「終了日」をカンマ区切りで書く。
    最終チャンクの終了日は実行日を使うので書かない（境界6つ → 7チャンク）。
    """
    raw = s.get("chunk_boundaries", "").strip()
    if not raw:
        raise RuntimeError(
            "settings.txt に chunk_boundaries がありません。"
            "settings.txt.sample を参照してください。")
    bounds = [x.strip() for x in raw.split(",") if x.strip()]
    try:
        ds = [datetime.strptime(b, "%Y/%m/%d") for b in bounds]
    except ValueError as e:
        raise RuntimeError("chunk_boundaries の日付は YYYY/MM/DD で書いてください: %s" % e)
    for a, b in zip(ds, ds[1:]):
        if b <= a:
            raise RuntimeError("chunk_boundaries が昇順になっていません: %s" % raw)

    today = datetime.now()
    if ds and ds[-1].date() >= today.date():
        raise RuntimeError(
            "chunk_boundaries の最後（%s）が今日以降です。"
            "最終チャンクの終了日は書かないでください。" % bounds[-1])

    ranges = []
    start = FIRST_START
    for d in ds:
        ranges.append((start, d.strftime("%Y/%m/%d")))
        start = (d + timedelta(days=1)).strftime("%Y/%m/%d")
    ranges.append((start, today.strftime("%Y/%m/%d")))

    log("チャンクは %d本です（最終チャンクの終端は実行日）" % len(ranges))
    for i, (a, b) in enumerate(ranges, 1):
        log("  %d: 登録日 %s 〜 %s" % (i, a, b))
    return ranges


class Session(object):
    """ログインしたブラウザを保持し、チャンクごとに検索し直す。

    CSVのURL（c=ListDownLoadCS）はパラメータを持たず、条件はサーバー側の
    セッションに保持される。そのため「検索フォームを送信 → 同じURLをGET」の
    順でしか絞れず、並列取得もできない（条件が1つしかないため）。
    """

    def __init__(self, s, log, show=False):
        self.s = s
        self.log = log
        self.show = show
        self._pw = None
        self._browser = None
        self.ctx = None
        self.pg = None

    def open(self):
        from playwright.sync_api import sync_playwright
        s, log = self.s, self.log
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=not self.show)
        self.ctx = self._browser.new_context(
            http_credentials={"username": s["company_id"],
                              "password": s["company_password"]},
            user_agent=CHROME_UA,
        )
        pg = self.ctx.new_page()
        pg.set_default_timeout(120000)
        pg.on("dialog", lambda d: (log("  画面のダイアログ: %s" % d.message),
                                   d.accept()))

        resp = pg.goto(TOP_URL, wait_until="domcontentloaded", timeout=60000)
        if resp is not None and resp.status == 401:
            raise RuntimeError(
                "1段目(Basic認証)が通りませんでした。"
                "settings.txt の company_id / company_password を確認してください。")
        log("1段目(Basic認証)を通過しました")

        pg.wait_for_selector("#UserID", timeout=30000)
        pg.fill("#UserID", s["user_id"])
        pg.fill("input[name='Password']", s["user_password"])
        with pg.expect_navigation(wait_until="domcontentloaded", timeout=60000):
            pg.click("button[type='submit']")
        pg.wait_for_timeout(2000)
        if pg.query_selector("#UserID") is not None:
            raise RuntimeError(
                "2段目のログインに失敗しました。"
                "settings.txt の user_id / user_password を確認してください。")
        log("2段目(ログイン)を通過しました")

        # パスワードの強制変更が掛かると自動化は止まる。気づけるように見ておく
        el = pg.query_selector("input[placeholder='旧パスワード']")
        if el is not None and el.is_visible():
            raise RuntimeError(
                "パスワード変更の画面が表示されています。"
                "手動でパスワードを変更してから、再度実行してください。")
        self.pg = pg

    def search(self, dfrom, dto):
        """登録日の範囲で検索し、そのときのCookieを返す。"""
        pg, log = self.pg, self.log
        pg.goto(SEARCH_URL, wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_selector("button[name='search']", timeout=30000)

        # ラジオ・チェックはCSSで隠れているので JS で触る。
        # 日付は fill のあと Escape を押すとピッカーが値を戻してしまうため、
        # JS で値を入れて change を発火させる（2026-09-14 実測）。
        pg.eval_on_selector("input[name='SEARCH_RegistDT']", "e => { e.checked = true; }")
        setter = ("(e, v) => { e.value = v;"
                  " e.dispatchEvent(new Event('input', {bubbles:true}));"
                  " e.dispatchEvent(new Event('change', {bubbles:true})); }")
        want = (("RegistDTFrom", dfrom), ("RegistDTTo", dto))
        for name, v in want:
            pg.eval_on_selector("input[name='%s']" % name, setter, v)

        # 送信直前に読み戻して照合する。空のまま検索すると0件になる
        for name, v in want:
            el = pg.query_selector("input[name='%s']" % name)
            got = el.input_value() if el is not None else None
            if got != v:
                raise RuntimeError("検索条件 %s が %r になっていません（実値 %r）。"
                                   % (name, v, got))
        chk = pg.query_selector("input[name='SEARCH_RegistDT']")
        if chk is None or not chk.is_checked():
            raise RuntimeError("登録日での絞り込みが有効になっていません。")

        t0 = time.time()
        with pg.expect_navigation(wait_until="domcontentloaded", timeout=600000):
            pg.click("button[name='search']")
        log("  検索完了まで %.1f秒" % (time.time() - t0))

        if pg.query_selector("a[href*='c=ListDownLoadCS']") is None:
            raise RuntimeError("検索結果に「展開単位CSV」が見つかりませんでした。"
                               "該当0件か、画面の作りが変わった可能性があります。")

        cookies = self.ctx.cookies()
        return "; ".join("%s=%s" % (c["name"], c["value"]) for c in cookies)

    def close(self):
        try:
            if self._browser is not None:
                self._browser.close()
        finally:
            if self._pw is not None:
                self._pw.stop()


def download(cookie_header, s, out_path, log):
    """CSVを直接ストリーミング受信してファイルに書く。受信バイト数を返す。"""
    req = urllib.request.Request(CSV_URL)
    req.add_header("Cookie", cookie_header)
    req.add_header("User-Agent", CHROME_UA)
    token = base64.b64encode(
        ("%s:%s" % (s["company_id"], s["company_password"])).encode("utf-8")
    ).decode("ascii")
    req.add_header("Authorization", "Basic " + token)

    t0 = time.time()
    got = 0
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        ctype = r.headers.get("Content-Type", "")
        log("  HTTP %s / Content-Type: %s" % (r.status, ctype))
        if "csv" not in ctype.lower() and "excel" not in ctype.lower():
            raise RuntimeError("CSVではない応答が返りました（Content-Type: %s）。"
                               "セッションが切れた可能性があります。" % ctype)
        last = time.time()
        with io.open(out_path, "wb") as f:
            while True:
                chunk = r.read(CHUNK)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if time.time() - last >= 30:
                    log("  受信中 %.1f MB（%.1f MB/s）"
                        % (got / 1048576.0,
                           got / (time.time() - t0) / 1048576.0))
                    last = time.time()
    log("  受信完了 %.1f MB（%.1f秒）" % (got / 1048576.0, time.time() - t0))
    return got


# ----------------------------------------------------------------- 検査

def count_lines(path):
    """改行の数を数える。CSVとしては解釈しない（商品コメントの改行は数に入る）。"""
    n = 0
    with io.open(path, "rb") as f:
        while True:
            b = f.read(8 * 1024 * 1024)
            if not b:
                break
            n += b.count(b"\n")
    return n


def read_last_line(path, enc=ENCODING):
    """末尾の行を読む（途中で切れていないかを見るため）。"""
    with io.open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        back = min(64 * 1024, size)
        f.seek(size - back)
        tail = f.read(back)
    lines = [ln for ln in tail.split(b"\n") if ln.strip()]
    if not lines:
        return ""
    return lines[-1].decode(enc, "replace").rstrip("\r")


def scan_chunk(path):
    """チャンクを1回読んで、データ行数と登録日の最小・最大を返す。"""
    rows = 0
    dmin = None
    dmax = None
    with io.open(path, encoding=ENCODING, errors="replace", newline="") as f:
        r = csv.reader(f)
        try:
            hdr = next(r)
        except StopIteration:
            return 0, None, None
        try:
            ir = hdr.index("登録日")
        except ValueError:
            ir = None
        for row in r:
            if len(row) < EXPECTED_COLUMN_COUNT:
                continue
            rows += 1
            if ir is None:
                continue
            d = row[ir][:10]
            if not d:
                continue
            if dmin is None or d < dmin:
                dmin = d
            if dmax is None or d > dmax:
                dmax = d
    return rows, dmin, dmax


def inspect_chunk(path, dfrom, dto, is_last, log):
    """チャンク1本の検査。(通ったか, 再取得で直りそうか) を返す。"""
    size = os.path.getsize(path)
    log("  検査します（%.1f MB）" % (size / 1048576.0))

    if size == 0:
        log.error("チャンクが空です。")
        return False, True

    with io.open(path, "rb") as f:
        f.seek(max(0, size - 4096))
        tail = f.read()

    # C1: ZOZO側のスクリプトタイムアウト。行数を数える前にここで捕まえる
    if b"ASP 0113" in tail or b"Active Server Pages" in tail:
        log.error("末尾に ZOZO のエラーページ（ASP 0113・スクリプトタイムアウト）が"
                  "混ざっています。このチャンクが大きすぎる可能性があります。"
                  "settings.txt の chunk_boundaries で分割を細かくしてください。")
        return False, True

    # C2: 途中切れ
    if not tail.endswith(b"\n"):
        log.error("チャンクが改行で終わっていません（末尾: %r）。"
                  "受信が途中で切れた可能性があります。" % tail[-20:])
        return False, True

    # C3: ヘッダ。ZOZO側の仕様変更なので再取得しても直らない
    try:
        with io.open(path, encoding=ENCODING, newline="") as f:
            header = f.readline().rstrip("\r\n")
    except UnicodeDecodeError as e:
        log.error("%s として読めませんでした: %s" % (ENCODING, e))
        return False, True
    cols = header.split(",")
    if len(cols) != EXPECTED_COLUMN_COUNT:
        log.error("ヘッダの列数が %d ではなく %d です。"
                  "ZOZO側の仕様変更の可能性があります。"
                  % (EXPECTED_COLUMN_COUNT, len(cols)))
        return False, False

    # C4/C5: 中身
    rows, dmin, dmax = scan_chunk(path)
    log("    %s行 / 登録日 %s 〜 %s" % ("{:,}".format(rows), dmin, dmax))

    if rows == 0:
        log.error("チャンクが0件です。検索条件が正しく入っていない可能性があります。")
        return False, True

    if dmin is not None and (dmin < dfrom or dmax > dto):
        log.error("登録日が指定範囲（%s 〜 %s）の外にあります（実際は %s 〜 %s）。"
                  "検索条件が効いていない可能性があります。"
                  % (dfrom, dto, dmin, dmax))
        return False, False

    # 最終チャンクは毎日伸びる。上限に当たる前に知らせる
    if is_last and (size > CHUNK_WARN_MB * 1048576 or rows > CHUNK_WARN_ROWS):
        log("  ※ 最終チャンクが %.0f MB / %s行 になりました。"
            "settings.txt の chunk_boundaries に境界を1つ足してください"
            % (size / 1048576.0, "{:,}".format(rows)))

    return True, True


def fetch_chunk(sess, s, idx, total, dfrom, dto, path, log):
    """チャンク1本を取得する。駄目なら再取得する。"""
    mark = len(log.errors)
    for attempt in range(1, RETRY_MAX + 2):
        if attempt > 1:
            log("  %d秒あけて再取得します（%d回目）" % (RETRY_WAIT, attempt))
            time.sleep(RETRY_WAIT)
        log("チャンク %d/%d  登録日 %s 〜 %s" % (idx, total, dfrom, dto))
        cookie_header = sess.search(dfrom, dto)
        download(cookie_header, s, path, log)
        ok, retryable = inspect_chunk(path, dfrom, dto, idx == total, log)
        if ok:
            del log.errors[mark:]     # 再取得で直ったぶんは最終報告に出さない
            return
        if not retryable:
            raise RuntimeError("チャンク %d は再取得しても直らない問題です。" % idx)
        if os.path.exists(path):
            os.remove(path)
    raise RuntimeError("チャンク %d の取得に %d 回失敗しました。"
                       % (idx, RETRY_MAX + 1))


def merge(parts, out_path, log):
    """ヘッダ1つ・CP932のままバイト連結する。デコードはしない。"""
    t0 = time.time()
    with io.open(out_path, "wb") as out:
        for i, p in enumerate(parts):
            with io.open(p, "rb") as f:
                if i > 0:
                    # 2本目以降はヘッダ行を捨てる。ヘッダは列名だけなので
                    # 最初の改行までを読み飛ばせばよい
                    while True:
                        b = f.read(1)
                        if not b or b == b"\n":
                            break
                while True:
                    buf = f.read(CHUNK)
                    if not buf:
                        break
                    out.write(buf)
    log("  結合しました %.1f MB（%.1f秒）"
        % (os.path.getsize(out_path) / 1048576.0, time.time() - t0))


def inspect(path, prev_path, log):
    """検査する。問題なければ True。中断すべきなら False。"""
    ok = True

    size = os.path.getsize(path)
    log("検査します（%.1f MB）" % (size / 1048576.0))

    if size == 0:
        log.error("ファイルが空です。")
        return False

    # --- 1. ヘッダ ---
    try:
        with io.open(path, encoding=ENCODING, newline="") as f:
            header = f.readline().rstrip("\r\n")
    except UnicodeDecodeError as e:
        log.error("%s として読めませんでした: %s" % (ENCODING, e))
        return False

    cols = header.split(",")
    log("  ヘッダ列数: %d" % len(cols))
    if len(cols) != EXPECTED_COLUMN_COUNT:
        log.error("ヘッダの列数が %d ではなく %d です。ZOZO側の仕様変更の可能性があります。"
                  % (EXPECTED_COLUMN_COUNT, len(cols)))
        ok = False
    elif cols != EXPECTED_COLUMNS:
        # 列名の表記ゆれは前例があるため、止めずに知らせるだけ
        diff = [(i + 1, a, b) for i, (a, b) in enumerate(zip(EXPECTED_COLUMNS, cols))
                if a != b]
        log("  ※ 列名が以前と違います（列数は合っているので続行します）:")
        for i, a, b in diff:
            log("      %2d列目  以前: %s  →  今回: %s" % (i, a, b))
    else:
        log("  ヘッダは以前と同じです")

    # --- 2. 途中切れ ---
    # 列数はカンマを数えるだけでは判定できない。商品コメント列にHTMLが入っており、
    # 引用符の中にカンマも改行も含まれるため。代わりに次の2つを見る。
    #   ・ファイルが改行で終わっているか（途中で切れれば行の途中で止まる）
    #   ・最終行の引用符が閉じているか（ダブルクォートが偶数か）
    with io.open(path, "rb") as f:
        f.seek(-2, 2)
        tail2 = f.read()
    if not tail2.endswith(b"\n"):
        log.error("ファイルが改行で終わっていません（末尾: %r）。"
                  "受信が途中で切れた可能性があります。" % tail2)
        ok = False
    else:
        log("  ファイルは改行で終わっています")

    last = read_last_line(path)
    quotes = last.count('"')
    if quotes % 2 != 0:
        log.error("最終行の引用符が閉じていません（\" が %d 個で奇数）。"
                  "受信が途中で切れた可能性があります。" % quotes)
        ok = False
    else:
        log("  最終行の引用符は閉じています（\" が %d 個）" % quotes)

    # --- 3. 前回との比較 ---
    lines = count_lines(path)
    log("  行数（改行基準）: %s" % "{:,}".format(lines))

    if prev_path and os.path.exists(prev_path):
        prev_size = os.path.getsize(prev_path)
        prev_lines = count_lines(prev_path)
        log("  前回: %.1f MB / %s 行"
            % (prev_size / 1048576.0, "{:,}".format(prev_lines)))
        # 増えるぶんには止めない。ダウンロードが途中で切れたときにファイルが
        # 増えることはあり得ず、商品の大量追加で増えるのは正常な動きのため。
        # 欠損は必ず「減る」方向に出るので、減少だけを中断の対象にする。
        for name, now, before in (("サイズ", size, prev_size),
                                  ("行数", lines, prev_lines)):
            if before == 0:
                continue
            ratio = (now - before) / float(before)
            log("    %s の増減: %+.1f%%" % (name, ratio * 100))
            if ratio < -TOLERANCE:
                log.error("%s が前回比 %+.1f%% で、%.0f%% 以上減っています。"
                          "受信が途中で切れた可能性があります。"
                          % (name, ratio * 100, TOLERANCE * 100))
                ok = False
            elif ratio > TOLERANCE:
                log("    ※ %s が前回比 %+.1f%% と大きく増えています"
                    "（商品の大量追加と思われます。中断はしません）"
                    % (name, ratio * 100))
    else:
        log("  前回ファイルが無いため、比較は行いません（初回とみなします）")

    return ok


# ----------------------------------------------------------------- 入れ替え

def rotate(tmp_path, final_path, old_dir, log):
    """検査を通ったので、旧ファイルをOLDへ移して新ファイルを正式名にする。"""
    if os.path.exists(final_path):
        os.makedirs(old_dir, exist_ok=True)
        stamp = datetime.fromtimestamp(
            os.path.getmtime(final_path)).strftime("%Y%m%d_%H%M%S")
        base, ext = os.path.splitext(os.path.basename(final_path))
        moved = os.path.join(old_dir, "%s_%s%s" % (base, stamp, ext))
        log("旧ファイルを退避します: %s" % moved)
        shutil.move(final_path, moved)
    os.replace(tmp_path, final_path)
    log("保存しました: %s" % final_path)


# ----------------------------------------------------------------- 本体

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", action="store_true", help="ブラウザを表示する")
    ap.add_argument("--dry-run", action="store_true",
                    help="受信と検査だけ行い、ファイルの入れ替えはしない")
    args = ap.parse_args()

    log = Logger()
    log("=" * 60)
    log("ZOZO goods_cs 自動ダウンロードを開始します")

    tmp_path = None
    parts = []
    try:
        s = load_settings()
        out_dir = s["download_dir"]
        old_dir = s["old_dir"]
        final_path = os.path.join(out_dir, s["file_name"])
        if not os.path.isdir(out_dir):
            raise RuntimeError("保存先フォルダがありません: %s" % out_dir)
        log("保存先: %s" % final_path)

        ranges = build_ranges(s, log)

        # 前回の残骸を消す。結合時に一時的に約2GB使うため
        tmp_path = final_path + ".part"
        for n in range(1, len(ranges) + 1):
            stale = "%s.part%02d" % (final_path, n)
            if os.path.exists(stale):
                os.remove(stale)
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

        t0 = time.time()
        sess = Session(s, log, show=args.show)
        sess.open()
        try:
            for idx, (dfrom, dto) in enumerate(ranges, 1):
                path = "%s.part%02d" % (final_path, idx)
                fetch_chunk(sess, s, idx, len(ranges), dfrom, dto, path, log)
                parts.append(path)
        finally:
            sess.close()
        log("全 %d チャンクを受信しました（%.1f分）"
            % (len(parts), (time.time() - t0) / 60.0))

        log("結合します（ヘッダ1つ・CP932のまま連結）")
        merge(parts, tmp_path, log)
        for path in parts:
            os.remove(path)
        parts = []

        ok = inspect(tmp_path, final_path, log)

        if not ok:
            failed = tmp_path + ".失敗_%s" % datetime.now().strftime("%Y%m%d_%H%M%S")
            os.rename(tmp_path, failed)
            tmp_path = None
            log("検査に通らなかったため、入れ替えを中止しました。")
            log("  受信したファイルは %s に残してあります" % failed)
            log("  旧ファイルはそのままです")
            raise RuntimeError("検査に通りませんでした:\n- "
                               + "\n- ".join(log.errors))

        log("検査に通りました")

        if args.dry_run:
            log("--dry-run のため入れ替えません。受信したファイル: %s" % tmp_path)
            tmp_path = None
        else:
            rotate(tmp_path, final_path, old_dir, log)
            tmp_path = None

        log("正常に終了しました")
        return 0

    except Exception as e:
        log.error(str(e))
        log("異常終了しました")
        log("  ログ: %s" % log.path)
        return 1
    finally:
        # 途中で落ちた場合、書きかけのファイルは残さない。
        # ただし失敗したチャンクは原因調査のために残す
        for path in parts:
            if os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
                log("書きかけのファイルを削除しました: %s" % tmp_path)
            except OSError:
                pass
        log.close()


if __name__ == "__main__":
    sys.exit(main())
