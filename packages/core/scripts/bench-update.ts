// Benchmark awal Eval A pada repo nyata: rebuild penuh vs pembaruan inkremental, plus pemeriksaan kesetaraan.
//   npm run bench-update -w @repomind/core -- /path/absolut/ke/repo
import { cpSync, mkdtempSync, existsSync, writeFileSync, readFileSync, renameSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openIndex } from '../src/store/open.ts';
import { SqliteIndexStore } from '../src/store/index-store.ts';
import { UpdateOrchestrator } from '../src/update/orchestrator.ts';
import { NodeWorkspaceFs } from '../src/update/workspace-fs.ts';

const arg = process.argv[2];
if (!arg || !existsSync(arg)) { console.error('Pemakaian: npm run bench-update -w @repomind/core -- /path/absolut/ke/repo'); process.exit(1); }
const work = mkdtempSync(join(tmpdir(), 'bench-'));
const root = join(work, 'repo');
cpSync(resolve(arg), root, { recursive: true, filter: (s) => !/(^|\/)(\.git|node_modules)(\/|$)/.test(s) });
const ws = new NodeWorkspaceFs(root);
const store = new SqliteIndexStore(openIndex(join(work, 'index.db')).db);
const orch = new UpdateOrchestrator(store, ws);
const ev = (path: string, type: 'create' | 'change' | 'delete' = 'change') => ({ path, type, atMs: Date.now() });
const fresh = async () => { const s = new SqliteIndexStore(openIndex(':memory:').db); const t = performance.now(); await new UpdateOrchestrator(s, ws).fullRebuild(); const ms = performance.now() - t; const d = s.canonicalDump(); s.close(); return { d, ms }; };

const rows: Record<string, unknown>[] = [];
const record = async (name: string, rep: { changed: number; affected: number; reparsed: number; skipped: number; durationMs: number }) => {
  const f = await fresh();
  rows.push({ skenario: name, ms_inkremental: +rep.durationMs.toFixed(1), ms_rebuild_penuh: +f.ms.toFixed(0), berubah: rep.changed, terdampak: rep.affected, diparse: rep.reparsed, dilewati: rep.skipped, setara: store.canonicalDump() === f.d });
};

const t0 = performance.now(); const first = await orch.fullRebuild(); const full = performance.now() - t0;
console.log('rebuild penuh awal:', { files: first.changed, ms: Math.round(full), ...store.counts() });

const files = store.listFiles().map((f) => f.path).filter((p) => p.startsWith('source/'));
const fanIn = (p: string) => store.importersOf(p).length;
const hub = [...files].sort((a, b) => fanIn(b) - fanIn(a))[0]!;
const leaf = [...files].filter((p) => p.endsWith('.ts')).sort((a, b) => fanIn(a) - fanIn(b) || (a < b ? -1 : 1))[0]!; // fan-in terkecil
console.log({ hub, hubFanIn: fanIn(hub), leaf, leafFanIn: fanIn(leaf) });

for (const [name, p] of [['edit isi (daun)', leaf], ['edit isi (hub)', hub]] as const) {
  appendFileSync(join(root, p), `\n// edit ${name}\n`);
  await record(name, await orch.onEvents([ev(p)]));
}
for (const [name, p] of [['ubah permukaan ekspor (daun)', leaf], ['ubah permukaan ekspor (hub)', hub]] as const) {
  appendFileSync(join(root, p), `\nexport const __bench_${Math.random().toString(36).slice(2, 6)} = 1;\n`);
  await record(name, await orch.onEvents([ev(p)]));
}
const nf = join(root, 'source/__baru.ts'); writeFileSync(nf, `import { ${'x'} } from './index';\nexport const baru = 1;\n`);
await record('tambah file', await orch.onEvents([ev('source/__baru.ts', 'create')]));
renameSync(nf, join(root, 'source/__pindah.ts'));
await record('pindah file', await orch.onEvents([ev('source/__baru.ts', 'delete'), ev('source/__pindah.ts', 'create')]));
rmSync(join(root, 'source/__pindah.ts'));
await record('hapus file', await orch.onEvents([ev('source/__pindah.ts', 'delete')]));
writeFileSync(join(root, leaf), readFileSync(join(root, leaf), 'utf8')); // simpan tanpa perubahan isi
await record('simpan tanpa perubahan isi', await orch.onEvents([ev(leaf)]));
console.table(rows);
console.log('integrity_check:', store.integrityCheck(), '| semua setara:', rows.every((r) => r.setara));
rmSync(work, { recursive: true, force: true });
