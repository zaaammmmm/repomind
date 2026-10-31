# Dataset evaluasi (Eval B dan C)

Format: JSONL, satu pertanyaan per baris.

```
{"id":"d04","split":"dev","type":"callers","question":"...","refs":[{"path":"source/core/Ky.ts","startLine":493,"endLine":493}]}
```

- `type`: `definition` (di mana X didefinisikan), `callers` (siapa memanggil X / di mana X dipakai), `flow` (alur lintas berkas), `unanswerable` (jawabannya tidak ada di repo; `refs` harus `[]`).
- `refs`: rentang berkas:baris yang **harus** ada pada jawaban yang benar. Untuk `callers`, daftarkan **semua** lokasi (dapatkan dengan `grep -rn`). Rentang boleh satu baris; sebuah potongan dianggap mencakup acuan bila rentangnya bertumpang tindih.
- Skrip memvalidasi dataset: berkas harus ada dan rentang tidak boleh melewati panjang berkas.
- Opsional `incomplete_refs: true` + `note` (wajib): acuan butir itu diketahui tidak lengkap. Butir tetap ada dan `refs`-nya tidak diubah (aturan 4), tetapi **dikecualikan dari metrik utama** `eval-retrieval` dan `eval-llm`. Tambahkan `--include-incomplete` hanya untuk membandingkan dengan hasil historis; jangan dilaporkan sebagai metrik utama. Perbaikannya berupa butir baru dengan id baru dan acuan lengkap (A-15).

## Aturan agar hasil sah
1. **dev** boleh dipakai menyetel prompt, K, anggaran, dan bobot. **test** dilarang dilihat hasil modelnya saat menyetel; tulis seluruh pertanyaan dan acuan test **sebelum** menjalankan model, lalu bekukan (commit).
2. Tulis acuan dari membaca kode (`grep`, buka berkas), bukan dari jawaban model.
3. Sebarkan tipe dan area repo. Saran awal: 12 dev + 12 test, masing-masing 3 `definition`, 4 `callers`, 3 `flow`, 2 `unanswerable`.
4. Jangan ubah pertanyaan atau acuan setelah ada hasil; bila salah, tambahkan versi baru dengan id baru dan catat alasannya.
5. Penilaian `nilai_manual` (benar/sebagian/salah) dilakukan dengan membuka baris yang disitir. Sitasi valid secara format bukan bukti jawaban benar.

## Perintah
```
# Eval B: tanpa LLM, cepat
npm run eval-retrieval -w @repomind/core -- /path/ky eval/data/ky.dev.template.jsonl --split dev --k 5,8,12 --budget 3000 --mcpf 3 --out hasil/retrieval-dev.csv
# Eval C: dengan LLM, dapat dilanjutkan (jalankan ulang dengan --out yang sama)
LLM_PROVIDER=ollama LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen25c3b-8k \
K=8 TOKEN_BUDGET=3000 PROMPT_VARIANT=compact MAX_TOKENS=200 LLM_TIMEOUT_MS=400000 \
npm run eval-llm -w @repomind/core -- /path/ky eval/data/ky.dev.template.jsonl --split dev --out hasil/llm-dev-compact.jsonl
```
Kolom `context_has_ref` membedakan kegagalan retrieval (acuan tidak ada di konteks) dari kegagalan model (acuan ada tetapi jawaban salah).
