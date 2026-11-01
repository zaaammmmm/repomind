// Jalankan Scanner + Analyzer + Resolver pada repo nyata:
//   npm run try-repo -w @repomind/core -- /path/absolut/ke/repo
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanWorkspace } from '../src/scanner/scan.ts';
import { analyze } from '../src/analyzer/analyze.ts';
import { TsResolver } from '../src/resolver/resolver.ts';

const arg = process.argv[2];
if (!arg) {
  console.error('Pemakaian: npm run try-repo -w @repomind/core -- /path/absolut/ke/repo');
  console.error('Catatan: npm menjalankan skrip dari folder packages/core, jadi gunakan path ABSOLUT.');
  process.exit(1);
}
const root = resolve(arg);
if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`Folder tidak ditemukan: ${root}`);
  process.exit(1);
}

const t0 = performance.now();
const scan = scanWorkspace(root);
const t1 = performance.now();
const indexed = new Set(scan.files.map((f) => f.path));
const facts = scan.files.map((f) => analyze(f.path, readFileSync(join(root, f.path), 'utf8'), f.path.endsWith('.tsx')));
const t2 = performance.now();
const resolver = new TsResolver(root, scan.tsconfigs, (p) => indexed.has(p));
const status = { resolved: 0, external: 0, unresolved: 0 };
const fanIn = new Map<string, number>();
const unresolved = new Map<string, number>();
const external = new Map<string, number>();
for (const f of facts) for (const imp of f.imports) {
  if (imp.isDynamic) continue;
  const r = resolver.resolve(f.path, imp.specifier);
  status[r.status]++;
  if (r.status === 'resolved') fanIn.set(r.resolvedPath!, (fanIn.get(r.resolvedPath!) ?? 0) + 1);
  if (r.status === 'unresolved') unresolved.set(imp.specifier, (unresolved.get(imp.specifier) ?? 0) + 1);
  if (r.status === 'external') external.set(r.externalPackage!, (external.get(r.externalPackage!) ?? 0) + 1);
}
const t3 = performance.now();
const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);

console.log({
  files: scan.files.length, tsconfigs: scan.tsconfigs, skipped: scan.skipped,
  symbols: facts.reduce((n, f) => n + f.symbols.length, 0),
  parseErrors: facts.filter((f) => f.parseError).length,
  imports: status, configErrors: resolver.configErrors,
  ms: { scan: Math.round(t1 - t0), analyze: Math.round(t2 - t1), resolve: Math.round(t3 - t2) },
});
console.log('fan-in teratas:', top(fanIn, 5));
console.log('paket eksternal teratas:', top(external, 5));
console.log('unresolved teratas:', top(unresolved, 8));
