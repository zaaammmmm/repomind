// Eval C (LLM) bertahap dan dapat dilanjutkan: satu baris JSONL per pertanyaan, ditulis segera setelah selesai.
//   LLM_PROVIDER=ollama LLM_BASE_URL=... LLM_MODEL=... [LLM_API_KEY=...] [K=8 TOKEN_BUDGET=3000 MCPF=3 PROMPT_VARIANT=compact MAX_TOKENS=200 LLM_TIMEOUT_MS=400000] \
//   npm run eval-llm -w @repomind/core -- /path/ke/repo /path/dataset.jsonl [--split dev] --out hasil/llm-dev.jsonl [--yes]
// Dijalankan ulang dengan --out yang sama: pertanyaan dengan konfigurasi identik dilewati (resume). Berkas .csv dibuat di samping .jsonl.
// Kolom otomatis: format sitasi, sitasi mengenai acuan, konteks memuat acuan (diagnosis retrieval vs model), penolakan. Kolom nilai_manual diisi penulis.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HybridRetriever } from '../src/retrieval/retriever.ts';
import { DefaultContextBuilder } from '../src/context/builder.ts';
import { OpenAICompatibleProvider } from '../src/llm/openai-compat.ts';
import { LlmQaService, type LlmQaResult } from '../src/qa/llm-qa.ts';
import { InMemoryMetrics } from '../src/metrics/sink.ts';
import { DEFAULT_EXCLUDE } from '../src/scanner/scan.ts';
import { buildIndex, coveredRefs, loadDataset, parseArgs, toCsv } from './lib/eval-common.ts';

const { pos, opt } = parseArgs(process.argv.slice(2)); const env = process.env;
if (pos.length < 2 || !opt.out || !env.LLM_BASE_URL || !env.LLM_MODEL) { console.error('Pemakaian: LLM_BASE_URL=... LLM_MODEL=... npm run eval-llm -w @repomind/core -- <repo> <dataset.jsonl> --out hasil/x.jsonl [--split dev] [--yes]'); process.exit(1); }
const { root, store, files } = await buildIndex(pos[0]!);
const items = loadDataset(pos[1]!, root, opt.split ?? 'dev', opt['include-incomplete'] === '1');
const cfg = { model: env.LLM_MODEL, variant: env.PROMPT_VARIANT === 'compact' ? 'compact' : 'default', k: Number(env.K ?? 8), budget: Number(env.TOKEN_BUDGET ?? 3000), mcpf: Number(env.MCPF ?? 3), maxTokens: Number(env.MAX_TOKENS ?? 0) };
const tag = JSON.stringify(cfg);
mkdirSync(dirname(opt.out), { recursive: true });
const done = new Set<string>();
if (existsSync(opt.out)) for (const l of readFileSync(opt.out, 'utf8').split('\n')) if (l.trim()) { const r = JSON.parse(l) as { id: string; tag: string; status: string }; if (r.tag === tag && !r.status.startsWith('error:')) done.add(r.id); }  // galat sementara (OFFLINE, TIMEOUT, ...) diulang saat dilanjutkan

