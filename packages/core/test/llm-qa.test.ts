import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fsn from 'node:fs'; import * as path from 'node:path'; import { fileURLToPath } from 'node:url';
import { MemFs, newEngine } from './helpers/memfs.js';
import { HybridRetriever, DEFAULT_RETRIEVAL } from '../src/retrieval/retriever.js';
import { DefaultContextBuilder } from '../src/context/builder.js';
import { LlmQaService, type LlmQaDeps, type ConsentDecision } from '../src/qa/llm-qa.js';
import { InMemoryMetrics, SqliteMetrics } from '../src/metrics/sink.js';
import { LlmError, type LlmProvider, type LlmRequest, type Mode } from '../src/contracts.js';
import { LocalQaService } from '../src/qa/router.js';

const FILES: Record<string, string> = {
  'src/auth/token.ts': `export function signToken(p: string): string {\n  const apiKey = "k9X2mQ7vLp4Zs8Rt";\n  return p + apiKey;\n}\n`,
  'src/auth/login.ts': `import { signToken } from './token';\nexport function login(e: string) { return signToken(e); }\n`,
};
let store: ReturnType<typeof newEngine>['store']; let ret: HybridRetriever;
beforeAll(async () => { const e = newEngine(new MemFs(FILES)); await e.orch.fullRebuild(); store = e.store; ret = new HybridRetriever(store); });
afterAll(() => store.close());

class FakeProvider implements LlmProvider {
  readonly id: 'ollama' | 'cloud'; readonly loopback: boolean; calls: LlmRequest[] = []; reply?: string; failWith?: LlmError;
  constructor(id: 'ollama' | 'cloud' = 'cloud', loopback = false) { this.id = id; this.loopback = loopback; }
  async complete(r: LlmRequest) { this.calls.push(r); if (this.failWith) throw this.failWith; const m = /\[(F\d+)\] path=src\/auth\/token\.ts baris=(\d+)-(\d+)/.exec(r.user);
    const text = this.reply ?? `signToken ada di [${m![1]}:${m![2]}-${m![3]}] dan [F9:1-1].`;
    return { text, model: 'fake', usage: { tokensIn: 50, tokensOut: 9, latencyMs: 3, usageSource: 'provider' as const } }; }
  async stream(r: LlmRequest, on: (t: string) => void) { const x = await this.complete(r); on(x.text); return x; }
}
function setup(o: { mode?: Mode; trusted?: boolean; decision?: ConsentDecision; skip?: boolean; provider?: FakeProvider | undefined } = {}) {
  const provider = 'provider' in o ? o.provider : new FakeProvider();
  const order: string[] = []; const metrics = new InMemoryMetrics('t', () => 1);
  const builder = new DefaultContextBuilder({ exclude: [], redact: true, tokenBudget: 4000, repoFileCount: () => 2, nonce: () => 'nn' });
  if (provider) { const c = provider.complete.bind(provider); provider.complete = async (r) => { order.push('llm'); return c(r); }; }
  const deps: LlmQaDeps = {
    retriever: ret, builder, provider: () => provider, metrics, mode: () => o.mode ?? 'cloud', trusted: () => o.trusted ?? true, retrieval: () => DEFAULT_RETRIEVAL,
    consent: async () => { order.push('consent'); return o.decision ?? 'send'; }, skipConsent: () => o.skip ?? false,
  };
  return { svc: new LlmQaService(deps), provider, order, metrics };
}

