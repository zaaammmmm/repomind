// Uji Retriever pada repo nyata, dan ukur latensi (NFR-P-04: p95 <= 300 ms tanpa LLM):
//   npm run retrieve-repo -w @repomind/core -- /path/absolut/ke/repo "pertanyaan 1" "pertanyaan 2"
//   LATENCY=1 ... : ulangi tiap pertanyaan 30 kali dan cetak p50/p95
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openIndex } from '../src/store/open.ts';
import { SqliteIndexStore } from '../src/store/index-store.ts';
import { UpdateOrchestrator } from '../src/update/orchestrator.ts';
import { NodeWorkspaceFs } from '../src/update/workspace-fs.ts';
import { HybridRetriever } from '../src/retrieval/retriever.ts';

const [arg, ...queries] = process.argv.slice(2);
if (!arg || !existsSync(arg) || !queries.length) { console.error('Pemakaian: npm run retrieve-repo -w @repomind/core -- /path/absolut/repo "pertanyaan" ...'); process.exit(1); }
const store = new SqliteIndexStore(openIndex(':memory:').db);
await new UpdateOrchestrator(store, new NodeWorkspaceFs(resolve(arg))).fullRebuild();
const c = store.counts(); console.log(`Indeks: ${c.files} file, ${c.symbols} simbol, ${c.chunks} chunk\n`);
const r = new HybridRetriever(store);
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))]!;
const all: number[] = [];
for (const q of queries) {
  const res = r.run(q, { topK: 8, tokenBudget: 4000, maxChunksPerFile: 3 });
  console.log(`? ${q}   [${res.timingsMs.total.toFixed(1)} ms, ~${res.tokenEstimate} token, kandidat: ${JSON.stringify(res.perSourceCounts)}]`);
  for (const k of res.chunks) console.log(`   ${k.path}:${k.startLine}-${k.endLine}  ${k.symbol ?? ''}  [${k.sources.join('+')}] ${k.score.toFixed(4)}  ${k.reason}`);
  console.log();
  if (process.env.LATENCY) { const t: number[] = []; for (let i = 0; i < 30; i++) t.push(r.run(q, { topK: 8, tokenBudget: 4000, maxChunksPerFile: 3 }).timingsMs.total); all.push(...t); console.log(`   latensi: p50 ${pct(t, 0.5).toFixed(1)} ms, p95 ${pct(t, 0.95).toFixed(1)} ms\n`); }
}
if (all.length) console.log(`SEMUA kueri (n=${all.length}): p50 ${pct(all, 0.5).toFixed(1)} ms, p95 ${pct(all, 0.95).toFixed(1)} ms, maks ${Math.max(...all).toFixed(1)} ms`);
