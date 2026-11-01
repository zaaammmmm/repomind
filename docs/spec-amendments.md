# Koreksi spesifikasi (ditemukan saat implementasi)

## A-01: id simbol harus stabil saat replaceFile (memengaruhi FR-UPD-04, bagian 3.3, NFR-R-01)

**Masalah.** Dokumen menyatakan: bila export_surface_hash tidak berubah, dependen tidak perlu disentuh.
Namun skema menyimpan `symbol_refs.target_symbol_id` (FK ke symbols.id, ON DELETE SET NULL).
Jika `replaceFile` menghapus semua simbol file lalu menyisipkan ulang, id berubah dan seluruh referensi dari dependen
menjadi NULL, walau permukaan ekspor sama. Akibatnya klaim "dependen tidak disentuh" salah, atau indeks tidak identik dengan rebuild.

**Keputusan.** `replaceFile` melakukan upsert simbol berdasarkan kunci alami (qualified_name, kind, urutan kemunculan):
UPDATE bila cocok (id dipertahankan), INSERT bila baru, DELETE bila hilang.
- Simbol yang hilang dan diekspor mengubah export_surface_hash, sehingga dependen di-rebind (sesuai spesifikasi).
- Simbol non-ekspor yang hilang tidak dirujuk dependen, sehingga aman.
- Canonical dump memakai kunci alami, bukan id, jadi kesetaraan dengan rebuild tetap terjaga.

**Uji yang wajib ada (iterasi 2).** Uji properti: ubah isi fungsi tanpa mengubah ekspor, lalu pastikan `symbol_refs` dependen tidak berubah (nilai target_symbol_id sama) dan canonical dump sama dengan rebuild.

## A-02: perilaku Analyzer iterasi 1 yang menyimpang atau menyempitkan spesifikasi
- Penggabungan deklarasi kecil bersebelahan (bagian 3.4) belum diimplementasikan.
- Anggota namespace, interface, dan enum tidak dijadikan simbol terpisah.
- Pengikatan referensi mengabaikan shadowing: nama lokal yang sama dengan nama import atau deklarasi tingkat atas tetap dicatat.
- Chunk header (import dan pernyataan non-deklarasi) memakai rentang baris dari pernyataan pertama sampai terakhir, sehingga rentangnya bisa mencakup deklarasi di antaranya.
- Chunk header dipotong pada anggaran token; sisanya tidak diindeks.

## A-03: batas Scanner dan Resolver iterasi 1
- **Self-reference dan paket workspace** (mis. `import ky from 'ky'` di dalam repo `ky`, atau paket monorepo yang tertaut lewat node_modules)
  tercatat sebagai `external`, bukan `resolved` ke file sumbernya. Pada repo `ky` ini terjadi 21 kali. Akibatnya graf dependensi tidak
  menyertakan sisi lintas-paket monorepo. Perbaikan yang mungkin: petakan nama paket dari package.json setiap workspace ke folder sumbernya.
- **Aset** (`./style.css`, `./logo.svg`, `./data.json`) akan tercatat `unresolved`. Perlu kategori tersendiri agar tidak mengotori status indeks.
- **File ada tetapi tidak diindeks** (mis. `.d.ts`, file terkecualikan) tercatat `unresolved`.
- **Resolve ulang saat file baru muncul**: `unresolvedMatching(path)` di IndexStore cukup meresolve ulang SEMUA import berstatus unresolved
  (jumlahnya kecil). `triedPaths` belum disimpan di skema; bisa jadi optimisasi bila ternyata mahal.
- tsconfig dipilih berdasarkan tsconfig terdekat menurut direktori; `include`/`exclude` dan `references` tidak dipertimbangkan.
- Pola exclude memakai sintaks .gitignore (paket `ignore`); `*.env` hanya cocok untuk nama file berakhiran .env, bukan `.env.local`.
  Disarankan menambah `.env*` ke pola bawaan. Karena scanner hanya mengindeks .ts/.tsx, ini baru berdampak bila ada berkas aneh bernama `*.env.ts`.

