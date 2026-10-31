// Tanya jawab Mode 1 pada repo nyata (tanpa LLM, tanpa jaringan):
//   npm run ask-repo -w @repomind/core -- /path/absolut/ke/repo "pertanyaan 1" "pertanyaan 2" ...
// Tanpa pertanyaan: mode interaktif (ketik pertanyaan, Enter; kosong untuk keluar).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { openIndex } from '../src/store/open.ts';
import { SqliteIndexStore } from '../src/store/index-store.ts';
import { UpdateOrchestrator } from '../src/update/orchestrator.ts';
import { NodeWorkspaceFs } from '../src/update/workspace-fs.ts';
import { LocalQaService } from '../src/qa/router.ts';
import { DeterministicSummary } from '../src/summary/summary.ts';
import type { LocalAnswer } from '../src/contracts.ts';

const [arg, ...questions] = process.argv.slice(2);
if (!arg || !existsSync(arg)) { console.error('Pemakaian: npm run ask-repo -w @repomind/core -- /path/absolut/ke/repo ["pertanyaan" ...]'); process.exit(1); }
const root = resolve(arg);
const store = new SqliteIndexStore(openIndex(':memory:').db);
const t0 = performance.now();
await new UpdateOrchestrator(store, new NodeWorkspaceFs(root)).fullRebuild();
console.log(`Indeks dibangun: ${store.counts().files} file dalam ${Math.round(performance.now() - t0)} ms\n`);
const qa = new LocalQaService(store);

const print = (q: string, a: LocalAnswer, ms: number) => {
  console.log(`? ${q}   [${ms.toFixed(1)} ms]`);
  if (a.type === 'answer') {
    console.log(`  intent: ${a.intent}`);
    for (const s of a.sections) {
      console.log(`  - ${s.title}`);
      const lines = (s.text ?? '').split('\n').filter(Boolean);
      lines.slice(0, 6).forEach((l) => console.log(`      ${l}`));
      if (lines.length > 6) console.log(`      ... (+${lines.length - 6} lagi)`);
    }
  } else if (a.type === 'disambiguation') {
    console.log('  Maksud Anda yang mana?'); a.options.forEach((o) => console.log(`      ${o.path}:${o.startLine}`));
  } else {
    console.log(`  DITOLAK (${a.reason})${a.suggestion ? `, maksud Anda "${a.suggestion}"?` : ''}`);
    a.partialEvidence.forEach((c) => console.log(`      bukti parsial: ${c.path}:${c.startLine}-${c.endLine}`));
  }
  console.log();
};
const run = (q: string) => { const t = performance.now(); const a = qa.answer(q); print(q, a, performance.now() - t); };

if (questions.length) questions.forEach(run);
else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) { const q = (await rl.question('> ')).trim(); if (!q) break; run(q); }
  rl.close();
}
if (process.env.SUMMARY) {
  const pkg = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : undefined);
  for (const s of await new DeterministicSummary(store, pkg).get()) { console.log(`## ${s.title}`); s.items.forEach((i) => console.log(`  - ${i.text}`)); }
}
