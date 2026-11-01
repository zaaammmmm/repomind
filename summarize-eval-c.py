#!/usr/bin/env python3
"""Ringkas hasil Eval C (dev): per varian dan tipe. Angka otomatis BUKAN penilaian kebenaran;
kolom nilai_manual (benar|sebagian|salah) diisi penulis dengan membuka baris yang disitir.
Pakai: python3 summarize-eval-c.py <folder hasil>   (membaca llm-dev-compact.csv dan llm-dev-default.csv)"""
import csv, io, sys, statistics as st
from collections import Counter, defaultdict
folder = sys.argv[1] if len(sys.argv) > 1 else "hasil"
TYPES = ["definition", "callers", "flow", "unanswerable"]
def num(x):
    try: return float(x)
    except (TypeError, ValueError): return None
def mean(v): return f"{st.mean(v):.2f}" if v else "-"
def read_rows(path):
    # tahan BOM (Excel/Windows) dan pemisah titik koma (Excel berlokal Indonesia menyimpan CSV dengan ';')
    text = open(path, encoding="utf-8-sig", newline="").read()
    head = text.split("\n", 1)[0]
    return list(csv.DictReader(io.StringIO(text, newline=""), delimiter=";" if head.count(";") > head.count(",") else ","))
for variant in ["compact", "default"]:
    try: rows = read_rows(f"{folder}/llm-dev-{variant}.csv")
    except FileNotFoundError: print(f"\n[{variant}] CSV belum ada"); continue
    print(f"\n==================== varian {variant}  (n={len(rows)}) ====================")
    status = Counter(r["status"] for r in rows)
    print("status:", dict(status))
    if any(s.startswith("error:") for s in status): print("  !! ada galat: jalankan ulang run-eval-c.sh (hanya galat yang diulang)")
    src = Counter(r["usage_source"] for r in rows if r["status"] == "answer")
    print("usage_source:", dict(src), "" if set(src) <= {"provider"} else " !! hanya 'provider' sah untuk Eval D")
    print(f"{'tipe':13} {'n':>2} {'jawab':>5} {'sitasi>0':>8} {'uncited':>7} {'ctx_ref':>7} {'cite_ref':>8} {'cite_rec':>8} {'tolak':>5} {'tolak_benar':>11} {'tolak_salah':>11} {'lat_s(med)':>10}")
    for t in TYPES:
        R = [r for r in rows if r["type"] == t]
        if not R: continue
        A = [r for r in R if r["status"] == "answer"]
        cites = sum(1 for r in A if (num(r["valid_cites"]) or 0) > 0)
        unc = sum(1 for r in A if r["uncited"] == "1")
        ctx = [num(r["context_has_ref"]) for r in R if r["context_has_ref"] != ""]
        cit = [num(r["cite_hits_ref"]) for r in R if r["cite_hits_ref"] != ""]
        rec = [num(r["cite_ref_recall"]) for r in R if r["cite_ref_recall"] != ""]
        refused = sum(1 for r in A if r["refused"] == "1")
        rc = [num(r["refused_correct"]) for r in R if r["refused_correct"] != ""]
        fr = [num(r["false_refusal"]) for r in R if r["false_refusal"] != ""]
        lat = [num(r["latency_ms"]) / 1000 for r in R if num(r["latency_ms"]) is not None]
        print(f"{t:13} {len(R):>2} {len(A):>5} {cites:>8} {unc:>7} {mean(ctx):>7} {mean(cit):>8} {mean(rec):>8} {refused:>5} {(f'{int(sum(rc))}/{len(rc)}' if rc else '-'):>11} {(f'{int(sum(fr))}/{len(fr)}' if fr else '-'):>11} {(f'{st.median(lat):.0f}' if lat else '-'):>10}")
    retr_fail = [r["id"] for r in rows if r["type"] != "unanswerable" and r["context_has_ref"] == "0"]
    print("kegagalan retrieval (acuan tidak ada di konteks):", retr_fail or "tidak ada")
    sc = Counter((r["type"], r["nilai_manual"]) for r in rows)
    unscored = [r["id"] for r in rows if not r["nilai_manual"].strip()]
    bad = [r["id"] for r in rows if r["nilai_manual"].strip() not in ("", "benar", "sebagian", "salah")]
    if bad: print("  !! nilai_manual tidak valid pada:", bad)
    if unscored: print(f"nilai_manual belum diisi: {len(unscored)} dari {len(rows)} ({', '.join(unscored)})")
    else:
        print("nilai_manual (benar/sebagian/salah):")
        for t in TYPES:
            c = {k: sc.get((t, k), 0) for k in ("benar", "sebagian", "salah")}
            if sum(c.values()): print(f"  {t:13} {c}")
print("\nCatatan: n sangat kecil (2-4 per tipe), satu run per varian, satu mesin; jangan dilaporkan sebagai hasil akhir. 'sitasi>0' hanya batas atas ketepatan.")