## A-04: rantai re-export (barrel) dan sisi graf (memperbaiki bagian 3.3 dan skema)
- `export ... from` dan `export *` adalah sisi graf file. `v_file_edges` sekarang = import resolved UNION re-export resolved, sehingga fan-in dan analisis dampak tidak melewatkan file barrel.
- Skema: kolom baru `exports.source_name` (nama asli pada re-export bernama `export { a as b } from`). `ExportFact.sourceName` ditambahkan; nilainya masuk `export_surface_hash`.
- Bila permukaan ekspor F berubah, yang harus ditautkan ulang adalah pengimpor F ditambah pengimpor dari setiap file barrel yang me-re-export F, secara transitif (`dependentClosure`).
- Teks header chunk tidak lagi memuat nama file (`ftsName` kosong), agar memindahkan file tidak membutuhkan parse ulang.

## A-05: urutan relink pada jalur edit-saja (bug ditemukan uji properti, seed 868397970)
`replaceFile` mereset tautan (import, re-export, target referensi) file yang diedit. Rantai dependen tidak boleh dihitung sebelum tautan itu dipulihkan,
atau sisi `barrel -> sumber` belum ada dan pengimpor barrel terlewat. Urutan yang benar:
1. parse dan `replaceFile` semua file yang diedit; 2. `relink(file yang diedit)`; 3. hitung `dependentClosure` untuk file yang permukaannya berubah; 4. `relink(dependen)`.
Pemicu tidak terdeteksi pada 150 skenario acak; baru muncul pada 1.000. **Jalankan uji properti dengan jumlah besar di CI** (`PROP_RUNS=1000`).
Uji regresi: `orchestrator.test.ts` "regresi A-05".

## A-06: catatan hasil pengukuran awal (repo `ky`, 98 file, mesin pengembangan, BUKAN hasil Eval A)
`npm run bench-update -w @repomind/core -- <repo>`: edit isi 25 sampai 65 ms; ubah permukaan ekspor pada file hub (36 dependen) sekitar 42 ms; tambah/pindah/hapus 50 sampai 110 ms
(relink semua tanpa parse); simpan tanpa perubahan isi sekitar 3 ms; rebuild penuh dalam memori 450 sampai 700 ms. Semua skenario setara dengan rebuild (canonical dump identik).
Durasi mencakup pemindaian, hashing, dan klasifikasi. Satu mesin, belum ada pengulangan statistik, belum ada pemanasan terpisah.
Tambah/pindah/hapus masih melakukan relink seluruh repo; optimasi (mis. memakai triedPaths) hanya dilakukan bila terukur perlu dan tetap dijaga uji properti.

## A-07: ringkasan dihitung langsung dari indeks (menyempitkan FR-SUM-04, bagian 3.7)
`DeterministicSummary` menghitung semua bagian dari SQL setiap kali dipanggil. Hasilnya fungsi murni dari isi indeks, jadi tidak pernah usang dan tidak butuh
invalidasi. Tabel `summary_sections` dan `summary_section_sources` belum dipakai. Cache baru dibutuhkan untuk perhalusan LLM (kunci memuat hash sumber) atau bila pengukuran
menunjukkan perhitungan terlalu lambat pada repo besar. Titik masuk dipetakan dari `package.json` dengan pencocokan sufiks (folder build apa pun), bukan daftar nama tetap.

## A-08: batas dan keputusan Router Mode 1 (bagian 3.6)
- Klasifikasi memakai aturan regex berurutan: IMPACT, MODULE_EXPORTS, DIR_FUNCTIONS, COMPONENT_USES, FILE_DEPENDENTS, USAGES, DEFINITION. Urutan menentukan hasil bila beberapa aturan cocok.
- **Tabel klasifikasi di `qa.test.ts` ditulis bersama aturannya, sehingga akurasi 100% di sana tidak boleh dilaporkan sebagai hasil.** Akurasi intent yang sah hanya dari set pertanyaan independen (Eval C, dev/test split).
- Satu pertanyaan hanya diproses untuk satu entitas (kandidat slot pertama yang terselesaikan). Pertanyaan dengan dua entitas ("hubungan A dan B") tidak didukung.
- Slot memakai daftar stopword Indonesia dan Inggris; simbol yang namanya sama dengan stopword (mis. `list`, `file`) hanya dapat ditanyakan dengan tanda kutip atau backtick.
- `USAGES` menghitung baris referensi, bukan lokasi unik; satu ekspresi dapat tercatat dua kali (mis. jenis `type` dan `call` pada `new X<T>()`). Pemakaian lewat `obj.method` tidak terlacak (A-03, T-05).
- `IMPACT` adalah batas atas (penutup transitif graf impor/re-ekspor), bukan analisis perubahan semantik.
- `DIR_FUNCTIONS` menyertakan arrow function yang di-assign ke const; method dan komponen tidak dihitung.
- Bukti parsial pada penolakan NEEDS_LLM hanya dari (a) literal angka 3 digit atau lebih lewat FTS dan (b) identifier eksplisit; kata biasa tidak dicari (terlalu bising).
- Intent tidak toleran salah ketik pada kata kerja; salah ketik hanya ditoleransi pada nama simbol/file (saran jarak edit).
- Bahasa: Indonesia dan Inggris. Pertanyaan yang memakai bahasa lain jatuh ke UNSUPPORTED.

