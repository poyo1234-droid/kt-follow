# -*- coding: utf-8 -*-
"""
goods_cs 2時点比較（検証用・集計のみ）

確かめること
  1. 販売日は、価格・価格タイプなどが変わったときに更新されるか
  2. 商品展開IDはキーとして使えるか（一意か／CS品番が変わってもIDは同じか）

使い方（Windows のコマンドプロンプト）
  python goods_cs_diff_check.py "<古い goods_cs.csv>" "<新しい goods_cs.csv>"

出力は件数のサマリのみ。ファイルは書き出さない。
末尾が「.0」の数値（例: 1000.0）は「1000」とみなして比較する。
"""
import csv
import struct
import sys
import time
import zlib
from collections import Counter

csv.field_size_limit(2**31 - 1)

SAMPLE_N = 5
# 変化した値の実例を表示する列（列名にこれらを含む列）
WATCH_WORDS = ('価格', 'タイプ', '品番', '販売', '表示')
# 見出しが変えられている列の対応（新ファイルの列名 -> 旧ファイルの列名）。見出しからの推定。
# 対応が正しいかは「対応付けた列の一致率」で確認する。
COL_ALIAS = {
    'カテゴリ(親)': '親カテゴリ',
    'カテゴリ(子)': '子カテゴリ',
    '商品タイプ(親)': '親商品タイプ',
    '商品タイプ(子)': '子商品タイプ',
    '販売価格': '販売価格（税抜）',
    '元上代': 'プロパー価格（税抜）',
}


def detect_encoding(path):
    with open(path, 'rb') as f:
        head = f.read(1_000_000)
    if head.startswith(b'\xef\xbb\xbf'):
        return 'utf-8-sig'
    try:
        head.decode('utf-8')
        return 'utf-8'
    except UnicodeDecodeError as e:
        if e.start >= len(head) - 3:  # 末尾で文字が切れただけ
            return 'utf-8'
        return 'cp932'


def norm(v):
    # "1000.0" と "1000" を同じ値として扱う（goods_cs_正.csv は価格が "1000.0" 形式のため）
    if v.endswith('.0') and v[:-2].lstrip('-').isdigit():
        return v[:-2]
    return v


def find_col(header, label, exact, contains_all):
    hits = [i for i, h in enumerate(header) if h in exact]
    if not hits:
        hits = [i for i, h in enumerate(header) if all(k in h for k in contains_all)]
    if len(hits) != 1:
        print(f'[停止] 「{label}」の列を1つに特定できません（候補 {len(hits)} 件）。見出し一覧:')
        for i, h in enumerate(header):
            print(f'  {i:3d}: {h}')
        sys.exit(1)
    return hits[0]


