# ADR-02 spike: better-sqlite3 di VS Code

Status: Sebagian terbukti (Node 22, Linux x64). **Belum terbukti di Electron milik VS Code.**

## Terbukti (npm run spike:sqlite)
- better-sqlite3 terpasang dan jalan; SQLite 3.49; FTS5 aktif; WAL aktif.
- 20.000 file+chunk+FTS dalam satu transaksi: sekitar 0,3 detik; query FTS di bawah 1 ms.
- Cascade hapus file dan trigger pembersih FTS bekerja.

## Belum terbukti (wajib sebelum ADR-02 final)
1. Muat modul di extension host VS Code (ABI Electron berbeda dari Node biasa). Langkah: buat extension uji yang memanggil openIndex di activate(), jalankan lewat F5 di Windows, macOS, Linux.
2. Bila gagal: bangun ulang untuk ABI Electron (electron-rebuild atau prebuild sesuai versi), atau pindah ke cadangan node-sqlite3-wasm dan ulangi spike ini.
3. Pastikan vsix per platform (vsce package --target) membawa binary .node yang benar.
4. Ulangi pengukuran di Windows dan macOS; catat hasil di sini.

Keputusan final ditulis di bawah ini setelah langkah 1 sampai 4 selesai.

## Hasil uji Electron (Linux Mint, x64)
- Extension uji memuat better-sqlite3 di extension host: SQLite 3.53.4, FTS5 aktif, ABI 140, Electron 39.8.8.
- Belum diuji: Windows, macOS, arm64; dan pemaketan vsix (vsce package --target).
- Catatan: modul terpasang lewat `npm install` dari Node 22 (ABI 127) namun termuat di ABI 140. Catat versi better-sqlite3 yang terpasang
  (`npm ls better-sqlite3`) dan apakah `electron-rebuild` dijalankan, agar hasil dapat direproduksi.