## A-09: Retriever hybrid, keputusan dan batas (bagian 3.5)
Kebijakan yang diubah dari spesifikasi awal setelah dicoba pada repo nyata (koreksi logika, bukan penyetelan bobot):
- **Definisi dipaksa masuk hanya untuk identifier eksplisit** (huruf besar-kecil persis dan token bukan kata huruf kecil biasa, atau diberi backtick). Kata umum seperti `request`
  yang cocok banyak simbol hanya mendapat skor lebih rendah (0,9; atau 0,6 bila lebih dari 3 simbol) dan tunduk pada anggaran token. Label alasan: "cocok persis", "bernama", "mirip".
- **Chunk header** (import dan pernyataan non-deklarasi) dibuang dari hasil teks kecuali memuat `export` (barrel).
- **Penggabungan hanya untuk rentang bersebelahan persis** (`mulai == akhir sebelumnya + 1`). Baris celah tidak ada di teks chunk, dan chunk member kelas memakai awalan sintetis,
  sehingga penggabungan longgar membuat teks tidak selaras dengan rentang baris (ditemukan lewat uji).
- Opsi `testPenalty` (pengali skor berkas uji, bawaan 1 = nonaktif). Hasil di repo `ky` menunjukkan berkas uji sering menyelip, tetapi manfaatnya baru boleh diklaim setelah ablasi di Eval B.

Batas yang diketahui:
- Bobot awal (BM25 5/2/1; RRF k=60, teks 1,0, simbol 1,5, graf 0,7; peluruhan graf 0,5; 5 seed) BELUM disetel. Penyetelan hanya di split dev Eval B. Pengamatan di `ky` bersifat anekdot, bukan evaluasi.
- Ekspansi graf hanya satu hop (pemanggil dan callee langsung); hop kedua belum ada.
- Tidak ada stemming atau normalisasi morfologi (retries tidak cocok dengan retry; membuat tidak cocok dengan dibuat). Kecocokan awalan simbol dapat memenuhi hasil dengan simbol yang namanya hanya mirip (mis. kueri retry menarik requestMethods).
- Petunjuk path pada kueri hanya bekerja lewat kolom `path` FTS, belum ada boost khusus.
- `perSourceCounts` = jumlah kandidat per sumber sebelum pengemasan.
- Ukuran awal (repo `ky`, 98 file, satu mesin, bukan hasil Eval B): latensi retrieval p50 1,1 ms, p95 2,3 ms, maks 5,6 ms (target NFR-P-04: p95 maksimum 300 ms).

