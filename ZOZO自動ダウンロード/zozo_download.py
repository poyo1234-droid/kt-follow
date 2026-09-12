# -*- coding: utf-8 -*-
"""
ZOZO BACK OFFICE 展開単位CSV（goods_cs.csv）自動ダウンロード

毎朝タスクスケジューラから実行する。約970MB・約40万行を15分ほどかけて取得し、
検査に通ったときだけ旧ファイルを OLD へ退避して入れ替える。

  python zozo_download.py              通常の実行
  python zozo_download.py --show       ブラウザを表示して実行（動作確認用）
  python zozo_download.py --dry-run    受信だけして入れ替えない（検査結果は出す）
  python zozo_download.py --no-popup   失敗してもメッセージボックスを出さない

設定は settings.txt（このファイルと同じフォルダ）。値をクォートで囲まないこと。

--------------------------------------------------------------------------
処理の流れ
--------------------------------------------------------------------------
 1. Playwright で Basic認証（1段目）とログインフォーム（2段目）を通す
 2. 商品検索を開いて検索ボタンを押す（条件は既定のまま。表示件数はCSVに影響しない）
 3. セッションのCookieを取り出してブラウザを閉じる
 4. Cookie と Basic認証ヘッダを付けて CSV を直接ストリーミング受信し、
    保存先フォルダに一時名（.part）で書く
 5. 検査する
      - ヘッダの列数が28か（違えば中断）
      - 列名が既知と一致するか（違えば警告のみ。ZOZO側で表記が変わる前例があるため）
      - 最終行の列数が揃っているか（途中切れの検出）
      - 前回ファイルと行数・サイズを比べて ±10% 以内か
 6. 通ったら、旧ファイルを OLD へ移し、.part を正式名にする
    通らなかったら .part を失敗フォルダに残し、旧ファイルはそのままにする

ログは log フォルダの zozo_download_YYYYMMDD.log に追記する。
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
from datetime import datetime

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


def popup(title, text):
    """失敗をその場で気づけるようにメッセージボックスを出す。"""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, text, title, 0x10)   # MB_ICONERROR
    except Exception:
        pass


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

def fetch_cookies(s, log, show=False):
    """Playwright でログインと検索を済ませ、セッションのCookieを返す。"""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not show)
        ctx = browser.new_context(
            http_credentials={"username": s["company_id"],
                              "password": s["company_password"]},
            user_agent=CHROME_UA,
        )
        pg = ctx.new_page()
        pg.set_default_timeout(120000)
        pg.on("dialog", lambda d: (log("  画面のダイアログ: %s" % d.message),
                                   d.accept()))
        try:
            resp = pg.goto(TOP_URL, wait_until="domcontentloaded", timeout=60000)
            status = resp.status if resp else None
            if status == 401:
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

            log("商品検索を開きます")
            pg.goto(SEARCH_URL, wait_until="domcontentloaded", timeout=60000)
            pg.wait_for_selector("button[name='search']", timeout=30000)

            # 検索条件は既定のまま。表示件数(Top)はCSVの中身に影響しない
            log("検索します（条件は既定のまま）")
            t0 = time.time()
            with pg.expect_navigation(wait_until="domcontentloaded", timeout=600000):
                pg.click("button[name='search']")
            log("  検索完了まで %.1f秒" % (time.time() - t0))

            if pg.query_selector("a[href*='c=ListDownLoadCS']") is None:
                raise RuntimeError("検索結果に「展開単位CSV」が見つかりませんでした。"
                                   "画面の作りが変わった可能性があります。")

            cookies = ctx.cookies()
            log("セッションのCookieを取り出しました（%d個）" % len(cookies))
            return "; ".join("%s=%s" % (c["name"], c["value"]) for c in cookies)
        finally:
            browser.close()


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
    ap.add_argument("--no-popup", action="store_true",
                    help="失敗してもメッセージボックスを出さない")
    args = ap.parse_args()

    log = Logger()
    log("=" * 60)
    log("ZOZO goods_cs 自動ダウンロードを開始します")

    tmp_path = None
    try:
        s = load_settings()
        out_dir = s["download_dir"]
        old_dir = s["old_dir"]
        final_path = os.path.join(out_dir, s["file_name"])
        if not os.path.isdir(out_dir):
            raise RuntimeError("保存先フォルダがありません: %s" % out_dir)
        log("保存先: %s" % final_path)

        tmp_path = final_path + ".part"
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

        cookie_header = fetch_cookies(s, log, show=args.show)

        log("CSVを受信します（約970MB・15分ほどかかります）")
        download(cookie_header, s, tmp_path, log)

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
        if not args.no_popup:
            popup("ZOZO goods_cs ダウンロード失敗",
                  "%s\n\nログ: %s" % (e, log.path))
        return 1
    finally:
        # 途中で落ちた場合、書きかけの .part は残さない
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
                log("書きかけのファイルを削除しました: %s" % tmp_path)
            except OSError:
                pass
        log.close()


if __name__ == "__main__":
    sys.exit(main())
