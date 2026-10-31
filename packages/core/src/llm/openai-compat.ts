import { LlmError, type LlmErrorCode, type LlmProvider, type LlmRequest, type LlmResponse, type LlmUsage } from '../contracts.js';

/** Satu adapter OpenAI-compatible untuk Ollama (http://localhost:11434/v1) dan cloud yang kompatibel (ADR-05, bagian 3.9). */
export interface ProviderConfig {
  id: 'ollama' | 'cloud';
  baseUrl: string;                                   // mis. http://localhost:11434/v1
  model: string;
  apiKey?: string | (() => Promise<string | undefined>); // dari SecretStorage; tidak pernah dicatat
  timeoutMs?: number;                                // bawaan 60000; untuk stream berlaku sebagai batas diam antar-potongan
  maxRetries?: number;                               // bawaan 2; hanya untuk 429 dan 5xx
  priceInPerMTok?: number; priceOutPerMTok?: number; // tarif isian pengguna
  fetchImpl?: typeof fetch;                          // injeksi untuk uji
  sleep?: (ms: number) => Promise<void>; random?: () => number; now?: () => number;
}

const SUGGEST = {
  OFFLINE: 'Periksa koneksi atau apakah server model berjalan, atau gunakan Mode 1 (lokal).',
  AUTH: 'Periksa API key pada Pengaturan, atau gunakan Mode 1 (lokal).',
  RATE_LIMIT: 'Tunggu sebentar lalu coba lagi, atau gunakan Mode 1 (lokal).',
  TIMEOUT: 'Kurangi jumlah potongan (k) atau naikkan batas waktu, atau gunakan Mode 1 (lokal).',
  CONTEXT_TOO_LONG: 'Kurangi k atau batas token konteks, lalu coba lagi.',
  PROVIDER_ERROR: 'Periksa nama model dan endpoint pada Pengaturan, atau gunakan Mode 1 (lokal).',
  CANCELLED: 'Permintaan dibatalkan.',
} as const;
const MSG: Record<LlmErrorCode, string> = {
  OFFLINE: 'Tidak dapat terhubung ke penyedia LLM.',
  AUTH: 'Penyedia menolak kredensial (API key salah atau tidak berhak).',
  RATE_LIMIT: 'Batas laju penyedia tercapai.',
  TIMEOUT: 'Penyedia tidak merespons dalam batas waktu.',
  CONTEXT_TOO_LONG: 'Konteks melebihi panjang yang diterima model.',
  PROVIDER_ERROR: 'Penyedia mengembalikan galat.',
  CANCELLED: 'Dibatalkan oleh pengguna.',
};
const err = (code: LlmErrorCode, extra = '') => new LlmError(code, extra ? `${MSG[code]} ${extra}` : MSG[code], SUGGEST[code]);

export const isLoopbackUrl = (u: string): boolean => {
  try { const h = new URL(u).hostname.replace(/^\[|\]$/g, ''); return h === 'localhost' || h === '::1' || /^127\./.test(h); } catch { return false; }
};

/** Pesan galat dari badan respons; dipotong agar tidak membawa banyak teks (dan tidak pernah memuat header otorisasi). */
const safeSnippet = (body: string) => body.replace(/\s+/g, ' ').slice(0, 160);

export class OpenAICompatibleProvider implements LlmProvider {
  readonly id: 'ollama' | 'cloud';
  /** Endpoint loopback: data tidak meninggalkan perangkat. Dipakai gerbang privasi untuk menentukan perlunya persetujuan. */
  readonly loopback: boolean;
  private readonly c: Required<Pick<ProviderConfig, 'timeoutMs' | 'maxRetries'>> & ProviderConfig;
  private readonly f: typeof fetch;

  constructor(cfg: ProviderConfig) {
    const url = new URL(cfg.baseUrl);
    this.loopback = isLoopbackUrl(cfg.baseUrl);
    // Kunci dan kode tidak boleh lewat HTTP polos ke host jauh.
    if (url.protocol !== 'https:' && !this.loopback) throw new Error('Endpoint non-lokal wajib memakai https.');
    if (!cfg.model) throw new Error('Nama model belum diisi.');
    this.id = cfg.id;
    this.c = { timeoutMs: 60_000, maxRetries: 2, ...cfg };
    this.f = cfg.fetchImpl ?? fetch;
  }

  complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> { return this.run(req, undefined, signal); }
  stream(req: LlmRequest, onToken: (t: string) => void, signal?: AbortSignal): Promise<LlmResponse> { return this.run(req, onToken, signal); }