## A-10: Context Builder dan gerbang privasi (bagian 3.8, FR-PRV-01, 03, 04; Iterasi 4)
- **Kontrak.** `ContextBuilder.buildPrompt(question, approved: ContextPreview)` menerima pratinjau yang tidak memuat teks. Implementasi (`DefaultContextBuilder`) menyimpan teks yang sudah diredaksi di `WeakMap` berkunci objek pratinjau hasil `prepare()`. Akibatnya isi yang dikirim selalu sama dengan yang dilihat dan disetujui; pratinjau buatan lain ditolak (galat). Pratinjau tidak boleh disalin ulang (mis. lewat JSON) sebelum `buildPrompt`; host menyimpan objeknya per `requestId`.
- **Lantai pengecualian (`NEVER_SEND`).** DEFAULT_EXCLUDE ditambah `.env*`, `*.key`, `**/id_rsa*`, `**/id_ed25519*`, `*.p12`, `*.pfx` selalu berlaku saat penyaringan pra-kirim, walau pengguna mengedit atau mengosongkan `repomind.exclude`. Pola pengguna ditambahkan di atasnya. Ini memperluas FR-PRV-03 (pola dapat diedit) dengan batas bawah yang tidak dapat dicabut.
- **Anggaran token ditegakkan ulang** setelah redaksi, menurut skor tertinggi, karena retriever dapat memasukkan definisi paksa melampaui anggaran (A-09) dan redaksi mengubah ukuran. Jumlah yang dibuang dilaporkan (`droppedBudget`, `droppedExcluded`).
- **Redaksi (`redactSecrets`) best-effort, bukan jaminan.** Pola berprefiks (private key, AWS, GitHub, Slack, Google, `sk-`, JWT, Bearer) ditambah penugasan bernama rahasia (secret, password, token, apikey, credential) dengan nilai literal berpanjang minimal 8, entropi minimal 3,0 bit/karakter, dan bercampur kelas karakter; placeholder, template `${}`, dan URL dilewati. Jumlah baris dipertahankan agar sitasi baris tetap selaras. Rahasia pendek, berentropi rendah, atau tanpa nama penanda akan lolos. Celah yang ditemukan uji: anotasi tipe (`password: string = '...'`) semula lolos; diperbaiki.
- **Persetujuan.** Wajib untuk penyedia `cloud` dan endpoint non-loopback; tidak wajib untuk Ollama di loopback (tidak ada data keluar perangkat). Melewati dialog hanya lewat `skipConsent()` (jangan tanya lagi, dapat dicabut).
- **Konteks kosong** (semua potongan tersaring atau tidak ada hasil) tidak memanggil LLM, agar model tidak menjawab tanpa dasar. Ini menyempitkan bagian 3.8 yang hanya menyatakan "katakan tidak cukup" pada tingkat prompt.
- **Batas pembuktian.** Uji hanya membuktikan bahwa teks injeksi berada di dalam blok data bernonce dan bahwa instruksi pertahanan ada di prompt. Apakah model benar-benar mengabaikan injeksi hanya dapat diukur dengan LLM sungguhan (Eval C, set fixture injeksi); jangan diklaim dari uji unit.

## A-11: Adapter LLM (bagian 3.9, ADR-05, FR-LLM-01..04)
- Satu `OpenAICompatibleProvider` (`/chat/completions`) untuk Ollama (`http://localhost:11434/v1`) dan cloud kompatibel. Temperature bawaan 0. Streaming memakai SSE dengan `stream_options.include_usage`.
- Retry hanya untuk 429 (menghormati `Retry-After`, maksimum 10 detik) dan 5xx; maksimum 2 kali; backoff eksponensial dengan jitter. 4xx lain tidak diulang. Streaming hanya diulang sebelum token pertama.
- Timeout per percobaan; untuk streaming berlaku sebagai **batas diam antar-potongan**, bukan batas total (jawaban panjang tidak dipotong selama masih mengalir).
- `LlmUsage.usageSource` baru: `'provider'` bila usage dari respons penyedia, `'estimated'` (karakter/4) bila tidak. **Hanya `provider` yang sah untuk Eval D**; Ollama versi lama atau penyedia tertentu dapat tidak melaporkan usage pada streaming. Hasil dengan `estimated` harus dikecualikan atau dilaporkan terpisah.
- `LlmError.suggestion` baru (saran tindakan, FR-LLM-03). Pesan galat memuat paling banyak 160 karakter badan respons; kunci tidak pernah dimasukkan oleh adapter.
- Endpoint non-loopback wajib `https` (konstruktor menolak). Kunci hanya dikirim lewat header `Authorization`.
- Biaya = token x tarif isian pengguna; tanggal tarif dicatat oleh peneliti pada lembar eksperimen (belum otomatis).
- **Belum diuji terhadap Ollama atau penyedia cloud sungguhan.** Kompatibilitas terbukti terhadap server HTTP uji yang meniru format; pemilihan penyedia final (T-11) masih terbuka.

## A-12: Validator sitasi lebih ketat (FR-LLM-06)
Bentuk yang menyerupai sitasi tetapi bukan format baku (`[F1:3]`, `[F1:3-4, F2:5-6]`, `[F1: 3-4]`, en dash) kini ditandai `(format sitasi tidak valid)` dan tidak dihitung sebagai sitasi. Sebelumnya lolos diam-diam sebagai teks biasa sehingga ketepatan sitasi bisa terlihat lebih baik daripada kenyataan. `LlmQaService` juga melaporkan `uncited` (jawaban tanpa satu pun sitasi valid) dan jumlah sitasi tidak terverifikasi. Validator tidak dapat mendeteksi pernyataan faktual yang tidak disertai sitasi; itu dinilai manusia pada Eval C.

