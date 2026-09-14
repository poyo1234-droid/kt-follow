"""
CSV 分割・列削除ツール (GUI)
- CSVファイルを指定サイズで分割
- 指定した列を削除
- 出力ファイル名を任意に設定
"""

import os
import csv
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import threading

WRITE_BUF = 8 * 1024 * 1024  # 8 MB 書き込みバッファ

# ──────────────────────────────────────────────
# 日時フォーマット正規化ユーティリティ
# ──────────────────────────────────────────────
def _is_datetime_with_seconds(b: bytes) -> bool:
    """
    YYYY/MM/DD HH:mm:ss（19バイト）または
    YYYY/MM/DD  H:mm:ss（18バイト・時刻1桁）かを判定
    """
    n = len(b)
    if n not in (18, 19):
        return False
    # YYYY/MM/DD の共通チェック
    if not (b[4] == 0x2F and b[7] == 0x2F and b[10] == 0x20
            and b[0:4].isdigit() and b[5:7].isdigit() and b[8:10].isdigit()):
        return False
    if n == 19:
        # HH:mm:ss
        return (b[13] == 0x3A and b[16] == 0x3A
                and b[11:13].isdigit() and b[14:16].isdigit() and b[17:19].isdigit())
    else:
        # H:mm:ss（時刻1桁）
        return (b[12] == 0x3A and b[15] == 0x3A
                and b[11:12].isdigit() and b[13:15].isdigit() and b[16:18].isdigit())


def _force_quote_row(row_bytes: bytes) -> bytes:
    """
    行内のクォートされていないフィールドをダブルクォートで囲む。
    ・CP932 では 0x2C (,) はマルチバイトのトレイルバイトにならないので安全に分割できる
    ・既にクォート済みのフィールドはそのまま
    """
    # 行末を取り出して保持
    if row_bytes.endswith(b'\r\n'):
        eol, body = b'\r\n', row_bytes[:-2]
    elif row_bytes.endswith(b'\n'):
        eol, body = b'\n',   row_bytes[:-1]
    elif row_bytes.endswith(b'\r'):
        eol, body = b'\r',   row_bytes[:-1]
    else:
        eol, body = b'',     row_bytes

    fields = body.split(b',')
    out = []
    for f in fields:
        if f and f[0] == 0x22:          # 既にクォートされている
            out.append(f)
        else:
            out.append(b'"' + f.replace(b'"', b'""') + b'"')
    return b','.join(out) + eol


def _normalize_date(field: bytes) -> bytes:
    """
    "YYYY/MM/DD HH:mm:ss"（21バイト）→ "YYYY/MM/DD HH:mm"
    "YYYY/MM/DD  H:mm:ss"（20バイト）→ "YYYY/MM/DD  H:mm"  ← 時刻1桁対応
    クォートなし版も同様。それ以外はそのまま返す（デコード不要・バイト操作のみ）
    """
    if field and field[0] == 0x22:                        # クォートあり
        inner = field[1:-1]                               # 前後の " を除いた中身
        if field[-1] == 0x22 and _is_datetime_with_seconds(inner):
            return field[:-4] + b'"'                      # :ss" を " に置換
    else:                                                 # クォートなし
        if _is_datetime_with_seconds(field):
            return field[:-3]                             # :ss を除去
    return field


def detect_encoding(filepath):
    try:
        import chardet as _chardet
        with open(filepath, "rb") as f:
            raw = f.read(32768)
        result = _chardet.detect(raw)
        enc = result.get("encoding") or "cp932"
    except ImportError:
        enc = "cp932"
    # shift_jis / cp932 の揺れを統一
    if enc.lower() in ("shift_jis", "shift-jis", "shift_jis-2004", "shift_jisx0213"):
        enc = "cp932"
    return enc


def read_header(filepath, encoding):
    with open(filepath, newline="", encoding=encoding, errors="replace") as f:
        reader = csv.reader(f)
        return next(reader, [])


_COMMA = ord(',')
_QUOTE = ord('"')
_CR    = ord('\r')
_LF    = ord('\n')


