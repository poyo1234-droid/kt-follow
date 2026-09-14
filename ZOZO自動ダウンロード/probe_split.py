# -*- coding: utf-8 -*-
"""
検証: GoodsSearch.asp?c=ListDownLoadCS は直前の検索条件を反映するか。

反映するなら「登録日での期間分割ダウンロード」が成立し、ASP のスクリプト
タイムアウト(約30分)を回避できる。反映しないなら分割案は不成立。

使い方（Windows のコマンドプロンプトで）:
    cd /d "...\ZOZO自動ダウンロード"
    python probe_split.py            ... 検証1と検証2（軽い。数分）
    python probe_split.py full2022   ... 検証3（2022年まるごと。10分前後）

受信先は %TEMP% （ローカルディスク）。NASには書かない。
上限に達したら途中で打ち切る（1GBを丸ごと落とさないため）。
"""
import io
import os
import sys
import csv
import time
import base64
import urllib.request
from datetime import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from zozo_download import (load_settings, CHROME_UA, TOP_URL, SEARCH_URL,
                           CSV_URL, HTTP_TIMEOUT, CHUNK, ENCODING)

LOG_PATH = os.path.join(SCRIPT_DIR, "log",
                        "probe_split_%s.log" % datetime.now().strftime("%Y%m%d_%H%M%S"))
csv.field_size_limit(10 ** 9)


def log(msg):
    line = "[%s] %s" % (datetime.now().strftime("%H:%M:%S"), msg)
    print(line)
    sys.stdout.flush()
    with io.open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


# --------------------------------------------------------- ログイン＋検索

def login_and_search(s, conds, label):
    """条件を入れて検索し、セッションCookieを返す。"""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            http_credentials={"username": s["company_id"],
                              "password": s["company_password"]},
            user_agent=CHROME_UA,
        )
        pg = ctx.new_page()
        pg.set_default_timeout(120000)
        pg.on("dialog", lambda d: d.accept())
        try:
            pg.goto(TOP_URL, wait_until="domcontentloaded", timeout=60000)
            pg.wait_for_selector("#UserID", timeout=30000)
            pg.fill("#UserID", s["user_id"])
            pg.fill("input[name='Password']", s["user_password"])
            with pg.expect_navigation(wait_until="domcontentloaded", timeout=60000):
                pg.click("button[type='submit']")
            pg.wait_for_timeout(2000)
            if pg.query_selector("#UserID") is not None:
                raise RuntimeError("ログインに失敗しました")
            log("  ログイン通過")

            pg.goto(SEARCH_URL, wait_until="domcontentloaded", timeout=60000)
            pg.wait_for_selector("button[name='search']", timeout=30000)

            # 条件を入れる。ラジオ/チェックはCSSで隠れているので JS で触る
            if conds.get("GoodsCode"):
                pg.fill("input[name='GoodsCode']", conds["GoodsCode"])
            if conds.get("RegistDTFrom"):
                pg.eval_on_selector("input[name='SEARCH_RegistDT']",
                                    "e => { e.checked = true; }")
                # fill + Escape だと日付ピッカーが値を戻す（2026-09-14 実測）。
                # JS で直接入れて change を発火させる
                setter = ("(e, v) => { e.value = v;"
                          " e.dispatchEvent(new Event('input', {bubbles:true}));"
                          " e.dispatchEvent(new Event('change', {bubbles:true})); }")
                for nm in ("RegistDTFrom", "RegistDTTo"):
                    pg.eval_on_selector("input[name='%s']" % nm, setter, conds[nm])

            # 送信直前の実値を記録（ピッカーに書き換えられていないか確認する）
            for name in ("GoodsCode", "RegistDTFrom", "RegistDTTo"):
                el = pg.query_selector("input[name='%s']" % name)
                v = el.input_value() if el is not None else None
                log("    送信値 %s = %r" % (name, v))
                want = conds.get(name)
                if want and v != want:
                    raise RuntimeError(
                        "条件 %s が %r になっていません（実値 %r）。"
                        "検索する前に中止しました。" % (name, want, v))
            chk = pg.query_selector("input[name='SEARCH_RegistDT']")
            if chk is not None:
                log("    送信値 SEARCH_RegistDT(checked) = %s" % chk.is_checked())

            t0 = time.time()
            with pg.expect_navigation(wait_until="domcontentloaded", timeout=600000):
                pg.click("button[name='search']")
            log("  検索完了まで %.1f秒" % (time.time() - t0))

            if pg.query_selector("a[href*='c=ListDownLoadCS']") is None:
                raise RuntimeError("結果画面に「展開単位CSV」のリンクがありません"
                                   "（該当0件か、画面構成が変わった可能性）")

            html_path = os.path.join(SCRIPT_DIR, "log",
                                     "probe_split_result_%s.html" % label)
            with io.open(html_path, "w", encoding="utf-8") as f:
                f.write(pg.content())
            log("  結果画面を保存: %s" % os.path.basename(html_path))

            cookies = ctx.cookies()
            return "; ".join("%s=%s" % (c["name"], c["value"]) for c in cookies)
        finally:
            browser.close()


