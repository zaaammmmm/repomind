// Eval B (retrieval, tanpa LLM): apakah potongan yang diambil mencakup rentang acuan?
//   npm run eval-retrieval -w @repomind/core -- /path/ke/repo /path/dataset.jsonl [--split dev|test|all] [--k 3,5,8,12] [--budget 100000] [--mcpf 3] [--out hasil/retrieval.csv] [--include-incomplete]
// --budget besar (bawaan 100000) mengisolasi pengaruh K; pakai 3000 dsb. untuk meniru konfigurasi LLM.
// Metrik per tipe dan K: hit (>=1 acuan tercakup), recall (acuan tercakup / seluruh acuan), MRR (peringkat skor tertinggi yang mencakup acuan), token rata-rata.
// Pertanyaan unanswerable tidak punya acuan; hanya dilaporkan jumlah token.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { HybridRetriever } from '../src/retrieval/retriever.ts';
import { DefaultContextBuilder } from '../src/context/builder.ts';
import { DEFAULT_EXCLUDE } from '../src/scanner/scan.ts';
import { buildIndex, coveredRefs, loadDataset, overlaps, parseArgs, toCsv, type QType } from './lib/eval-common.ts';

const { pos, opt } = parseArgs(process.argv.slice(2));
if (pos.length < 2) { console.error('Pemakaian: eval-retrieval <repo> <dataset.jsonl> [--split dev] [--k 3,5,8] [--budget 100000] [--mcpf 3] [--out file.csv]'); process.exit(1); }
const { root, store, files } = await buildIndex(pos[0]!);
const items = loadDataset(pos[1]!, root, opt.split ?? 'dev', opt['include-incomplete'] === '1');
const ks = (opt.k ?? '3,5,8,12').split(',').map(Number); const budget = Number(opt.budget ?? 100000); const mcpf = Number(opt.mcpf ?? 3);
const ret = new HybridRetriever(store);
const builder = new DefaultContextBuilder({ exclude: DEFAULT_EXCLUDE, redact: true, tokenBudget: budget, repoFileCount: () => files });
console.log(`Indeks: ${files} file | ${items.length} pertanyaan (split=${opt.split ?? 'dev'}) | budget=${budget} mcpf=${mcpf}\n`);

const rows: Record<string, unknown>[] = [];
for (const k of ks) for (const it of items) {
  const res = await ret.retrieve(it.question, { topK: k, tokenBudget: budget, maxChunksPerFile: mcpf });
  const sent = builder.prepare(res).items;                    // yang benar-benar akan dikirim ke LLM (setelah saring dan anggaran)
  const byScore = [...res.chunks].sort((a, b) => b.score - a.score);
  const rank = byScore.findIndex((c) => it.refs.some((r) => overlaps(c, r))) + 1;
  const cov = coveredRefs(it.refs, res.chunks), covSent = coveredRefs(it.refs, sent);
  rows.push({ k, id: it.id, split: it.split, type: it.type, acuan: it.refs.length, tercakup: cov, tercakup_setelah_gerbang: covSent,
    hit: it.refs.length ? +(cov > 0) : '', recall: it.refs.length ? +(cov / it.refs.length).toFixed(3) : '', rank_pertama: rank || '', rr: it.refs.length ? +(rank ? 1 / rank : 0).toFixed(3) : '',
    potongan: res.chunks.length, token: res.tokenEstimate, ms: +res.timingsMs.total.toFixed(1) });
}
const types: QType[] = ['definition', 'callers', 'flow', 'unanswerable'];
console.log('tipe          K   n   hit    recall  MRR    token');
for (const k of ks) for (const t of types) {
  const r = rows.filter((x) => x.k === k && x.type === t); if (!r.length) continue;
  const m = (key: string) => r.reduce((s, x) => s + Number(x[key] || 0), 0) / r.length;
  const ans = t !== 'unanswerable';
  console.log(`${t.padEnd(13)} ${String(k).padEnd(3)} ${String(r.length).padEnd(3)} ${ans ? (m('hit') * 100).toFixed(0).padStart(3) + '%' : '  -'}  ${ans ? m('recall').toFixed(2) : '  - '}    ${ans ? m('rr').toFixed(2) : ' -  '}   ${m('token').toFixed(0)}`);
}
const miss = rows.filter((r) => r.acuan && !r.hit); if (miss.length) console.log('\nTanpa acuan tercakup: ' + miss.map((r) => `${r.id}@K${r.k}`).join(', '));
const partial = rows.filter((r) => r.acuan && r.hit && Number(r.recall) < 1); if (partial.length) console.log('Acuan tercakup sebagian: ' + partial.map((r) => `${r.id}@K${r.k}(${r.tercakup}/${r.acuan})`).join(', '));
if (opt.out) { mkdirSync(dirname(opt.out), { recursive: true }); writeFileSync(opt.out, toCsv(rows)); console.log(`\nCSV: ${opt.out}`); }
store.close();