  private async run(req: LlmRequest, onToken: ((t: string) => void) | undefined, signal?: AbortSignal): Promise<LlmResponse> {
    const now = this.c.now ?? (() => performance.now());
    const sleep = this.c.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const rnd = this.c.random ?? Math.random;
    const t0 = now();
    const streaming = onToken !== undefined;
    const body = JSON.stringify({
      model: this.c.model,
      messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      temperature: req.temperature ?? 0,
      ...(req.maxOutputTokens ? { max_tokens: req.maxOutputTokens } : {}),
      stream: streaming,
      ...(streaming ? { stream_options: { include_usage: true } } : {}),
    });
    const key = typeof this.c.apiKey === 'function' ? await this.c.apiKey() : this.c.apiKey;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };

    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw err('CANCELLED');
      try {
        return await this.once(body, headers, streaming ? onToken : undefined, signal, t0, now, req);
      } catch (e) {
        const retryable = e instanceof LlmError && (e.code === 'RATE_LIMIT' || (e.code === 'PROVIDER_ERROR' && (e as RetryableError).retryable));
        if (!retryable || attempt >= this.c.maxRetries) throw e;
        const retryAfter = (e as RetryableError).retryAfterMs;
        await sleep(retryAfter ?? Math.round(500 * 2 ** attempt * (0.5 + rnd())));
      }
    }
  }

  private async once(body: string, headers: Record<string, string>, onToken: ((t: string) => void) | undefined, user: AbortSignal | undefined, t0: number, now: () => number, req: LlmRequest): Promise<LlmResponse> {
    const ctl = new AbortController(); let timedOut = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctl.abort(); }, this.c.timeoutMs); };
    const onUserAbort = () => ctl.abort();
    user?.addEventListener('abort', onUserAbort, { once: true });
    arm();
    try {
      let res: Response;
      try { res = await this.f(`${this.c.baseUrl.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers, body, signal: ctl.signal }); }
      catch (e) { throw this.mapThrown(e, timedOut, user); }
      if (!res.ok) throw await this.mapStatus(res);
      let text = ''; let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined; let model = this.c.model;
      try {
        if (onToken) {
          const parsed = await readSse(res, (delta) => { arm(); if (delta) { text += delta; onToken(delta); } }, arm);
          usage = parsed.usage; model = parsed.model ?? model;
        } else {
          const j = await res.json() as { choices?: { message?: { content?: string } }[]; usage?: typeof usage; model?: string };
          text = j.choices?.[0]?.message?.content ?? ''; usage = j.usage; model = j.model ?? model;
        }
      } catch (e) {
        // Galat saat membaca badan respons: pembatalan/timeout dipetakan seperti biasa; selain itu penyedia membalas sesuatu yang tidak dapat dibaca (bukan OFFLINE).
        if (e instanceof LlmError || user?.aborted || timedOut || (e instanceof Error && e.name === 'AbortError')) throw this.mapThrown(e, timedOut, user);
        throw err('PROVIDER_ERROR', 'Respons penyedia tidak dapat dibaca (bukan JSON/SSE yang diharapkan). Periksa endpoint /v1 dan nama model.');
      }
      const tIn = usage?.prompt_tokens, tOut = usage?.completion_tokens;
      const fromProvider = typeof tIn === 'number' && typeof tOut === 'number';
      const tokensIn = fromProvider ? tIn : Math.ceil((req.system.length + req.user.length) / 4);
      const tokensOut = fromProvider ? tOut : Math.ceil(text.length / 4);
      const u: LlmUsage = {
        tokensIn, tokensOut, latencyMs: now() - t0, usageSource: fromProvider ? 'provider' : 'estimated',
        costEstimate: (tokensIn * (this.c.priceInPerMTok ?? 0) + tokensOut * (this.c.priceOutPerMTok ?? 0)) / 1e6,
      };
      return { text, usage: u, model };
    } finally { if (timer) clearTimeout(timer); user?.removeEventListener('abort', onUserAbort); }
  }

  private mapThrown(e: unknown, timedOut: boolean, user: AbortSignal | undefined): LlmError {
    if (e instanceof LlmError) return e;
    if (user?.aborted) return err('CANCELLED');
    if (timedOut) return err('TIMEOUT');
    const aborted = e instanceof Error && e.name === 'AbortError';
    return aborted ? err('CANCELLED') : err('OFFLINE');
  }

  private async mapStatus(res: Response): Promise<LlmError> {
    const text = await res.text().catch(() => '');
    const s = res.status;
    if (s === 401 || s === 403) return err('AUTH');
    if (s === 429) { const e = err('RATE_LIMIT') as RetryableError; const ra = Number(res.headers.get('retry-after')); if (Number.isFinite(ra) && ra > 0) e.retryAfterMs = Math.min(ra, 10) * 1000; return e; }
    if (s === 413 || (s === 400 && /context[_ ]length|maximum context|too long|too many tokens|context_length_exceeded/i.test(text))) return err('CONTEXT_TOO_LONG');
    const e = err('PROVIDER_ERROR', `(HTTP ${s}) ${safeSnippet(text)}`) as RetryableError;
    e.retryable = s >= 500; return e;
  }
}
type RetryableError = LlmError & { retryable?: boolean; retryAfterMs?: number };

/** Parser SSE minimal untuk /chat/completions streaming. Mengabaikan baris bukan data; berhenti pada [DONE]. */
async function readSse(res: Response, onDelta: (d: string) => void, onActivity: () => void): Promise<{ usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string }> {
  if (!res.body) throw new Error('Respons tanpa badan.');
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined; let model: string | undefined;
  const handle = (line: string): boolean => {
    if (!line.startsWith('data:')) return false;
    const data = line.slice(5).trim(); if (data === '[DONE]') return true; if (!data) return false;
    try {
      const j = JSON.parse(data) as { choices?: { delta?: { content?: string } }[]; usage?: typeof usage; model?: string };
      if (j.model) model = j.model; if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta?.content; if (d) onDelta(d);
    } catch { /* potongan rusak diabaikan */ }
    return false;
  };
  for (;;) {
    const { value, done } = await reader.read(); if (done) break; onActivity();
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1); if (handle(line)) return { ...(usage ? { usage } : {}), ...(model ? { model } : {}) }; }
  }
  if (buf.trim()) handle(buf.trim());
  return { ...(usage ? { usage } : {}), ...(model ? { model } : {}) };
}
