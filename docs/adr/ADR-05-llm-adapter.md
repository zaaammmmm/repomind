# ADR-05: Satu adapter OpenAI-compatible untuk Ollama dan cloud

Status: diterima untuk Iterasi 4 (penyedia cloud final belum dipilih, T-11).

Konteks. Mode 2 (Ollama) dan Mode 3 (cloud) perlu satu antarmuka `LlmProvider`. Ollama menyediakan endpoint `/v1/chat/completions` yang kompatibel.
Keputusan. Satu `OpenAICompatibleProvider` dengan `baseUrl`, `model`, dan kunci opsional; taksonomi galat tetap (OFFLINE, AUTH, RATE_LIMIT, TIMEOUT, CONTEXT_TOO_LONG, PROVIDER_ERROR, CANCELLED).
Konsekuensi. Penyedia yang tidak kompatibel membutuhkan adapter kedua di balik antarmuka yang sama. Kompatibilitas usage streaming harus diverifikasi per penyedia (lihat A-11, `usageSource`).
Verifikasi. Uji dengan server HTTP lokal (SSE sungguhan) lulus; uji terhadap Ollama dan satu penyedia cloud sungguhan masih harus dilakukan penulis.
