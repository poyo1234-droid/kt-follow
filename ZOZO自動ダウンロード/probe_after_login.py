# -*- coding: utf-8 -*-
"""
ZOZO BACK OFFICE ログイン後の画面 調査用スクリプト（第2段階の続き）

やること: 1段目のBasic認証と2段目のログインを通し、ログイン直後の画面の
          メニュー（リンク）と入力欄の一覧を表示する。
やらないこと: 検索の実行、ダウンロード、設定値の表示。

  python probe_after_login.py          画面を見ずに実行
  python probe_after_login.py --show   ブラウザを表示して実行
  python probe_after_login.py --show --keep
                                       Enterを押すまでブラウザを閉じない

出力にパスワードは一切含まれません。
"""
import argparse
import io
import os
import sys

from playwright.sync_api import sync_playwright

from probe_login import (URL, SCRIPT_DIR, load_settings, dump_page,
                         use_utf8_stdout)

use_utf8_stdout()


def save_artifacts(pg, tag):
    shot = os.path.join(SCRIPT_DIR, "log", "probe_%s.png" % tag)
    html = os.path.join(SCRIPT_DIR, "log", "probe_%s.html" % tag)
    os.makedirs(os.path.dirname(shot), exist_ok=True)
    pg.screenshot(path=shot, full_page=True)
    with io.open(html, "w", encoding="utf-8") as f:
        f.write(pg.content())
    print("  スクリーンショット: %s" % shot)
    print("  HTML              : %s" % html)


def dump_links(pg, limit=120):
    """メニューを探すためにリンクを一覧表示する。"""
    print("")
    print("  --- リンク一覧（先頭%d件）---" % limit)
    seen = set()
    n = 0
    for a in pg.query_selector_all("a"):
        try:
            text = (a.inner_text() or "").strip().replace("\n", " ")
        except Exception:
            text = ""
        href = a.get_attribute("href") or ""
        key = (text, href)
        if key in seen or (not text and not href):
            continue
        seen.add(key)
        print("    %-28s href=%s" % (text[:28], href[:90]))
        n += 1
        if n >= limit:
            break


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", action="store_true", help="ブラウザを表示する")
    ap.add_argument("--keep", action="store_true",
                    help="Enterを押すまでブラウザを閉じずに待つ")
    args = ap.parse_args()

    s = load_settings()
    for k in ("user_id", "user_password"):
        if not s.get(k):
            sys.exit("settings.txt の %s が空です。" % k)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.show)
        ctx = browser.new_context(
            http_credentials={"username": s["company_id"],
                              "password": s["company_password"]},
            accept_downloads=True,
        )
        pg = ctx.new_page()
        resp = pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
        print("1段目(Basic認証) HTTPステータス: %s" % (resp.status if resp else None))

        # --- 2段目のログイン -------------------------------------------------
        pg.wait_for_selector("#UserID", timeout=30000)
        pg.fill("#UserID", s["user_id"])
        pg.fill("input[name='Password']", s["user_password"])
        print("ログインボタンを押します…")
        with pg.expect_navigation(wait_until="domcontentloaded", timeout=60000):
            pg.click("button[type='submit']")
        pg.wait_for_timeout(3000)

        # ログインできたかの判定: ログインフォームがまだ出ていれば失敗
        still_login = pg.query_selector("#UserID") is not None
        if still_login:
            print("→ ログインできていない可能性があります"
                  "（ログイン画面が残っています）。画面の文字を確認してください。")
        else:
            print("→ ログインできたようです。")

        dump_page(pg, "ログイン直後の画面")
        dump_links(pg)
        save_artifacts(pg, "after_login")

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
