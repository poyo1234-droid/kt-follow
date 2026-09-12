# -*- coding: utf-8 -*-
"""
ZOZO BACK OFFICE 検索結果画面 調査用スクリプト（第3段階の下調べ その2）

やること: ログイン → 商品検索を開く → 条件を変えずに検索ボタンを押す →
          結果画面に現れるボタン・リンク（展開CSV など）を一覧表示する。
やらないこと: ダウンロードの実行、設定値の表示。

  python probe_result.py            画面を見ずに実行
  python probe_result.py --show     ブラウザを表示して実行
  python probe_result.py --wait 300 検索完了を待つ上限（秒。既定180）

出力にパスワードは一切含まれません。
"""
import argparse
import io
import os
import sys
import time

from playwright.sync_api import sync_playwright

from probe_login import SCRIPT_DIR, load_settings, use_utf8_stdout
from probe_after_login import save_artifacts
from probe_search import login

use_utf8_stdout()

SEARCH_URL = "https://to.zozo.jp/to/GoodsSearch.asp?c=Init"


def dump_clickables(pg, label):
    """押せるもの（ボタン・リンク）を一覧表示する。ヘッダの共通部分は省く。"""
    print("")
    print("=" * 70)
    print("[%s]" % label)
    print("  url  : %s" % pg.url)
    print("  title: %s" % pg.title())
    print("-" * 70)
    print("  --- ボタン・submit ---")
    for el in pg.query_selector_all("button, input[type='submit'], input[type='button']"):
        try:
            text = " ".join((el.inner_text() or "").split())[:40]
            vis = el.is_visible()
        except Exception:
            text, vis = "", None
        print("    <%s> name=%r value=%r text=%r visible=%s onclick=%r" % (
            el.evaluate("e => e.tagName.toLowerCase()"),
            el.get_attribute("name"), (el.get_attribute("value") or "")[:30],
            text, vis, (el.get_attribute("onclick") or "")[:80]))
    print("")
    print("  --- リンク（ヘッダのメニューを除く）---")
    seen = set()
    for a in pg.query_selector_all("a"):
        cls = a.get_attribute("class") or ""
        if "dropdown-link" in cls or "gnav-link" in cls or "header-brand-link" in cls:
            continue
        try:
            text = " ".join((a.inner_text() or "").split())[:40]
        except Exception:
            text = ""
        href = a.get_attribute("href") or ""
        onclick = (a.get_attribute("onclick") or "")[:80]
        key = (text, href, onclick)
        if key in seen or (not text and not href and not onclick):
            continue
        seen.add(key)
        print("    %-24s href=%-45s onclick=%r" % (text, href[:45], onclick))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", action="store_true", help="ブラウザを表示する")
    ap.add_argument("--keep", action="store_true", help="Enterを押すまで閉じない")
    ap.add_argument("--wait", type=int, default=180,
                    help="検索完了を待つ上限（秒）")
    args = ap.parse_args()

    s = load_settings()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.show)
        ctx = browser.new_context(
            http_credentials={"username": s["company_id"],
                              "password": s["company_password"]},
            accept_downloads=True,
        )
        pg = ctx.new_page()
        pg.set_default_timeout(args.wait * 1000)
        login(pg, s)

        print("")
        print("商品検索を開きます…")
        pg.goto(SEARCH_URL, wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_selector("button[name='search']", timeout=30000)

        print("検索ボタンを押します（条件は変更しません）…")
        t0 = time.time()
        try:
            with pg.expect_navigation(wait_until="domcontentloaded",
                                      timeout=args.wait * 1000):
                pg.click("button[name='search']")
            print("  遷移しました（%.1f秒）" % (time.time() - t0))
        except Exception as e:
            print("  遷移を検知できませんでした: %s（%.1f秒）"
                  % (type(e).__name__, time.time() - t0))
            print("  ページ内で結果を差し替えている可能性があります。")

        # 画面が落ち着くまで待つ
        try:
            pg.wait_for_load_state("networkidle", timeout=args.wait * 1000)
        except Exception:
            print("  networkidle にはなりませんでした（通信が続いている可能性）")
        print("  検索開始からの経過: %.1f秒" % (time.time() - t0))

        dump_clickables(pg, "検索結果画面")
        save_artifacts(pg, "result")

        print("")
        print("  --- 画面の文字（先頭800字）---")
        try:
            print(pg.inner_text("body")[:800])
        except Exception as e:
            print("  (取得できず: %s)" % e)

        if args.keep:
            print("")
            print("ブラウザを開いたままにしています。Enterで閉じます。")
            try:
                input()
            except EOFError:
                pass

        browser.close()


if __name__ == "__main__":
    main()
