# -*- coding: utf-8 -*-
"""
受信が途中で切れたときに気づけるかを確かめるテスト。

ZOZO の応答は `Transfer-Encoding: chunked` で、データの最後に「サイズ0の終端チャンク」
が来る。途中で接続が切れた場合に Python がそれを検知して例外を投げるかどうかは、
本番を1GB落とし直さなくても、同じ形の応答を返すサーバをローカルに立てれば確かめられる。

zozo_download.py の download() をそのまま当てて、次の3つを見る。

  A. 終端チャンクまで正しく送る            → 正常に終わるか
  B. 終端チャンクを送らずに接続を切る      → 例外になるか（ここが本題）
  C. CSVではなくHTMLを返す                 → Content-Type の検査で弾けるか

  python test_truncated.py

ネットワークには出ない（127.0.0.1 のみ）。ZOZO には一切アクセスしない。
"""
import io
import os
import socket
import sys
import tempfile
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zozo_download as z

z.use_utf8_stdout = None   # 未使用（zozo_download 側に無いので触らない）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BODY_CHUNK = (b'"ZOZOTOWN","FUNALIVE","test","test","A","B","WOMEN",'
              b'"X-1","1","X-1-1","name","color","size","2026/01/01",'
              b'"1000","1","","","1","","","","","","","","","M"\r\n') * 200


def serve_once(mode, port_holder):
    """1回だけ応答を返すサーバ。mode で挙動を変える。"""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port_holder.append(srv.getsockname()[1])
    port_holder.append(srv)          # 呼び出し側が閉じられるように

    conn, _ = srv.accept()
    try:
        conn.recv(65536)             # リクエストは読み捨てる

        if mode == "html":
            body = b"<html><body>login</body></html>"
            conn.sendall(b"HTTP/1.1 200 OK\r\n"
                         b"Content-Type: text/html\r\n"
                         b"Content-Length: %d\r\n\r\n" % len(body) + body)
            return

        conn.sendall(b"HTTP/1.1 200 OK\r\n"
                     b"Content-Type: Application/vnd.ms-excel-csv\r\n"
                     b"Content-Disposition: attachment; filename=goods_cs.csv\r\n"
                     b"Transfer-Encoding: chunked\r\n\r\n")
        for _ in range(5):
            conn.sendall(b"%X\r\n" % len(BODY_CHUNK) + BODY_CHUNK + b"\r\n")

        if mode == "complete":
            conn.sendall(b"0\r\n\r\n")        # 終端チャンク
        # mode == "truncated" のときは終端チャンクを送らずに切る
    finally:
        try:
            conn.close()
        except Exception:
            pass
        try:
            srv.close()
        except Exception:
            pass


class L:
    def __call__(self, m):
        print("    " + str(m))

    def error(self, m):
        print("    【エラー】" + str(m))


def run(mode, label):
    print("")
    print("=== %s ===" % label)
    holder = []
    th = threading.Thread(target=serve_once, args=(mode, holder), daemon=True)
    th.start()
    while not holder:
        pass
    port = holder[0]

    out = os.path.join(tempfile.gettempdir(), "zozo_test_%s.csv" % mode)
    saved_url = z.CSV_URL
    z.CSV_URL = "http://127.0.0.1:%d/" % port
    settings = {"company_id": "x", "company_password": "y"}
    try:
        got = z.download("dummy=1", settings, out, L())
        print("  →→ 例外なし。受信 %d バイト" % got)
        print("     ※ 途中で切れたのに気づけていない場合は、ここに出る")
        result = "例外なし"
    except Exception as e:
        print("  →→ 例外: %s" % type(e).__name__)
        print("     内容: %s" % str(e)[:200])
        result = type(e).__name__
    finally:
        z.CSV_URL = saved_url
        th.join(timeout=3)
        if os.path.exists(out):
            print("     書けたファイル: %d バイト" % os.path.getsize(out))
            os.remove(out)
    return result


if __name__ == "__main__":
    expected_total = len(BODY_CHUNK) * 5
    print("送るデータ量: %d バイト（%d バイト × 5チャンク）"
          % (expected_total, len(BODY_CHUNK)))

    a = run("complete", "A. 終端チャンクまで正しく送る（正常系）")
    b = run("truncated", "B. 終端チャンクを送らずに接続を切る（本題）")
    c = run("html", "C. CSVではなくHTMLを返す（セッション切れの想定）")

    print("")
    print("=" * 60)
    print("まとめ")
    print("  A 正常系          : %s" % a)
    print("  B 途中で切断      : %s" % b)
    print("  C HTMLが返る      : %s" % c)
    print("")
    if a == "例外なし" and b != "例外なし" and c != "例外なし":
        print("→ 期待どおり。途中切れもセッション切れも例外として検知できる。")
    else:
        print("→ 期待と違う。Bが「例外なし」なら、途中切れをHTTP層では検知できない")
        print("  ということなので、自前の検査（末尾の改行・前回比）が唯一の砦になる。")