const provider = new OpenAICompatibleProvider({ id: env.LLM_PROVIDER === 'ollama' ? 'ollama' : 'cloud', baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL, timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 60000), ...(env.LLM_API_KEY ? { apiKey: env.LLM_API_KEY } : {}), priceInPerMTok: Number(env.LLM_PRICE_IN ?? 0), priceOutPerMTok: Number(env.LLM_PRICE_OUT ?? 0) });
const ret = new HybridRetriever(store);
const builder = new DefaultContextBuilder({ exclude: DEFAULT_EXCLUDE, redact: true, tokenBudget: cfg.budget, repoFileCount: () => files, promptVariant: cfg.variant as 'default' | 'compact' });
const ropts = { topK: cfg.k, tokenBudget: cfg.budget, maxChunksPerFile: cfg.mcpf };
const svc = new LlmQaService({
  retriever: ret, builder, metrics: new InMemoryMetrics('eval'), provider: () => provider, mode: () => (provider.id === 'cloud' ? 'cloud' : 'ollama'), trusted: () => true, retrieval: () => ropts,
  ...(cfg.maxTokens ? { maxOutputTokens: cfg.maxTokens } : {}),
  consent: async () => { if (opt.yes) return 'send'; console.error('Penyedia cloud: tambahkan --yes untuk menyetujui pengiriman potongan kode pada seluruh evaluasi ini.'); return 'cancel'; },
});
console.log(`Model ${cfg.model} | varian ${cfg.variant} | K=${cfg.k} anggaran=${cfg.budget} mcpf=${cfg.mcpf} | ${items.length} pertanyaan, ${done.size} sudah selesai`);

for (const it of items) {
  if (done.has(it.id)) continue;
  const sent = builder.prepare(await ret.retrieve(it.question, ropts)).items;   // konteks yang akan dikirim (deterministik)
  const t0 = Date.now(); const r: LlmQaResult = await svc.ask(it.question);
  const text = r.type === 'answer' ? r.text : '';
  const refused = /konteks tidak cukup/i.test(text);
  const cites = r.type === 'answer' ? r.citations : [];
  const row = { id: it.id, tag, split: it.split, type: it.type, question: it.question, status: r.type === 'answer' ? 'answer' : r.type === 'error' ? `error:${r.error.code}` : `declined:${r.reason}`,
    answer: text, cites: cites.map((c) => `${c.path}:${c.startLine}-${c.endLine}`).join(' | '),
    valid_cites: cites.length, unverified: r.type === 'answer' ? r.unverified : '', uncited: r.type === 'answer' ? +r.uncited : '',
    refused: +refused, refused_correct: it.type === 'unanswerable' ? +refused : '', false_refusal: it.type !== 'unanswerable' ? +refused : '',
    context_has_ref: it.refs.length ? +(coveredRefs(it.refs, sent) > 0) : '', context_ref_recall: it.refs.length ? +(coveredRefs(it.refs, sent) / it.refs.length).toFixed(3) : '',
    cite_hits_ref: it.refs.length ? +(coveredRefs(it.refs, cites) > 0) : '', cite_ref_recall: it.refs.length ? +(coveredRefs(it.refs, cites) / it.refs.length).toFixed(3) : '',
    tokens_in: r.type === 'answer' ? r.usage.tokensIn : '', tokens_out: r.type === 'answer' ? r.usage.tokensOut : '', usage_source: r.type === 'answer' ? r.usage.usageSource : '', latency_ms: Date.now() - t0,
    nilai_manual: '', catatan: '' };
  appendFileSync(opt.out, JSON.stringify(row) + '\n');
  console.log(`[${it.id}] ${row.status} | sitasi valid ${row.valid_cites} | konteks memuat acuan: ${row.context_has_ref || '-'} | sitasi kena acuan: ${row.cite_hits_ref || '-'} | ${(row.latency_ms / 1000).toFixed(0)} s`);
}
// satu baris per (id, konfigurasi): baris terakhir menang, sehingga ulangan setelah galat menggantikan yang lama
const last = new Map<string, Record<string, unknown>>();
for (const l of readFileSync(opt.out, 'utf8').split('\n').filter(Boolean)) { const x = JSON.parse(l) as Record<string, unknown>; last.set(`${String(x.id)}|${String(x.tag)}`, x); }
const all = [...last.values()].filter((x) => x.tag === tag);
writeFileSync(opt.out.replace(/\.jsonl$/, '') + '.csv', toCsv(all.map((x) => { const y = { ...x }; delete y.tag; return y; })));
console.log(`\nSelesai. CSV: ${opt.out.replace(/\.jsonl$/, '')}.csv (isi kolom nilai_manual: benar | sebagian | salah)`);
store.close();