def _parse_rows(data: bytes, drop_set: set,
                normalize_dates: bool = False, force_quote: bool = False,
                stats: dict = None):
    """
    CSVをバイト列のまま処理するジェネレータ。
    ・デコード/エンコード一切なし → バイト完全保持
    ・CSV区切り文字はすべてASCII(<0x40)なのでCP932マルチバイトと衝突しない
    ・クォート検索は bytes.find()（C実装）で高速化
    ・normalize_dates=True のとき YYYY/MM/DD HH:mm:ss → YYYY/MM/DD HH:mm に変換
    ・force_quote=True のとき未クォートフィールドをクォートする（境界正確に処理）
    """
    n = len(data)
    i = 0
    while i < n:
        parts = []
        col = 0
        eol = None

        while eol is None and i < n:
            start = i
            malformed = False

            if data[i] == _QUOTE:
                # クォート付きフィールド
                i += 1
                while True:
                    q = data.find(_QUOTE, i)
                    if q < 0:                          # 閉じクォートなし → EOF
                        i = n; break
                    if q + 1 < n and data[q + 1] == _QUOTE:
                        i = q + 2                      # "" はエスケープ
                        continue
                    nxt = data[q + 1] if q + 1 < n else None
                    if nxt is None or nxt == _COMMA or nxt == _CR or nxt == _LF:
                        i = q + 1; break               # 正常な閉じクォート
                    # 閉じクォートの次が区切りでない＝囲みクォートが無いのに
                    # 中の " だけが二重化されているフィールド（例: ""商品名""）。
                    # 未クォートとして境界を取り直し、あとで囲みを補う
                    malformed = True; break
                if malformed:
                    c_pos = data.find(_COMMA, start)
                    r_pos = data.find(_CR,    start)
                    l_pos = data.find(_LF,    start)
                    end = n
                    if c_pos >= 0: end = min(end, c_pos)
                    if r_pos >= 0: end = min(end, r_pos)
                    if l_pos >= 0: end = min(end, l_pos)
                    i = end
                    if stats is not None:
                        stats['fixed'] = stats.get('fixed', 0) + 1
            else:
                # クォートなしフィールド: ,  \r  \n のどれかまで
                c_pos = data.find(_COMMA, i)
                r_pos = data.find(_CR,    i)
                l_pos = data.find(_LF,    i)
                end = n
                if c_pos >= 0: end = min(end, c_pos)
                if r_pos >= 0: end = min(end, r_pos)
                if l_pos >= 0: end = min(end, l_pos)
                i = end

            if col not in drop_set:
                field = data[start:i]
                if malformed:
                    # 生バイトは既に " が二重化されているので、囲むだけで正しい形になる
                    field = b'"' + field + b'"'
                if normalize_dates:
                    field = _normalize_date(field)
                if force_quote and (not field or field[0] != _QUOTE):
                    # 未クォートフィールドをクォート（境界を正確に把握した上で処理）
                    field = b'"' + field.replace(b'"', b'""') + b'"'
                parts.append(field)
            col += 1

            # 区切り / 行末
            if i >= n:
                eol = b''
            elif data[i] == _COMMA:
                i += 1
            elif data[i] == _CR:
                if i + 1 < n and data[i + 1] == _LF:
                    eol = b'\r\n'; i += 2
                else:
                    eol = b'\r';   i += 1
            elif data[i] == _LF:
                eol = b'\n'; i += 1
            else:
                # 区切りでも行末でもない＝想定外の壊れ方。黙って壊さず件数を記録する
                if stats is not None:
                    stats['anomaly'] = stats.get('anomaly', 0) + 1
                eol = b'\n'; i += 1

        yield b','.join(parts) + eol


def split_csv(input_file, output_dir, base_name, max_size_mb, max_rows,
              drop_indices, encoding, normalize_dates, force_quote, progress_cb, done_cb):
    no_split = (max_size_mb == float("inf"))
    max_bytes = 2**62 if no_split else int(max_size_mb * 1024 * 1024)
    max_rows  = 2**62 if no_split else int(max_rows)
    drop_set  = set(drop_indices)

    try:
        # ── バイナリ一括読み込み（デコードなし） ──
        with open(input_file, 'rb') as f:
            data = f.read()
        total = len(data)

        stats = {}
        rows = _parse_rows(data, drop_set, normalize_dates, force_quote, stats)

        header_bytes = next(rows, None)
        if header_bytes is None:
            done_cb(True, "ファイルが空です"); return

        file_count = 1
        created = []
        fout = None
        cur_bytes = 0

        def open_next():
            nonlocal fout, cur_bytes, file_count
            if fout:
                fout.close()
            fname = os.path.join(
                output_dir,
                f"{base_name}.csv" if no_split else f"{base_name}_{file_count:03d}.csv"
            )
            created.append(fname)
            fout = open(fname, 'wb', buffering=WRITE_BUF)
            fout.write(header_bytes)
            cur_bytes = len(header_bytes)
            file_count += 1

        open_next()

        done_bytes = len(header_bytes)
        n_rows     = 0   # 総行数カウンタ（進捗用）
        cur_rows   = 0   # 現ファイルの行数

        for row_bytes in rows:
            rb = len(row_bytes)

            # サイズ超過 OR 行数上限 → 次ファイルへ（ヘッダーのみのファイルは作らない）
            if not no_split and cur_bytes > len(header_bytes) and (
                    cur_bytes + rb > max_bytes or cur_rows >= max_rows - 1):
                open_next()
                cur_rows = 0

            fout.write(row_bytes)
            cur_bytes += rb
            done_bytes += rb
            n_rows   += 1
            cur_rows += 1
            if n_rows % 300 == 0 and total > 0:
                progress_cb(min(done_bytes / total * 100, 99))

        if fout:
            fout.close()

        progress_cb(100)
        msg = f"{len(created)} ファイルを作成しました:\n" + \
              "\n".join(os.path.basename(f) for f in created)
        msg += f"\n\n読み込んだデータ行数: {n_rows:,}"
        if stats.get('fixed'):
            msg += f"\n囲みクォートを補ったフィールド: {stats['fixed']:,} 件"
        if stats.get('anomaly'):
            msg += f"\n★想定外の区切り: {stats['anomaly']:,} 件（行が割れている可能性あり）"
        done_cb(True, msg)

    except Exception as e:
        import traceback
        done_cb(False, traceback.format_exc())


