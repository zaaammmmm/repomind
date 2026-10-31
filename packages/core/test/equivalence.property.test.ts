import { describe, it } from 'vitest';
import fc from 'fast-check';
import { posix } from 'node:path';
import { MemFs, newEngine, freshDump, ev } from './helpers/memfs.js';

/**
 * NFR-R-01 / FR-IDX-06: untuk repo S dan urutan perubahan D acak,
 * dump(incremental(S, D)) harus identik dengan dump(full(S + D)) setelah SETIAP batch.
 */
const PATHS = ['a.ts', 'b.ts', 'x/c.ts', 'x/d.ts', 'x/index.ts', 'ui/v.tsx'];
const DENSE = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
const MOVE_TARGETS = ['e.ts', 'y/b2.ts', 'x/a.ts', 'x/index2.ts', 'ui/w.tsx'];
const NAMES = ['f', 'g', 'h'];

interface Spec {
  imports: { target: string; alias: boolean; names: string[]; style: 'named' | 'default' | 'ns' | 'type' }[];
  exports: { name: string; kind: 'function' | 'const' | 'class' | 'none'; sig: number }[];
  reexports: { target: string; style: 'star' | 'named' | 'renamed' | 'ns' }[];
  body: number; defaultExport: boolean; jsx: boolean;
}

const mkSpecArb = (pool: string[], dense: boolean): fc.Arbitrary<Spec> => fc.record({
  imports: fc.array(fc.record({
    target: fc.constantFrom(...pool, ...(dense ? [] : ['ghost.ts', ...MOVE_TARGETS])), alias: dense ? fc.constant(false) : fc.boolean(),
    names: fc.subarray(NAMES, { minLength: 1 }), style: fc.constantFrom('named', 'named', 'default', 'ns', 'type'),
  }), { maxLength: 3 }),
  exports: fc.array(fc.record({ name: fc.constantFrom(...NAMES), kind: fc.constantFrom('function', 'const', 'class', 'none'), sig: fc.integer({ min: 0, max: 2 }) }), { maxLength: 3 }),
  reexports: fc.array(fc.record({ target: fc.constantFrom(...pool), style: fc.constantFrom('star', 'star', 'named', 'renamed', 'ns') }), { maxLength: dense ? 3 : 2 }),
  body: fc.integer({ min: 0, max: 3 }), defaultExport: fc.boolean(), jsx: fc.boolean(),
});
const specArb = mkSpecArb(PATHS, false);
const denseSpecArb = mkSpecArb(DENSE, true);

function render(self: string, s: Spec): string {
  const spec = (t: string, alias: boolean) => { const noExt = t.replace(/\.tsx?$/, ''); return alias ? `@/${noExt}` : (posix.relative(posix.dirname(self), noExt).startsWith('.') ? posix.relative(posix.dirname(self), noExt) : './' + posix.relative(posix.dirname(self), noExt)); };
  const L: string[] = []; const used: string[] = []; let n = 0;
  for (const i of s.imports) {
    const from = spec(i.target, i.alias); const nm = i.names.map((x) => `${x}${n}`); n++;
    if (i.style === 'named') { L.push(`import { ${i.names.map((x, k) => `${x} as ${nm[k]}`).join(', ')} } from '${from}';`); used.push(...nm); }
    else if (i.style === 'type') L.push(`import type { ${i.names.join(', ')} } from '${from}';`);
    else if (i.style === 'default') { L.push(`import D${n} from '${from}';`); used.push(`D${n}`); }
    else { L.push(`import * as NS${n} from '${from}';`); used.push(`NS${n}`); }
  }
  for (const r of s.reexports) {
    const from = spec(r.target, false);
    L.push(r.style === 'star' ? `export * from '${from}';` : r.style === 'named' ? `export { f } from '${from}';` : r.style === 'renamed' ? `export { g as h } from '${from}';` : `export * as nsx from '${from}';`);
  }
  const seen = new Set<string>();
  for (const e of s.exports) {
    if (e.kind === 'none' || seen.has(e.name)) continue; seen.add(e.name);
    const params = Array.from({ length: e.sig }, (_, k) => `p${k}: number`).join(', ');
    const calls = used.slice(0, s.body).map((u) => `${u}()`).join(' + ') || '0';
    if (e.kind === 'function') L.push(`/** doc ${e.name} */\nexport function ${e.name}(${params}) { return ${calls}; }`);
    else if (e.kind === 'const') L.push(`export const ${e.name} = (${params}) => ${calls};`);
    else L.push(`export class ${e.name} { m(${params}) { return ${calls}; } }`);
  }
  if (s.defaultExport) L.push(`export default function main() { return ${used[0] ?? '1'}; }`);
  if (self.endsWith('.tsx') && s.jsx) L.push(`export const View = () => <div>{${used[0] ? used[0] + '()' : '1'}}</div>;`);
  return L.join('\n') + '\n';
}

