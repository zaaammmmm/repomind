// Tanya-jawab Mode 2/3 (LLM) pada repo nyata, dengan gerbang privasi dan persetujuan di terminal:
//   LLM_BASE_URL=http://localhost:11434/v1 LLM_MODEL=qwen2.5-coder:7b LLM_PROVIDER=ollama \
//   npm run ask-llm -w @repomind/core -- /path/absolut/ke/repo "pertanyaan"
//   (cloud) LLM_BASE_URL=https://.../v1 LLM_MODEL=... LLM_API_KEY=... LLM_PROVIDER=cloud ...
// Opsional: PROMPT_VARIANT=compact, MAX_TOKENS=300, LLM_TIMEOUT_MS, LLM_PRICE_IN, LLM_PRICE_OUT (per 1 juta token), K, TOKEN_BUDGET, YES=1 (lewati dialog; hanya untuk uji sendiri).
// Skrip ini mencetak pratinjau yang akan dikirim (path:baris, token, jumlah redaksi) dan meminta persetujuan sebelum request keluar.
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { openIndex } from '../src/store/open.ts';
import { SqliteIndexStore } from '../src/store/index-store.ts';
import { UpdateOrchestrator } from '../src/update/orchestrator.ts';
import { NodeWorkspaceFs } from '../src/update/workspace-fs.ts';
import { HybridRetriever, DEFAULT_RETRIEVAL } from '../src/retrieval/retriever.ts';
import { DefaultContextBuilder } from '../src/context/builder.ts';
import { OpenAICompatibleProvider } from '../src/llm/openai-compat.ts';
import { LlmQaService } from '../src/qa/llm-qa.ts';
import { InMemoryMetrics } from '../src/metrics/sink.ts';
import { DEFAULT_EXCLUDE } from '../src/scanner/scan.ts';

const [arg, ...questions] = process.argv.slice(2);
const env = process.env;
if (!arg || !existsSync(arg) || questions.length === 0 || !env.LLM_BASE_URL || !env.LLM_MODEL) {
  console.error('Pemakaian: LLM_BASE_URL=... LLM_MODEL=... [LLM_PROVIDER=ollama|cloud] [LLM_API_KEY=...] npm run ask-llm -w @repomind/core -- /path/repo "pertanyaan" ...'); process.exit(1);
}
const root = resolve(arg);
const store = new SqliteIndexStore(openIndex(':memory:').db);
await new UpdateOrchestrator(store, new NodeWorkspaceFs(root)).fullRebuild();
const files = store.counts().files; console.log(`Indeks: ${files} file\n`);

const provider = new OpenAICompatibleProvider({
  id: env.LLM_PROVIDER === 'ollama' ? 'ollama' : 'cloud', baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL, timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 60000), ...(env.LLM_API_KEY ? { apiKey: env.LLM_API_KEY } : {}),
  priceInPerMTok: Number(env.LLM_PRICE_IN ?? 0), priceOutPerMTok: Number(env.LLM_PRICE_OUT ?? 0),
});
const metrics = new InMemoryMetrics('cli');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const svc = new LlmQaService({
  retriever: new HybridRetriever(store), metrics, provider: () => provider, mode: () => (provider.id === 'cloud' ? 'cloud' : 'ollama'), trusted: () => true,
  builder: new DefaultContextBuilder({ exclude: DEFAULT_EXCLUDE, redact: true, tokenBudget: Number(env.TOKEN_BUDGET ?? 4000), repoFileCount: () => files, promptVariant: env.PROMPT_VARIANT === 'compact' ? 'compact' : 'default' }),
  ...(env.MAX_TOKENS ? { maxOutputTokens: Number(env.MAX_TOKENS) } : {}),
  retrieval: () => ({ ...DEFAULT_RETRIEVAL, topK: Number(env.K ?? DEFAULT_RETRIEVAL.topK), tokenBudget: Number(env.TOKEN_BUDGET ?? DEFAULT_RETRIEVAL.tokenBudget) }),
  consent: async (p, id) => {
    console.log(`Akan mengirim ${p.items.length} potongan (~${p.totalTokens} token) dari ${new Set(p.items.map((i) => i.path)).size} berkas ke penyedia "${id}":`);
    p.items.forEach((i) => console.log(`   ${i.path}:${i.startLine}-${i.endLine}  (${i.tokenEst} token${i.redactions ? `, ${i.redactions} redaksi` : ''})`));
    if (env.YES === '1') return 'send';
    const a = (await rl.question('Kirim? [y/N] ')).trim().toLowerCase(); return a === 'y' ? 'send' : 'cancel';
  },
});
for (const q of questions) {
  console.log(`? ${q}`);
  const r = await svc.ask(q, { onToken: (t) => process.stdout.write(t) });
  console.log();
  if (r.type === 'answer') r.citations.forEach((c) => console.log(`  -> ${c.path}:${c.startLine}-${c.endLine}`));
  if (r.type === 'answer') console.log(`\n  sitasi valid: ${r.citations.length}, tidak terverifikasi: ${r.unverified}${r.uncited ? ' (JAWABAN TANPA SITASI)' : ''}; token ${r.usage.tokensIn}/${r.usage.tokensOut} (${r.usage.usageSource}); ${Math.round(r.usage.latencyMs)} ms; model ${r.model}; konteks ${r.contextFiles}/${r.repoFiles} berkas; redaksi ${r.redactions}\n`);
  else if (r.type === 'error') console.log(`  GALAT ${r.error.code}: ${r.error.message}\n  Saran: ${r.error.suggestion ?? '-'}\n`);
  else console.log(`  Tidak dikirim (${r.reason})\n`);
}
rl.close();
if (env.METRICS_OUT) writeFileSync(env.METRICS_OUT, metrics.exportJsonl());
store.close();