# ──────────────────────────────────────────────
# GUI
# ──────────────────────────────────────────────
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("CSV 分割・列削除ツール")
        self.resizable(True, True)
        self.minsize(820, 600)
        self.geometry("960x750")
        self._build_ui()

    # ── レイアウト構築 ──────────────────────────
    def _build_ui(self):
        pad = {"padx": 8, "pady": 4}

        # ── 入力ファイル ──
        frm_in = ttk.LabelFrame(self, text="入力ファイル")
        frm_in.pack(fill="x", **pad)

        self.var_input = tk.StringVar()
        ttk.Entry(frm_in, textvariable=self.var_input).pack(
            side="left", padx=4, pady=6, fill="x", expand=True)
        ttk.Button(frm_in, text="参照…", command=self._browse_input).pack(
            side="left", padx=4, pady=6)

        # ── 出力先 ──
        frm_out = ttk.LabelFrame(self, text="出力先フォルダ")
        frm_out.pack(fill="x", **pad)

        self.var_outdir = tk.StringVar()
        ttk.Entry(frm_out, textvariable=self.var_outdir).pack(
            side="left", padx=4, pady=6, fill="x", expand=True)
        ttk.Button(frm_out, text="参照…", command=self._browse_outdir).pack(
            side="left", padx=4, pady=6)

        # ── 基本設定 ──
        frm_cfg = ttk.LabelFrame(self, text="分割設定")
        frm_cfg.pack(fill="x", **pad)
        frm_cfg.columnconfigure(1, weight=1)

        ttk.Label(frm_cfg, text="出力ファイル名（プレフィックス）:").grid(
            row=0, column=0, sticky="w", padx=8, pady=6)
        self.var_basename = tk.StringVar(value="goods_cs_split")
        ttk.Entry(frm_cfg, textvariable=self.var_basename, width=32).grid(
            row=0, column=1, sticky="w", padx=6, pady=6)
        ttk.Label(frm_cfg, text="→ 例: goods_cs_split_001.csv", foreground="gray").grid(
            row=0, column=2, sticky="w", padx=8)

        ttk.Label(frm_cfg, text="分割サイズ (MB):").grid(
            row=1, column=0, sticky="w", padx=8, pady=6)
        self.var_size = tk.DoubleVar(value=90.0)
        self.spn_size = ttk.Spinbox(frm_cfg, from_=1, to=2000, increment=1,
                    textvariable=self.var_size, width=10)
        self.spn_size.grid(row=1, column=1, sticky="w", padx=6, pady=6)

        ttk.Label(frm_cfg, text="最大行数 (行/ファイル):").grid(
            row=2, column=0, sticky="w", padx=8, pady=6)
        self.var_maxrows = tk.IntVar(value=100000)
        self.spn_rows = ttk.Spinbox(frm_cfg, from_=1000, to=10000000, increment=10000,
                    textvariable=self.var_maxrows, width=10)
        self.spn_rows.grid(row=2, column=1, sticky="w", padx=6, pady=6)
        ttk.Label(frm_cfg, text="※ サイズ上限・行数上限の両方で分割", foreground="gray").grid(
            row=2, column=2, sticky="w", padx=8)

        self.var_nosplit = tk.BooleanVar(value=False)
        ttk.Checkbutton(frm_cfg, text="分割しない（列削除のみ・1ファイルに出力）",
                        variable=self.var_nosplit,
                        command=self._toggle_split).grid(
            row=1, column=2, sticky="w", padx=8, pady=6)

        self.var_normalize_dates = tk.BooleanVar(value=True)
        ttk.Checkbutton(frm_cfg,
                        text="日時フォーマットを統一  YYYY/MM/DD HH:mm:ss → YYYY/MM/DD HH:mm（秒を除去）",
                        variable=self.var_normalize_dates).grid(
            row=3, column=0, columnspan=3, sticky="w", padx=8, pady=6)

        self.var_force_quote = tk.BooleanVar(value=True)
        ttk.Checkbutton(frm_cfg,
                        text="全フィールドをダブルクォートで囲む（キントーン取込み推奨）",
                        variable=self.var_force_quote).grid(
            row=4, column=0, columnspan=3, sticky="w", padx=8, pady=6)

        # ── 列選択 ──
        frm_col = ttk.LabelFrame(self, text="削除する列を選択（チェックを入れた列を削除）")
        frm_col.pack(fill="both", expand=True, **pad)
        frm_col.rowconfigure(1, weight=1)
        frm_col.columnconfigure(0, weight=1)

        # 全選択/解除ボタン + ヒント（上部）
        top_bar = ttk.Frame(frm_col)
        top_bar.grid(row=0, column=0, columnspan=2, sticky="ew", padx=4, pady=4)
        ttk.Button(top_bar, text="全選択", command=self._select_all).pack(side="left", padx=4)
        ttk.Button(top_bar, text="全解除", command=self._deselect_all).pack(side="left", padx=4)
        self.lbl_hint = ttk.Label(top_bar,
            text="← 入力ファイルを選択すると列一覧が表示されます", foreground="gray")
        self.lbl_hint.pack(side="left", padx=12)

        # スクロール付きチェックボックスエリア
        self.col_canvas = tk.Canvas(frm_col, highlightthickness=0)
        vscroll = ttk.Scrollbar(frm_col, orient="vertical",
                                command=self.col_canvas.yview)
        hscroll = ttk.Scrollbar(frm_col, orient="horizontal",
                                command=self.col_canvas.xview)
        self.col_canvas.configure(yscrollcommand=vscroll.set,
                                  xscrollcommand=hscroll.set)
        vscroll.grid(row=1, column=1, sticky="ns")
        hscroll.grid(row=2, column=0, sticky="ew")
        self.col_canvas.grid(row=1, column=0, sticky="nsew")

        self.col_frame = ttk.Frame(self.col_canvas)
        self.col_canvas_win = self.col_canvas.create_window(
            (0, 0), window=self.col_frame, anchor="nw")
        self.col_frame.bind("<Configure>", self._on_col_frame_configure)
        self.col_canvas.bind("<Configure>", self._on_canvas_configure)

        # マウスホイールでスクロール
        self.col_canvas.bind("<Enter>", self._bind_mousewheel)
        self.col_canvas.bind("<Leave>", self._unbind_mousewheel)

        self.col_vars = []   # (列名, BooleanVar)

        # ── 実行・進捗 ──
        frm_run = ttk.Frame(self)
        frm_run.pack(fill="x", padx=8, pady=6)

        self.btn_run = ttk.Button(frm_run, text="実行", command=self._run, width=14)
        self.btn_run.pack(side="right", padx=4)

        self.lbl_status = ttk.Label(frm_run, text="待機中", width=8)
        self.lbl_status.pack(side="right", padx=4)

        self.progress = ttk.Progressbar(frm_run, mode="determinate")
        self.progress.pack(side="left", padx=4, fill="x", expand=True)

    # ── ヘルパー ──────────────────────────────
    def _on_col_frame_configure(self, _event):
        self.col_canvas.configure(scrollregion=self.col_canvas.bbox("all"))

    def _on_canvas_configure(self, _event):
        # チェックボックスは自然幅のまま（横スクロールで対応）
        pass

    def _toggle_split(self):
        state = "disabled" if self.var_nosplit.get() else "normal"
        self.spn_size.configure(state=state)
        self.spn_rows.configure(state=state)

    def _bind_mousewheel(self, _event):
        self.col_canvas.bind_all("<MouseWheel>", self._on_mousewheel)

    def _unbind_mousewheel(self, _event):
        self.col_canvas.unbind_all("<MouseWheel>")

    def _on_mousewheel(self, event):
        self.col_canvas.yview_scroll(-1 * (event.delta // 120), "units")

    def _browse_input(self):
        path = filedialog.askopenfilename(
            title="CSVファイルを選択",
            filetypes=[("CSV ファイル", "*.csv"), ("すべて", "*.*")])
        if not path:
            return
        self.var_input.set(path)
        # 出力先を同フォルダに設定（未設定のとき）
        if not self.var_outdir.get():
            self.var_outdir.set(os.path.join(os.path.dirname(path), "split"))
        # ベース名を入力ファイル名から自動設定
        stem = os.path.splitext(os.path.basename(path))[0]
        self.var_basename.set(stem + "_split")
        # 列一覧を読み込む
        self._load_columns(path)

    def _browse_outdir(self):
        d = filedialog.askdirectory(title="出力先フォルダを選択")
        if d:
            self.var_outdir.set(d)

    def _load_columns(self, filepath):
        try:
            enc = detect_encoding(filepath)
            header = read_header(filepath, enc)
        except Exception as e:
            messagebox.showerror("エラー", f"ヘッダー読み込み失敗:\n{e}")
            return

        # 既存チェックボックスを消去
        for w in self.col_frame.winfo_children():
            w.destroy()
        self.col_vars.clear()

        COLS = 2  # 1行に並べる列数
        for idx, col in enumerate(header):
            bv = tk.BooleanVar(value=False)
            label = f"[{idx:02d}]  {col}" if col else f"[{idx:02d}]"
            cb = ttk.Checkbutton(self.col_frame, text=label, variable=bv)
            cb.grid(row=idx // COLS, column=idx % COLS, sticky="w",
                    padx=12, pady=3, ipadx=4)
            self.col_vars.append((col, bv))

        self.lbl_hint.configure(text=f"{len(header)} 列を読み込みました", foreground="gray")
        self._enc_cache = enc

    def _select_all(self):
        for _, bv in self.col_vars:
            bv.set(True)

    def _deselect_all(self):
        for _, bv in self.col_vars:
            bv.set(False)

    # ── 実行 ─────────────────────────────────
    def _run(self):
        input_file = self.var_input.get().strip()
        output_dir = self.var_outdir.get().strip()
        base_name  = self.var_basename.get().strip()

        if not input_file or not os.path.isfile(input_file):
            messagebox.showerror("エラー", "入力ファイルを正しく指定してください。")
            return
        if not output_dir:
            messagebox.showerror("エラー", "出力先フォルダを指定してください。")
            return
        if not base_name:
            messagebox.showerror("エラー", "出力ファイル名（プレフィックス）を入力してください。")
            return
        if self.var_nosplit.get():
            size_mb  = float("inf")
            max_rows = float("inf")
        else:
            try:
                size_mb = float(self.var_size.get())
                if size_mb <= 0:
                    raise ValueError
            except (ValueError, tk.TclError):
                messagebox.showerror("エラー", "分割サイズに正の数値を入力してください。")
                return
            try:
                max_rows = int(self.var_maxrows.get())
                if max_rows <= 0:
                    raise ValueError
            except (ValueError, tk.TclError):
                messagebox.showerror("エラー", "最大行数に正の整数を入力してください。")
                return

        os.makedirs(output_dir, exist_ok=True)

        drop_indices    = {i for i, (_, bv) in enumerate(self.col_vars) if bv.get()}
        enc             = getattr(self, "_enc_cache", "cp932")
        normalize_dates = self.var_normalize_dates.get()
        force_quote     = self.var_force_quote.get()

        self.btn_run.configure(state="disabled")
        self.progress["value"] = 0
        self.lbl_status.configure(text="処理中…")

        def progress_cb(pct):
            self.after(0, lambda: self._update_progress(pct))

        def done_cb(ok, msg):
            self.after(0, lambda: self._on_done(ok, msg))

        threading.Thread(
            target=split_csv,
            args=(input_file, output_dir, base_name, size_mb, max_rows,
                  drop_indices, enc, normalize_dates, force_quote, progress_cb, done_cb),
            daemon=True
        ).start()

    def _update_progress(self, pct):
        self.progress["value"] = pct
        self.lbl_status.configure(text=f"{pct:.0f}%")

    def _on_done(self, ok, msg):
        self.btn_run.configure(state="normal")
        if ok:
            self.progress["value"] = 100
            self.lbl_status.configure(text="完了")
            messagebox.showinfo("完了", msg)
        else:
            self.lbl_status.configure(text="エラー")
            messagebox.showerror("エラー", msg)


if __name__ == "__main__":
    app = App()
    app.mainloop()