type Op =
  | { op: 'write'; path: string; spec: Spec } | { op: 'delete'; path: string }
  | { op: 'move'; from: string; to: string } | { op: 'tsconfig'; alias: boolean };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ op: fc.constant('write' as const), path: fc.constantFrom(...PATHS, ...MOVE_TARGETS), spec: specArb }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('delete' as const), path: fc.constantFrom(...PATHS, ...MOVE_TARGETS) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('move' as const), from: fc.constantFrom(...PATHS), to: fc.constantFrom(...MOVE_TARGETS) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('tsconfig' as const), alias: fc.boolean() }) },
);
const batchArb = fc.array(opArb, { minLength: 1, maxLength: 3 });

describe('kesetaraan inkremental vs rebuild (uji properti)', () => {
  it('dump identik setelah setiap batch perubahan acak', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.tuple(fc.constantFrom(...PATHS), specArb), { minLength: 1, maxLength: 5 }),
      fc.array(batchArb, { minLength: 1, maxLength: 6 }),
      async (initial, batches) => {
        const fs = new MemFs();
        for (const [p, s] of initial) fs.write(p, render(p, s));
        const { store, orch } = newEngine(fs);
        await orch.fullRebuild();
        for (const batch of batches) {
          const events = [];
          for (const o of batch) {
            if (o.op === 'write') { events.push(ev(o.path, fs.has(o.path) ? 'change' : 'create')); fs.write(o.path, render(o.path, o.spec)); }
            else if (o.op === 'delete' && fs.has(o.path)) { fs.remove(o.path); events.push(ev(o.path, 'delete')); }
            else if (o.op === 'move' && fs.has(o.from) && !fs.has(o.to) && o.from.endsWith('.tsx') === o.to.endsWith('.tsx')) { fs.move(o.from, o.to); events.push(ev(o.from, 'delete'), ev(o.to, 'create')); }
            else if (o.op === 'tsconfig') { fs.write('tsconfig.json', JSON.stringify({ compilerOptions: o.alias ? { baseUrl: '.', paths: { '@/*': ['*'] } } : {} })); events.push(ev('tsconfig.json')); }
          }
          await orch.onEvents(events);
          const inc = store.canonicalDump(); const full = await freshDump(fs);
          if (inc !== full) throw new Error(`Dump berbeda setelah batch ${JSON.stringify(batch).slice(0, 400)}`);
        }
        store.close();
      }),
      { numRuns: Number(process.env.PROP_RUNS ?? 150), verbose: 1 });
  }, 300_000);
});

describe('kesetaraan pada jalur edit-saja (graf padat: barrel, re-export berantai, id simbol stabil)', () => {
  it('dump identik setelah setiap batch edit', async () => {
    await fc.assert(fc.asyncProperty(
      fc.tuple(denseSpecArb, denseSpecArb, denseSpecArb, denseSpecArb),
      fc.array(fc.array(fc.tuple(fc.constantFrom(...DENSE), denseSpecArb, fc.constantFrom('new', 'body', 'body')), { minLength: 1, maxLength: 2 }), { minLength: 1, maxLength: 8 }),
      async (initial, batches) => {
        const fs = new MemFs();
        const specs = new Map<string, Spec>();
        DENSE.forEach((p, i) => { specs.set(p, initial[i]!); fs.write(p, render(p, initial[i]!)); });
        const { store, orch } = newEngine(fs);
        await orch.fullRebuild();
        for (const batch of batches) {
          const events = [];
          for (const [p, spec, mode] of batch) {
            // 'body': pertahankan ekspor/impor, ubah hanya isi (permukaan ekspor tetap) -> menguji jalur tanpa propagasi
            const next: Spec = mode === 'body' ? { ...specs.get(p)!, body: spec.body } : spec;
            specs.set(p, next); fs.write(p, render(p, next) + (mode === 'body' ? `// rev ${events.length}\n` : '')); events.push(ev(p));
          }
          const rep = await orch.onEvents(events);
          if (rep.kind !== 'incremental') throw new Error('uji ini harus lewat jalur inkremental');
          if (store.canonicalDump() !== (await freshDump(fs))) throw new Error(`Dump berbeda setelah edit ${JSON.stringify(batch).slice(0, 500)}`);
        }
        store.close();
      }),
      { numRuns: Number(process.env.PROP_RUNS ?? 150) });
  }, 300_000);
});
