# -*- coding: utf-8 -*-
"""
ZOZO BACK OFFICE ログイン画面 調査用スクリプト（第2段階）

やること: 1段目のBasic認証を通し、その奥にあるログイン画面の
          入力欄・ボタンの「名前」だけを一覧表示する。
やらないこと: 2段目のログイン実行、ダウンロード、設定値の表示。

  python probe_login.py          画面を見ずに実行
  python probe_login.py --show   ブラウザを表示して実行（動きを目で確認したいとき）

出力にパスワードは一切含まれません。出力をそのまま貼り付けて構いません。
"""
import argparse
import io
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from playwright.sync_api import sync_playwright

URL = "https://to.zozo.jp/to/"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def load_settings():
    """settings.txt を読む。削除ツール/kintone_delete.py と同じ形式。"""
    s = {}
    path = os.path.join(SCRIPT_DIR, "settings.txt")
    if not os.path.exists(path):
        sys.exit("settings.txt がありません。\n"
                 "settings.txt.sample をコピーして settings.txt を作り、"
                 "IDとパスワードを記入してください。\n  " + path)
    with io.open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            s[k.strip()] = v.strip()
    missing = [k for k in ("company_id", "company_password") if not s.get(k)]
    if missing:
        sys.exit("settings.txt の項目が空です: %s" % ", ".join(missing))
    return s


def dump_page(pg, label):
    print("")
    print("=" * 70)
    print("[%s]" % label)
    print("  url   : %s" % pg.url)
    print("  title : %s" % pg.title())
    print("-" * 70)
    frames = pg.frames
    if len(frames) > 1:
        print("  ※ iframe が %d 個あります（frame内に入力欄がある可能性）" % (len(frames) - 1))
        for fr in frames:
            print("     frame name=%r url=%s" % (fr.name, fr.url))
    for fr in frames:
        try:
            forms = fr.query_selector_all("form")
            els = fr.query_selector_all("input, select, textarea, button, a[href]")
        except Exception:
            continue
        if not forms and not els:
            continue
        print("  --- frame: %s ---" % (fr.url or "(main)"))
        for f in forms:
            print("    FORM action=%r method=%r id=%r name=%r" % (
                f.get_attribute("action"), f.get_attribute("method"),
                f.get_attribute("id"), f.get_attribute("name")))
        for el in els[:80]:
            tag = el.evaluate("e => e.tagName.toLowerCase()")
            typ = el.get_attribute("type")
            # value は中身を出さない（パスワードが入る可能性があるため長さだけ）
            val = el.get_attribute("value") or ""
            val_info = "(len=%d)" % len(val) if typ == "password" else repr(val[:30])
            try:
                text = (el.inner_text() or "").strip().replace("\n", " ")[:40]
            except Exception:
                text = ""
            print("    <%s> type=%r name=%r id=%r class=%r placeholder=%r value=%s text=%r" % (
                tag, typ, el.get_attribute("name"), el.get_attribute("id"),
                (el.get_attribute("class") or "")[:40],
                el.get_attribute("placeholder"), val_info, text))
    print("-" * 70)
    print("  --- 画面の文字（先頭1200字）---")
    try:
        print(pg.inner_text("body")[:1200])
    except Exception as e:
        print("  (取得できず: %s)" % e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", action="store_true", help="ブラウザを表示する")
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
        resp = pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(3000)

        status = resp.status if resp else None
        print("HTTPステータス: %s" % status)
        if status == 401:
            print("→ 1段目(Basic認証)が通りませんでした。"
                  "settings.txt の company_id / company_password を確認してください。")
        else:
            print("→ 1段目(Basic認証)は通りました。")

        dump_page(pg, "1段目通過後の画面")

        shot = os.path.join(SCRIPT_DIR, "log", "probe_login.png")
        os.makedirs(os.path.dirname(shot), exist_ok=True)
        pg.screenshot(path=shot, full_page=True)
        print("\nスクリーンショット: %s" % shot)

        html = os.path.join(SCRIPT_DIR, "log", "probe_login.html")
        with io.open(html, "w", encoding="utf-8") as f:
            f.write(pg.content())
        print("HTML: %s" % html)

        browser.close()


if __name__ == "__main__":
    main()