def load(path, tag):
    enc = detect_encoding(path)
    t0 = time.time()
    with open(path, newline='', encoding=enc, errors='replace') as f:
        r = csv.reader(f)
        header = [h.strip() for h in next(r)]
        header = [COL_ALIAS.get(h, h) for h in header]
        c_id = find_col(header, '商品展開ID', ['商品展開ID'], ['商品展開ID'])
        c_cs = find_col(header, 'CS品番', ['CS品番', 'CS別品番'], ['CS', '品番'])
        c_dt = find_col(header, '販売日', ['販売日', '販売開始日'], ['販売日'])
        watch = [i for i, h in enumerate(header) if any(w in h for w in WATCH_WORDS)]
        ncol = len(header)
        fmt = f'<{ncol}I'
        crc = {}    # 商品展開ID -> 全列のCRC32を詰めたbytes
        vals = {}   # 商品展開ID -> {列番号: 値}（WATCH列のみ）
        n = bad = blank = 0
        dup = Counter()
        first = []
        for row in r:
            n += 1
            if n % 100_000 == 0:
                print(f'  [{tag}] {n:,} 行 読込中… ({time.time() - t0:.0f}秒)')
            if len(row) != ncol:
                bad += 1
                continue
            k = norm(row[c_id].strip())
            if not k:
                blank += 1
                continue
            if k in crc:
                dup[k] += 1
                continue
            if len(first) < 3:
                first.append((row[c_id], row[c_cs]))
            row = [norm(v) for v in row]
            crc[k] = struct.pack(fmt, *(zlib.crc32(v.encode('utf-8', 'replace')) for v in row))
            vals[k] = {i: row[i] for i in watch}
    cs_count = Counter(v[c_cs].strip() for v in vals.values())
    cs_dup = sum(1 for c, m in cs_count.items() if c and m > 1)
    print(f'■ {tag}: {path}')
    print(f'  文字コード={enc} / 列数={ncol} / データ行={n:,} / 読込{time.time() - t0:.0f}秒')
    print(f'  使用列: 商品展開ID=[{header[c_id]}]  CS品番=[{header[c_cs]}]  販売日=[{header[c_dt]}]')
    print(f'  列数不正で除外={bad:,} / 商品展開ID空欄={blank:,} / 商品展開ID重複(2件目以降)={sum(dup.values()):,}（ID {len(dup):,}種）')
    print(f'  CS品番が重複している値={cs_dup:,}種')
    print('  先頭3行の実例（商品展開ID / CS品番、加工前の値）:')
    for x, y in first:
        print(f'    「{x}」 / 「{y}」')
    cs2id = {v[c_cs].strip(): k for k, v in vals.items() if v[c_cs].strip()}
    return dict(header=header, fmt=fmt, crc=crc, vals=vals, c_cs=c_cs, c_dt=c_dt, cs2id=cs2id)


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    A = load(sys.argv[1], '旧')
    B = load(sys.argv[2], '新')

    ha, hb = A['header'], B['header']
    common_cols = [(h, ha.index(h), hb.index(h)) for h in dict.fromkeys(ha) if h in hb]
    only_a = [h for h in ha if h not in hb]
    only_b = [h for h in hb if h not in ha]

    ids_a, ids_b = set(A['crc']), set(B['crc'])
    common = ids_a & ids_b
    print('\n■ 商品展開IDの突合')
    print(f'  共通={len(common):,} / 旧のみ={len(ids_a - ids_b):,} / 新のみ={len(ids_b - ids_a):,}')
    if only_a or only_b:
        print(f'  見出しの差（対応表で揃えた後）: 旧のみ={only_a} / 新のみ={only_b}')

    cs_common = set(A['cs2id']) & set(B['cs2id'])
    same_id = [c for c in cs_common if A['cs2id'][c] == B['cs2id'][c]]
    print('\n■ CS品番での突合（商品展開IDの一致確認）')
    print(f'  CS品番の共通={len(cs_common):,} / うち商品展開IDも一致={len(same_id):,} / 不一致={len(cs_common) - len(same_id):,}')
    for c in [c for c in cs_common if A['cs2id'][c] != B['cs2id'][c]][:SAMPLE_N]:
        print(f'    CS品番={c} : 旧ID「{A["cs2id"][c]}」 新ID「{B["cs2id"][c]}」')

    if len(common) >= len(cs_common) / 2:
        pairs = [(k, k) for k in common]
        print('\n→ 以下の比較は商品展開IDをキーにする')
    else:
        pairs = [(A['cs2id'][c], B['cs2id'][c]) for c in cs_common]
        print('\n→ 商品展開IDで突き合わないため、以下の比較はCS品番をキーにする（「CS品番が変わった行」は検出できない）')

    changed = Counter()
    changed_with_dt = Counter()
    samples = {}
    any_changed = dt_changed = changed_no_dt = cs_changed = 0
    cs_samples = []
    dt_samples = []
    wa = {h: i for h, i, _ in common_cols}
    for ka, kb in pairs:
        k = kb
        a = struct.unpack(A['fmt'], A['crc'][ka])
        b = struct.unpack(B['fmt'], B['crc'][kb])
        va, vb = A['vals'][ka], B['vals'][kb]
        dt_a, dt_b = va[A['c_dt']], vb[B['c_dt']]
        dtc = dt_a != dt_b
        if dtc and len(dt_samples) < 10:
            dt_samples.append((k, vb[B['c_cs']], dt_a, dt_b))
        cs_a, cs_b = va[A['c_cs']].strip(), vb[B['c_cs']].strip()
        if cs_a != cs_b:
            cs_changed += 1
            if len(cs_samples) < SAMPLE_N:
                cs_samples.append((k, cs_a, cs_b, dt_a, dt_b))
        row_changed = False
        for h, ia, ib in common_cols:
            if a[ia] != b[ib]:
                row_changed = True
                changed[h] += 1
                if dtc:
                    changed_with_dt[h] += 1
                elif ia in va and ib in vb:
                    s = samples.setdefault(h, [])
                    if len(s) < SAMPLE_N:
                        s.append((k, vb[B['c_cs']], dt_b, va[ia], vb[ib]))
        if row_changed:
            any_changed += 1
            if dtc:
                dt_changed += 1
            else:
                changed_no_dt += 1

    print('\n■ 比較した行のうち、何かが変わった行')
    print(f'  変化あり={any_changed:,}（うち販売日も変化={dt_changed:,} / 販売日は不変={changed_no_dt:,}）')

    print(f'\n■ 列別の変化件数（比較した行={len(pairs):,}、多い順）')
    print('  列名 | 変化件数 | 一致率 | うち販売日も変化 | 販売日は不変')
    for h, _, _ in sorted(common_cols, key=lambda t: -changed[t[0]]):
        c = changed[h]
        rate = (1 - c / len(pairs)) * 100 if pairs else 0
        print(f'  {h} | {c:,} | {rate:.1f}% | {changed_with_dt[h]:,} | {c - changed_with_dt[h]:,}')

    print('\n■ 販売日が変わらずに値が変わった実例（価格・タイプ・品番・販売・表示を含む列、各最大5件）')
    for h, s in samples.items():
        print(f'  [{h}]')
        for k, cs, dt, x, y in s:
            print(f'    商品展開ID={k} CS品番={cs} 販売日={dt} : 「{x}」→「{y}」')

    print('\n■ 販売日が変わった行の実例（最大10件）')
    for k, cs, x, y in dt_samples:
        print(f'    商品展開ID={k} CS品番={cs} : 「{x}」→「{y}」')

    print('\n■ 同じ商品展開IDでCS品番が変わった行')
    print(f'  件数={cs_changed:,}')
    for k, x, y, d1, d2 in cs_samples:
        print(f'    商品展開ID={k} : 「{x}」→「{y}」 販売日 {d1}→{d2}')


if __name__ == '__main__':
    main()