## A-13: Varian prompt untuk model kecil dan penanda ringkas (Iterasi 4, temuan uji awal)
Uji awal dengan Qwen2.5-Coder 3B (CPU) pada empat pertanyaan menghasilkan 0 jawaban bersitasi valid: id salah (`K1`), nama berkas sebagai pengganti id, bentuk `[F6]`, bahasa Inggris pada pertanyaan berbahasa Indonesia, dan penolakan "konteks tidak cukup" tidak dipatuhi. Ditambahkan: (1) `promptVariant: 'compact'` (instruksi Inggris pendek, satu contoh format, pertanyaan di akhir; bawaan tetap `default`); (2) `maxOutputTokens` opsional; (3) validator menandai sitasi berawalan selain F (`[K1:8-9]`, `[Ky.ts:3-4]`) sebagai format tidak valid tanpa menyentuh indeks array biasa. Varian bukan klaim perbaikan: efeknya harus diukur A/B pada set dev terpisah dari set test.

## A-14: Alat evaluasi dan koreksi pemetaan galat (Iterasi 4)
- Skrip `eval-retrieval` (Eval B tanpa LLM: hit, recall, MRR, token per tipe dan K, dengan dan tanpa gerbang) dan `eval-llm` (Eval C bertahap, dapat dilanjutkan, CSV dengan kolom otomatis dan kolom `nilai_manual`). Dataset JSONL divalidasi terhadap repo (berkas ada, rentang sah). Aturan dev/test di `eval/README.md`.
- Kolom `context_has_ref` memisahkan kegagalan retrieval dari kegagalan model. `cite_hits_ref` dan `cite_ref_recall` adalah proksi otomatis yang lebih kuat daripada "sitasi valid", tetapi tetap bukan pengganti penilaian manual.
- Perbaikan adapter: respons HTTP 200 yang tidak dapat dibaca (bukan JSON/SSE) kini `PROVIDER_ERROR` dengan pesan yang menunjuk endpoint, sebelumnya salah dilaporkan `OFFLINE`. Ditemukan saat menguji `eval-llm` terhadap server tiruan.
- Hanya galat sementara (`error:*`) yang diulang saat melanjutkan; baris terakhir per (id, konfigurasi) menang di CSV.
- Pengamatan awal (eksploratif, set dev kecil, bukan hasil): pada pertanyaan `callers`, `maxChunksPerFile=3` membatasi pemanggil dalam satu berkas besar. Perlu ablasi pada dataset yang lebih besar sebelum bobot atau bawaan diubah.

### A-15: Butir dataset beracuan tidak lengkap dikecualikan dari metrik utama (alat evaluasi)
- **Temuan.** Pada `ky` (commit 3541888), pertanyaan dev d05 ("Di mana TimeoutError dibuat atau dilempar?") hanya mendaftar 3 dari 15 lokasi `new TimeoutError(...)`, padahal aturan dataset mewajibkan semua lokasi untuk tipe `callers`. Recall d05 di Eval B eksploratif (sebelumnya "0 dari 3") karena itu tidak dapat ditafsirkan.
- **Keputusan.** d05 dipertahankan tanpa perubahan `refs` (aturan 4), diberi `incomplete_refs: true` dan `note`, dan dikecualikan dari metrik utama. Butir baru d13 (pertanyaan sama) memuat seluruh 15 lokasi sebagai acuan. Hasil historis d05 tidak diubah; `--include-incomplete` mereproduksinya.
- **Perubahan alat.** `loadDataset` (eval-common.ts) menerima parameter `includeIncomplete` (bawaan: false), memvalidasi bahwa `incomplete_refs` hanya `true` dan disertai `note`, dan mencetak id yang dikecualikan. `eval-retrieval` dan `eval-llm` menerima `--include-incomplete`.
- **Batas.** Dengan K=8 dan `maxChunksPerFile=3`, d13 secara struktural sulit mencapai recall penuh (14 dari 15 lokasi ada di `Ky.ts`); laporkan d13 secara terpisah dan jangan menyetel `maxChunksPerFile` dari satu pertanyaan ini. Pengecualian ini hanya pengaman pelaporan, bukan bukti tentang kualitas retriever. Metrik presisi belum ada di `eval-retrieval` (hanya hit, recall, MRR, token).
