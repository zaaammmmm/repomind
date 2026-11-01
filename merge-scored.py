#!/usr/bin/env python3
r"""
Gabungkan kembali nilai_manual + catatan yang hilang karena eval-llm.ts
menimpa llm-dev-*.csv saat dijalankan ulang (lihat Handoff Lanjutan,
bagian "Jebakan yang sudah ditemui").

Pemakaian:
  python merge-scored.py <csv_lama_berisi_nilai> <csv_baru_dari_run_terakhir> <csv_keluaran>

Contoh:
  python merge-scored.py llm-dev-compact.scored.csv hasil\llm-dev-compact.csv hasil\llm-dev-compact.scored.csv
  python merge-scored.py llm-dev-default.scored.csv hasil\llm-dev-default.csv hasil\llm-dev-default.scored.csv

Aturan:
- Baris dicocokkan berdasarkan kolom 'id'.
- Untuk id yang ada di kedua berkas: nilai_manual dan catatan diambil dari
  csv LAMA (jika csv lama punya isi di kolom itu), kolom lain (termasuk
  jawaban/sitasi/metrik) diambil dari csv BARU (hasil run terakhir, lebih akurat).
- Untuk id yang HANYA ada di csv baru (misalnya d14): dibiarkan kosong,
  dicetak sebagai peringatan di akhir -> itu yang masih harus dinilai manual.
- Tidak menimpa berkas input; keluaran ditulis ke path csv_keluaran.
"""
import csv
import sys


def read_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def main():
    if len(sys.argv) != 4:
        print("Pemakaian: python merge-scored.py <csv_lama> <csv_baru> <csv_keluaran>")
        sys.exit(1)
    old_path, new_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

    old_rows = {r["id"]: r for r in read_rows(old_path)}
    new_rows = read_rows(new_path)
    if not new_rows:
        print(f"GAGAL: {new_path} kosong atau tidak terbaca.")
        sys.exit(1)

    fieldnames = list(new_rows[0].keys())
    missing_manual = []
    restored = 0

    for row in new_rows:
        rid = row["id"]
        old = old_rows.get(rid)
        if old:
            old_manual = (old.get("nilai_manual") or "").strip()
            old_catatan = (old.get("catatan") or "").strip()
            if old_manual:
                row["nilai_manual"] = old_manual
                row["catatan"] = old_catatan
                restored += 1
        if not (row.get("nilai_manual") or "").strip():
            missing_manual.append(rid)

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(new_rows)

    print(f"Selesai. {restored} baris dipulihkan dari {old_path} -> {out_path}")
    if missing_manual:
        print(f"PERINGATAN: {len(missing_manual)} id belum punya nilai_manual (perlu dinilai manual): {', '.join(missing_manual)}")
    else:
        print("Semua baris sudah punya nilai_manual.")


if __name__ == "__main__":
    main()