describe('LlmQaService: gerbang privasi dan alur (FR-PRV-01, FR-LLM-*)', () => {
  it('Mode cloud: persetujuan SEBELUM request; jawaban bersitasi tervalidasi; metrik tercatat', async () => {
    const { svc, provider, order, metrics } = setup();
    const r = await svc.ask('Apa itu signToken?');
    expect(order).toEqual(['consent', 'llm']);
    expect(r.type).toBe('answer'); if (r.type !== 'answer') return;
    expect(r.citations).toEqual([{ path: 'src/auth/token.ts', startLine: 1, endLine: 4, verified: true }]);
    expect(r.unverified).toBe(1); expect(r.text).toContain('[F9:1-1](tidak terverifikasi)'); expect(r.uncited).toBe(false);
    expect(r.redactions).toBe(1); expect(r.repoFiles).toBe(2);
    expect(provider!.calls[0]!.user).not.toContain('k9X2mQ7vLp4Zs8Rt');
    const kinds = metrics.events.map((e) => e.event.kind); expect(kinds).toEqual(['retrieval', 'llm_call']);
  });
  it('Batal dan Gunakan mode lokal: nol panggilan ke penyedia', async () => {
    for (const [decision, reason] of [['cancel', 'USER_CANCELLED'], ['use_local', 'USER_USE_LOCAL']] as const) {
      const { svc, provider } = setup({ decision });
      expect(await svc.ask('signToken')).toEqual({ type: 'declined', reason }); expect(provider!.calls).toHaveLength(0);
    }
  });
  it('Mode 1: tidak ada retrieval, persetujuan, maupun panggilan (FR-LQA-06)', async () => {
    const { svc, provider, order, metrics } = setup({ mode: 'local' });
    expect(await svc.ask('signToken')).toEqual({ type: 'declined', reason: 'MODE_LOCAL' });
    expect(order).toEqual([]); expect(provider!.calls).toHaveLength(0); expect(metrics.events).toHaveLength(0);
  });
  it('Workspace tidak tepercaya menolak Mode 2 dan 3 (FR-SCN-06)', async () => {
    const { svc, provider } = setup({ trusted: false, mode: 'ollama' });
    expect(await svc.ask('signToken')).toEqual({ type: 'declined', reason: 'UNTRUSTED' }); expect(provider!.calls).toHaveLength(0);
  });
  it('tanpa penyedia terkonfigurasi: ditolak', async () => { expect(await setup({ provider: undefined }).svc.ask('x')).toEqual({ type: 'declined', reason: 'NO_PROVIDER' }); });
  it('Ollama loopback tidak meminta persetujuan; Ollama non-loopback dan cloud meminta', async () => {
    expect(setup({ provider: new FakeProvider('ollama', true) }).order).toEqual([]);
    const a = setup({ provider: new FakeProvider('ollama', true) }); await a.svc.ask('signToken'); expect(a.order).toEqual(['llm']);
    const b = setup({ provider: new FakeProvider('ollama', false) }); await b.svc.ask('signToken'); expect(b.order).toEqual(['consent', 'llm']);
  });
  it('"jangan tanya lagi" melewati dialog; setelah dicabut dialog muncul lagi (FR-PRV-02, 08)', async () => {
    const a = setup({ skip: true }); await a.svc.ask('signToken'); expect(a.order).toEqual(['llm']);
    const b = setup({ skip: false }); await b.svc.ask('signToken'); expect(b.order).toEqual(['consent', 'llm']);
  });
  it('konteks kosong: tidak memanggil LLM (mencegah jawaban tanpa dasar)', async () => {
    const { svc, provider } = setup(); expect(await svc.ask('zzqxjv')).toEqual({ type: 'declined', reason: 'EMPTY_CONTEXT' }); expect(provider!.calls).toHaveLength(0);
  });
  it('galat penyedia dipetakan, dicatat sebagai llm_call gagal, tanpa isi kode di metrik', async () => {
    const s = setup(); s.provider!.failWith = new LlmError('AUTH', 'Kunci salah', 'Periksa key');
    const r = await s.svc.ask('signToken'); expect(r).toMatchObject({ type: 'error', error: { code: 'AUTH', suggestion: 'Periksa key' } });
    const last = s.metrics.events.at(-1)!.event; expect(last).toMatchObject({ kind: 'llm_call', ok: false, errorCode: 'AUTH' });
    expect(s.metrics.exportJsonl()).not.toMatch(/k9X2|signToken|src\/auth/);
  });
  it('jawaban tanpa sitasi ditandai uncited', async () => {
    const s = setup(); s.provider!.reply = 'Fungsi itu membuat token.'; const r = await s.svc.ask('signToken');
    expect(r).toMatchObject({ type: 'answer', uncited: true, unverified: 0 });
  });
  it('maxOutputTokens diteruskan ke penyedia', async () => {
    const s = setup(); s.svc['d'].maxOutputTokens = 123; let seen: LlmRequest | undefined;
    const c = s.provider!.complete.bind(s.provider!); s.provider!.complete = async (r) => { seen = r; return c(r); };
    await s.svc.ask('signToken'); expect(seen!.maxOutputTokens).toBe(123);
  });
  it('streaming meneruskan token', async () => {
    const s = setup(); const t: string[] = []; await s.svc.ask('signToken', { onToken: (x) => t.push(x) }); expect(t.join('')).toContain('signToken');
  });
  it('sinyal batal sebelum kirim menghentikan alur', async () => {
    const s = setup(); const ctl = new AbortController(); s.svc['d'].consent = async () => { ctl.abort(); return 'send'; };
    expect(await s.svc.ask('signToken', { signal: ctl.signal })).toEqual({ type: 'declined', reason: 'USER_CANCELLED' }); expect(s.provider!.calls).toHaveLength(0);
  });
});

describe('metrik', () => {
  it('JSONL memori dan SQLite setara; metrik tidak memengaruhi canonical dump (NFR-R-01)', () => {
    const before = store.canonicalDump();
    const sql = new SqliteMetrics(store.db, 's1', () => 5); const mem = new InMemoryMetrics('s1', () => 5);
    const e = { kind: 'llm_call' as const, usage: { tokensIn: 1, tokensOut: 2, latencyMs: 3, usageSource: 'provider' as const }, ok: true, contextTokens: 9 };
    sql.record(e); mem.record(e);
    expect(sql.exportJsonl()).toBe(mem.exportJsonl()); expect(JSON.parse(sql.exportJsonl().trim())).toMatchObject({ ts_ms: 5, session_id: 's1', kind: 'llm_call', contextTokens: 9 });
    expect(store.canonicalDump()).toBe(before);
  });
});

describe('uji arsitektur', () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const imports = (dir: string) => fsn.readdirSync(path.join(src, dir)).filter((f) => f.endsWith('.ts')).flatMap((f) => fsn.readFileSync(path.join(src, dir, f), 'utf8').split('\n').filter((l) => /^\s*(import|export)\b.*from\s/.test(l)));
  it('pembaruan indeks, penyimpanan, dan analisis tidak mengimpor LLM atau klien jaringan (FR-LLM-07)', () => {
    for (const d of ['update', 'store', 'scanner', 'analyzer', 'resolver', 'summary', 'qa/../retrieval']) {
      for (const l of imports(d)) expect(l, `${d}: ${l}`).not.toMatch(/llm|openai|node:https?|node:net|undici/i);
    }
  });
  it('Mode 1 (router) tidak mengimpor LLM atau jaringan (FR-LQA-06, bukti struktural; bukan pemblokiran jaringan OS)', () => {
    const l = fsn.readFileSync(path.join(src, 'qa/router.ts'), 'utf8').split('\n').filter((x) => /^\s*import\b/.test(x)).join('\n');
    expect(l).not.toMatch(/llm|openai|node:https?|node:net|fetch/i); expect(LocalQaService).toBeDefined();
  });
});
