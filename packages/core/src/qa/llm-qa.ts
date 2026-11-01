import { LlmError, type Citation, type ContextPreview, type LlmProvider, type LlmUsage, type Mode, type MetricsSink, type RetrievalOptions, type Retriever } from '../contracts.js';
import type { DefaultContextBuilder } from '../context/builder.js';
import { BAD_FORMAT, UNVERIFIED, validateCitations } from '../context/citations.js';

export type ConsentDecision = 'send' | 'cancel' | 'use_local';
export interface LlmQaDeps {
  retriever: Retriever;
  builder: DefaultContextBuilder;
  provider: () => (LlmProvider & { loopback?: boolean }) | undefined;
  metrics: MetricsSink;
  mode: () => Mode;
  trusted: () => boolean;                         // Workspace Trust (FR-SCN-06)
  retrieval: () => RetrievalOptions;
  /** Meminta persetujuan pengguna (dialog FR-PRV-01). Dipanggil sebelum request apa pun keluar. */
  consent: (preview: ContextPreview, providerId: string, signal?: AbortSignal) => Promise<ConsentDecision>;
  /** "Jangan tanya lagi" per repository (FR-PRV-02). Hanya berlaku bila pengguna menyetujuinya, dan dapat dicabut (FR-PRV-08). */
  skipConsent?: () => boolean;
  maxOutputTokens?: number;                       // membatasi panjang keluaran (mencegah jawaban berlarut pada CPU)
}
export type LlmQaResult =
  | { type: 'answer'; text: string; citations: Citation[]; unverified: number; uncited: boolean; usage: LlmUsage; model: string; contextFiles: number; repoFiles: number; redactions: number }
  | { type: 'declined'; reason: 'MODE_LOCAL' | 'UNTRUSTED' | 'NO_PROVIDER' | 'EMPTY_CONTEXT' | 'USER_CANCELLED' | 'USER_USE_LOCAL' }
  | { type: 'error'; error: LlmError };

/**
 * Alur Mode 2 dan 3 (UC-05): retrieval -> gerbang privasi -> persetujuan -> prompt -> LLM -> validasi sitasi -> metrik.
 * Invarian yang dijaga di sini: tidak ada request keluar sebelum persetujuan (bila diperlukan), dan tidak ada panggilan sama sekali pada Mode 1.
 */
export class LlmQaService {
  constructor(private readonly d: LlmQaDeps) {}

  async ask(question: string, o: { onToken?: (t: string) => void; signal?: AbortSignal } = {}): Promise<LlmQaResult> {
    const d = this.d;
    if (d.mode() === 'local') return { type: 'declined', reason: 'MODE_LOCAL' };
    if (!d.trusted()) return { type: 'declined', reason: 'UNTRUSTED' };
    const provider = d.provider();
    if (!provider) return { type: 'declined', reason: 'NO_PROVIDER' };

    const retrieval = await d.retriever.retrieve(question, d.retrieval());
    d.metrics.record({ kind: 'retrieval', result: { timingsMs: retrieval.timingsMs, perSourceCounts: retrieval.perSourceCounts, tokenEstimate: retrieval.tokenEstimate } });
    const prepared = d.builder.prepare(retrieval);
    if (prepared.items.length === 0) return { type: 'declined', reason: 'EMPTY_CONTEXT' };

    // Persetujuan wajib untuk cloud dan untuk endpoint non-loopback; Ollama di localhost tidak mengirim data keluar perangkat.
    const needsConsent = provider.id === 'cloud' || provider.loopback === false;
    if (needsConsent && !(d.skipConsent?.() ?? false)) {
      const decision = await d.consent(prepared.preview, provider.id, o.signal);
      if (decision === 'cancel') return { type: 'declined', reason: 'USER_CANCELLED' };
      if (decision === 'use_local') return { type: 'declined', reason: 'USER_USE_LOCAL' };
    }
    if (o.signal?.aborted) return { type: 'declined', reason: 'USER_CANCELLED' };

    const { system, user, idMap } = d.builder.buildPrompt(question, prepared.preview);
    const contextTokens = prepared.preview.totalTokens;
    const req = { system, user, ...(d.maxOutputTokens ? { maxOutputTokens: d.maxOutputTokens } : {}) };
    try {
      const res = o.onToken ? await provider.stream(req, o.onToken, o.signal) : await provider.complete(req, o.signal);
      d.metrics.record({ kind: 'llm_call', usage: res.usage, ok: true, contextTokens });
      const v = validateCitations(res.text, idMap);
      const unverified = (v.text.match(new RegExp(escape(UNVERIFIED) + '|' + escape(BAD_FORMAT), 'g')) ?? []).length;
      return {
        type: 'answer', text: v.text, citations: v.citations, unverified, uncited: v.citations.length === 0,
        usage: res.usage, model: res.model, contextFiles: new Set(prepared.items.map((i) => i.path)).size, repoFiles: prepared.preview.repoFileCount, redactions: prepared.redactions,
      };
    } catch (e) {
      const error = e instanceof LlmError ? e : new LlmError('PROVIDER_ERROR', 'Galat tak terduga pada pemanggilan LLM.');
      d.metrics.record({ kind: 'llm_call', usage: { tokensIn: 0, tokensOut: 0, latencyMs: 0 }, ok: false, errorCode: error.code, contextTokens });
      return { type: 'error', error };
    }
  }
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
