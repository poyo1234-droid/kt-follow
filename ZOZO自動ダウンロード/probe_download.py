# -*- coding: utf-8 -*-
"""
ZOZO BACK OFFICE 展開単位CSV ダウンロード検証スクリプト（第3段階）

やること: ログイン → 商品検索 → 対象を「指定なし（全件）」にして検索 →
          「展開単位CSV」を押してファイルを落とし、所要時間とサイズ、
          先頭行（ヘッダ）を記録する。
やらないこと: 既存ファイルの移動・上書き。落としたファイルは検証用の名前で保存する。

  python probe_download.py                検証用の名前で保存する
  python probe_download.py --show         ブラウザを表示する
  python probe_download.py --wait 900     検索・DLの待ち上限（秒。既定600）
  python probe_download.py --out D:\tmp   保存先を変える（既定は settings.txt の download_dir）

出力にパスワードは一切含まれません。
"""
import argparse
import io
import os
import sys
import time
from datetime import datetime

from playwright.sync_api import sync_playwright

from probe_login import SCRIPT_DIR, load_settings, use_utf8_stdout
from probe_search import login

use_utf8_stdout()

SEARCH_URL = "https://to.zozo.jp/to/GoodsSearch.asp?c=Init"
CS_CSV_SELECTOR = "a[href*='c=ListDownLoadCS']"


def log(msg):
    print("[%s] %s" % (datetime.now().strftime("%H:%M:%S"), msg), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", action="store_true", help="ブラウザを表示する")
    ap.add_argument("--wait", type=int, default=600, help="待ち上限（秒）")
    ap.add_argument("--out", default=None, help="保存先フォルダ")
    ap.add_argument("--top", default="keep", choices=["0", "1", "keep"],
                    help="対象（表示件数）: 0=指定なし(全件) / 1=50件 / keep=既定のまま")
    args = ap.parse_args()

    s = load_settings()
    out_dir = args.out or s.get("download_dir") or SCRIPT_DIR
    if not os.path.isdir(out_dir):
        sys.exit("保存先フォルダがありません: %s" % out_dir)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = os.path.join(out_dir, "goods_cs_検証_top%s_%s.csv" % (args.top, stamp))
    log("保存先: %s" % out_path)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.show)
        ctx = browser.new_context(
            http_credentials={"username": s["company_id"],
                              "password": s["company_password"]},
            accept_downloads=True,
        )
        pg = ctx.new_page()
        pg.set_default_timeout(args.wait * 1000)

        # confirm/alert が出たら内容を記録して進める
        pg.on("dialog", lambda d: (log("ダイアログ: type=%s message=%r"
                                       % (d.type, d.message)), d.accept()))

        login(pg, s)

        log("商品検索を開きます")
        pg.goto(SEARCH_URL, wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_selector("button[name='search']", timeout=30000)

        # --- 対象（表示件数）の指定 ---------------------------------------------
        # ラジオは装飾で隠れていて click/check だと待ち続けるため、JSで直接入れる。
        if args.top in ("0", "1"):
            log("対象を Top=%s に設定します（0=指定なし・全件 / 1=50件）" % args.top)
            pg.eval_on_selector(
                "input[name='Top'][value='%s']" % args.top,
                "e => { e.checked = true;"
                "       e.dispatchEvent(new Event('change', {bubbles:true})); }")
        else:
            log("対象は画面の既定のまま（触りません）")

        for name in ("Top", "SearchDb"):
            state = pg.eval_on_selector_all(
                "input[name='%s']" % name,
                "els => els.map(e => e.value + (e.checked ? '(選択)' : ''))")
            log("  %s = %s" % (name, state))

        # --- 検索 ---------------------------------------------------------------
        log("検索ボタンを押します")
        t0 = time.time()
        try:
            with pg.expect_navigation(wait_until="domcontentloaded",
                                      timeout=args.wait * 1000):
                pg.click("button[name='search']")
        except Exception as e:
            log("  遷移を検知できず: %s" % type(e).__name__)
        log("  検索の遷移まで %.1f秒" % (time.time() - t0))

        # 展開単位CSVのリンクが押せるようになるまで待つ
        log("「展開単位CSV」が現れるのを待ちます")
        try:
            pg.wait_for_selector(CS_CSV_SELECTOR, state="visible",
                                 timeout=args.wait * 1000)
            log("  現れました（検索開始から %.1f秒）" % (time.time() - t0))
        except Exception as e:
            log("  現れませんでした: %s" % type(e).__name__)
            log("  現在のURL: %s" % pg.url)
            browser.close()
            sys.exit(1)

        # 件数の表示を拾っておく
        try:
            body = pg.inner_text("body")
            import re
            hits = re.findall(r"全[\d,]+件", body)
            log("  画面の件数表示: %s" % (hits[:3] or "見つからず"))
        except Exception:
            pass

        # --- ダウンロード -------------------------------------------------------
        log("「展開単位CSV」を押します")
        t1 = time.time()
        with pg.expect_download(timeout=args.wait * 1000) as dl_info:
            pg.click(CS_CSV_SELECTOR)
        dl = dl_info.value
        log("  ダウンロード開始。サーバー提示のファイル名: %r" % dl.suggested_filename)

        tmp = dl.path()          # 完了するまでここでブロックする
        log("  受信完了 %.1f秒 / 一時ファイル: %s" % (time.time() - t1, tmp))
        size_tmp = os.path.getsize(tmp)
        log("  サイズ: %s バイト (%.1f MB)" % ("{:,}".format(size_tmp),
                                            size_tmp / 1024.0 / 1024.0))

        t2 = time.time()
        dl.save_as(out_path)
        log("  保存完了 %.1f秒: %s" % (time.time() - t2, out_path))

        browser.close()

    # --- 中身の確認 -------------------------------------------------------------
    size = os.path.getsize(out_path)
    log("最終サイズ: %s バイト (%.1f MB)" % ("{:,}".format(size), size / 1024.0 / 1024.0))

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

    # 行数（大きいので単純カウント）
    t3 = time.time()
    n = 0
    with io.open(out_path, "rb") as f:
        for _ in f:
            n += 1
    log("行数（改行基準）: %s （%.1f秒）" % ("{:,}".format(n), time.time() - t3))


if __name__ == "__main__":
    main()
