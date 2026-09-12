# -*- coding: utf-8 -*-
"""
ZOZO BACK OFFICE 展開単位CSV ダウンロード検証スクリプト（方式2）

ブラウザのダウンロード機構は1GB級だと途中で切れたため、
  ログイン・検索まで Playwright → 実際の受信は Python で直接ストリーミング
という方式に変える。進捗を出しながらディスクへ直接書く。

  python probe_download2.py                 検証用の名前で保存
  python probe_download2.py --top 0         対象を「指定なし(全件)」にして検索
  python probe_download2.py --out D:\tmp    保存先を変える

出力にパスワードは一切含まれません。
"""
import argparse
import base64
import io
import os
import sys
import time
import urllib.request
from datetime import datetime

from playwright.sync_api import sync_playwright

from probe_login import SCRIPT_DIR, load_settings, use_utf8_stdout
from probe_search import login

use_utf8_stdout()

SEARCH_URL = "https://to.zozo.jp/to/GoodsSearch.asp?c=Init"
CSV_URL = "https://to.zozo.jp/to/GoodsSearch.asp?c=ListDownLoadCS"
# ヘッドレスだと「推奨ブラウザはGoogle Chrome」と言われるので、Chromeを名乗る
CHROME_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")


def log(msg):
    print("[%s] %s" % (datetime.now().strftime("%H:%M:%S"), msg), flush=True)


def mb(n):
    return "%.1f MB" % (n / 1024.0 / 1024.0)


def stream_download(url, cookie_header, basic_user, basic_pass, out_path,
                    timeout=120):
    """CSVを直接ストリーミング受信してファイルに書く。進捗を出す。"""
    req = urllib.request.Request(url)
    req.add_header("Cookie", cookie_header)
    req.add_header("User-Agent", CHROME_UA)
    token = base64.b64encode(
        ("%s:%s" % (basic_user, basic_pass)).encode("utf-8")).decode("ascii")
    req.add_header("Authorization", "Basic " + token)

    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        log("  HTTP %s" % r.status)
        for k in ("Content-Type", "Content-Length", "Content-Disposition",
                  "Transfer-Encoding"):
            if r.headers.get(k):
                log("  %s: %s" % (k, r.headers.get(k)))
        total = r.headers.get("Content-Length")
        total = int(total) if total else None

        got = 0
        last = time.time()
        with io.open(out_path, "wb") as f:
            while True:
                chunk = r.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if time.time() - last >= 10:
                    rate = got / (time.time() - t0) / 1024.0 / 1024.0
                    if total:
                        log("  受信中 %s / %s (%.1f%%) %.1f MB/s"
                            % (mb(got), mb(total), got * 100.0 / total, rate))
                    else:
                        log("  受信中 %s  %.1f MB/s" % (mb(got), rate))
                    last = time.time()
    log("  受信完了 %s（%.1f秒）" % (mb(got), time.time() - t0))
    return got


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", action="store_true")
    ap.add_argument("--out", default=None)
    ap.add_argument("--top", default="keep", choices=["0", "1", "keep"],
                    help="対象: 0=指定なし(全件) / 1=50件 / keep=既定のまま")
    args = ap.parse_args()

    s = load_settings()
    out_dir = args.out or s.get("download_dir") or SCRIPT_DIR
    if not os.path.isdir(out_dir):
        sys.exit("保存先フォルダがありません: %s" % out_dir)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = os.path.join(out_dir, "goods_cs_検証2_top%s_%s.csv"
                            % (args.top, stamp))
    log("保存先: %s" % out_path)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.show)
        ctx = browser.new_context(
            http_credentials={"username": s["company_id"],
                              "password": s["company_password"]},
            user_agent=CHROME_UA,
        )
        pg = ctx.new_page()
        pg.set_default_timeout(120000)
        pg.on("dialog", lambda d: (log("ダイアログ: %r" % d.message), d.accept()))

        login(pg, s)

        log("商品検索を開きます")
        pg.goto(SEARCH_URL, wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_selector("button[name='search']", timeout=30000)

        if args.top in ("0", "1"):
            log("対象を Top=%s に設定します" % args.top)
            pg.eval_on_selector(
                "input[name='Top'][value='%s']" % args.top,
                "e => { e.checked = true;"
                "       e.dispatchEvent(new Event('change', {bubbles:true})); }")
        else:
            log("対象は画面の既定のまま")
        log("  Top = %s" % pg.eval_on_selector_all(
            "input[name='Top']", "els => els.map(e => e.value + (e.checked ? '(選択)' : ''))"))

        log("検索ボタンを押します")
        t0 = time.time()
        try:
            with pg.expect_navigation(wait_until="domcontentloaded", timeout=600000):
                pg.click("button[name='search']")
        except Exception as e:
            log("  遷移を検知できず: %s" % type(e).__name__)
        log("  検索完了まで %.1f秒" % (time.time() - t0))

        try:
            import re
            hits = re.findall(r"全[\d,]+件", pg.inner_text("body"))
            log("  画面の件数表示: %s" % (hits[:2] or "見つからず"))
        except Exception:
            pass

        cookies = ctx.cookies()
        cookie_header = "; ".join("%s=%s" % (c["name"], c["value"]) for c in cookies)
        log("セッションのCookieを取り出しました（%d個）" % len(cookies))
        browser.close()

    log("CSVを直接受信します: %s" % CSV_URL)
    size = stream_download(CSV_URL, cookie_header,
                           s["company_id"], s["company_password"], out_path)

    log("最終サイズ: %s バイト (%s)" % ("{:,}".format(size), mb(size)))

    # --- 中身の確認 ---
    for enc in ("cp932", "utf-8-sig"):
        try:
            with io.open(out_path, encoding=enc, newline="") as f:
                head = f.readline().rstrip("\r\n")
            log("文字コード %s で読めました" % enc)
            cols = head.split(",")
            log("ヘッダ列数: %d" % len(cols))
            for i, c in enumerate(cols, 1):
                log("  %2d %s" % (i, c))
            break
        except UnicodeDecodeError:
            log("文字コード %s では読めませんでした" % enc)

    t3 = time.time()
    n = 0
    with io.open(out_path, "rb") as f:
        for _ in f:
            n += 1
    log("行数（改行基準）: %s （%.1f秒）" % ("{:,}".format(n), time.time() - t3))


if __name__ == "__main__":
    main()
