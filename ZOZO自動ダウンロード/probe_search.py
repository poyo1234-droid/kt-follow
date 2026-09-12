# -*- coding: utf-8 -*-
"""
ZOZO BACK OFFICE 商品検索画面 調査用スクリプト（第3段階の下調べ）

やること: ログイン後に「商品管理 > 商品検索」を開き、検索条件の入力欄と
          ボタンの一覧を表示する。検索の実行まではしない。
やらないこと: 検索ボタンを押す、ダウンロード、設定値の表示。

  python probe_search.py          画面を見ずに実行
  python probe_search.py --show   ブラウザを表示して実行
  python probe_search.py --show --keep

出力にパスワードは一切含まれません。
"""
import argparse
import io
import os
import sys

from playwright.sync_api import sync_playwright

from probe_login import (URL, SCRIPT_DIR, load_settings, dump_page,
                         use_utf8_stdout)
from probe_after_login import save_artifacts, dump_links

use_utf8_stdout()


def login(pg, s):
    resp = pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
    print("1段目(Basic認証) HTTPステータス: %s" % (resp.status if resp else None))
    pg.wait_for_selector("#UserID", timeout=30000)
    pg.fill("#UserID", s["user_id"])
    pg.fill("input[name='Password']", s["user_password"])
    with pg.expect_navigation(wait_until="domcontentloaded", timeout=60000):
        pg.click("button[type='submit']")
    pg.wait_for_timeout(2000)
    if pg.query_selector("#UserID") is not None:
        sys.exit("ログインできませんでした。settings.txt の user_id / user_password を確認してください。")
    print("ログイン成功: %s" % pg.url)


def check_modal(pg):
    """パスワード変更モーダルが実際に表示されていないかを見る。"""
    el = pg.query_selector("input[placeholder='旧パスワード']")
    if el is None:
        print("パスワード変更モーダル: DOMに無し")
        return
    try:
        visible = el.is_visible()
    except Exception:
        visible = None
    print("パスワード変更モーダル: DOMにあり / 表示されている=%s" % visible)
    if visible:
        print("  ※ 表示されています。自動化の妨げになるため、手動でパスワードを変更してください。")


def dump_search_form(pg):
    """検索画面の入力欄だけを表示する（ヘッダのメニューは省く）。"""
    print("")
    print("=" * 70)
    print("[商品検索画面の入力欄・ボタン]")
    print("-" * 70)
    for f in pg.query_selector_all("form"):
        act = f.get_attribute("action") or ""
        if "HeaderSearch" in act or "Default.asp" in act or "main.asp" in act:
            continue   # ヘッダの検索窓・ログアウト・カレンダーは対象外
        print("  FORM action=%r method=%r name=%r id=%r"
              % (act, f.get_attribute("method"), f.get_attribute("name"),
                 f.get_attribute("id")))
        for el in f.query_selector_all("input, select, textarea, button"):
            tag = el.evaluate("e => e.tagName.toLowerCase()")
            typ = el.get_attribute("type")
            try:
                text = " ".join((el.inner_text() or "").split())[:30]
                vis = el.is_visible()
            except Exception:
                text, vis = "", None
            extra = ""
            if tag == "select":
                opts = el.query_selector_all("option")
                extra = " options=%d 例=%s" % (
                    len(opts),
                    [ (o.inner_text() or "").strip()[:14] for o in opts[:5] ])
            print("    <%s> type=%r name=%r id=%r value=%r text=%r visible=%s%s"
                  % (tag, typ, el.get_attribute("name"), el.get_attribute("id"),
                     (el.get_attribute("value") or "")[:24], text, vis, extra))
    print("-" * 70)
    print("  --- 画面の文字（先頭1500字）---")
    try:
        print(pg.inner_text("body")[:1500])
    except Exception as e:
        print("  (取得できず: %s)" % e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", action="store_true", help="ブラウザを表示する")
    ap.add_argument("--keep", action="store_true",
                    help="Enterを押すまでブラウザを閉じずに待つ")
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
        login(pg, s)
        check_modal(pg)

        # --- 商品検索を直接開く（メニューはドロップダウンで隠れていてクリックできない）
        search_url = "https://to.zozo.jp/to/GoodsSearch.asp?c=Init"
        print("")
        print("商品検索を開きます: %s" % search_url)
        resp = pg.goto(search_url, wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(3000)
        print("  HTTPステータス: %s" % (resp.status if resp else None))
        print("  url  : %s" % pg.url)
        print("  title: %s" % pg.title())

        dump_search_form(pg)
        save_artifacts(pg, "search")

        if args.keep:
            print("")
            print("ブラウザを開いたままにしています。"
                  "確認が終わったら、この画面で Enter を押してください。")
            try:
                input()
            except EOFError:
                pass

        browser.close()


if __name__ == "__main__":
    main()