# --------------------------------------------------------- CSV受信（上限つき）

def download_capped(cookie_header, s, out_path, max_mb, max_sec):
    req = urllib.request.Request(CSV_URL)
    req.add_header("Cookie", cookie_header)
    req.add_header("User-Agent", CHROME_UA)
    token = base64.b64encode(
        ("%s:%s" % (s["company_id"], s["company_password"])).encode("utf-8")
    ).decode("ascii")
    req.add_header("Authorization", "Basic " + token)

    limit = max_mb * 1048576
    t0 = time.time()
    got = 0
    capped = False
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        ctype = r.headers.get("Content-Type", "")
        log("  HTTP %s / Content-Type: %s" % (r.status, ctype))
        last = time.time()
        with io.open(out_path, "wb") as f:
            while True:
                chunk = r.read(CHUNK)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if got >= limit or (time.time() - t0) >= max_sec:
                    capped = True
                    break
                if time.time() - last >= 30:
                    log("  受信中 %.1f MB（%.2f MB/s）"
                        % (got / 1048576.0, got / (time.time() - t0) / 1048576.0))
                    last = time.time()
    el = time.time() - t0
    log("  %s %.2f MB / %.1f秒（%.2f MB/s）"
        % ("★上限で打ち切り" if capped else "受信完了", got / 1048576.0, el,
           got / el / 1048576.0 if el else 0))
    return got, capped


# --------------------------------------------------------- 中身を見る

def summarize(path):
    with io.open(path, "rb") as f:
        f.seek(max(0, os.path.getsize(path) - 3000))
        tail = f.read()
    if b"ASP 0113" in tail or b"Active Server Pages" in tail:
        log("  ★末尾に ASP のエラーページが混ざっています（タイムアウト）")

    n = 0
    codes = set()
    dmin = None
    dmax = None
    with io.open(path, encoding=ENCODING, errors="replace", newline="") as f:
        r = csv.reader(f)
        try:
            hdr = next(r)
        except StopIteration:
            log("  中身: 空です")
            return
        try:
            ic = hdr.index("商品コード")
            ir = hdr.index("登録日")
        except ValueError:
            log("  中身: ヘッダが想定と違います（列数 %d）" % len(hdr))
            return
        for row in r:
            if len(row) < 28:
                continue
            n += 1
            codes.add(row[ic])
            d = row[ir][:10]
            if d:
                dmin = d if dmin is None or d < dmin else dmin
                dmax = d if dmax is None or d > dmax else dmax
    log("  中身: %d行 / 商品コード %d種 / 登録日 %s 〜 %s"
        % (n, len(codes), dmin, dmax))


# --------------------------------------------------------- 各検証

def run(label, title, conds, expect, max_mb, max_sec, s):
    log("=" * 60)
    log("%s %s" % (label, title))
    log("  期待: %s" % expect)
    out = os.path.join(os.environ.get("TEMP", "."), "probe_%s.csv" % label)
    cookie = login_and_search(s, conds, label)
    got, capped = download_capped(cookie, s, out, max_mb, max_sec)
    if capped:
        log("  → 上限まで流れ続けました。**条件が効いていない可能性が高い**")
    summarize(out)
    log("  受信先: %s" % out)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    s = load_settings()
    log("検証開始（受信先はローカル %s）" % os.environ.get("TEMP", "."))

    if mode == "full2022":
        run("3", "登録日 2022年まるごと", 
            {"RegistDTFrom": "2022/01/01", "RegistDTTo": "2022/12/31"},
            "47,057行・110MB前後（9/12のファイルより算出）", 400, 1500, s)
        return 0

    run("1", "商品コード 98032453 だけ",
        {"GoodsCode": "98032453"},
        "10行（9/12のファイルより算出）", 60, 300, s)
    run("2", "登録日 2022/01/01〜2022/01/31",
        {"RegistDTFrom": "2022/01/01", "RegistDTTo": "2022/01/31"},
        "3,180行・7MB前後（9/12のファイルより算出）", 120, 600, s)
    log("=" * 60)
    log("完了。ログ: %s" % LOG_PATH)
    return 0


if __name__ == "__main__":
    sys.exit(main())
