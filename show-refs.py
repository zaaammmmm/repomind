#!/usr/bin/env python3
"""Tampilkan baris yang dirujuk tiap acuan dataset, untuk diperiksa MANUAL oleh pemilik.
Pakai:  python3 show-refs.py ~/Downloads/ky ky.dataset.jsonl [--split test]
"""
import json, sys
root, ds = sys.argv[1], sys.argv[2]
split = sys.argv[sys.argv.index("--split") + 1] if "--split" in sys.argv else "all"
cache = {}
for line in open(ds, encoding="utf-8"):
    if not line.strip(): continue
    it = json.loads(line)
    if split != "all" and it["split"] != split: continue
    print(f"\n[{it['id']}] ({it['split']}/{it['type']}) {it['question']}")
    if not it["refs"]: print("   (tanpa acuan: pastikan istilahnya memang tidak ada -> grep -rniE 'istilah' source)")
    for r in it["refs"]:
        src = cache.setdefault(r["path"], open(f"{root}/{r['path']}", encoding="utf-8").read().split("\n"))
        for n in range(r["startLine"], r["endLine"] + 1):
            print(f"   {r['path']}:{n}: {src[n-1].strip()[:110]}")
