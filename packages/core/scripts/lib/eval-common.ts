// Bagian bersama skrip evaluasi: pemuatan dataset (JSONL), validasi acuan terhadap repo, tumpang-tindih rentang, dan pembuatan indeks.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openIndex } from '../../src/store/open.ts';
import { SqliteIndexStore } from '../../src/store/index-store.ts';
import { UpdateOrchestrator } from '../../src/update/orchestrator.ts';
import { NodeWorkspaceFs } from '../../src/update/workspace-fs.ts';

export type QType = 'definition' | 'callers' | 'flow' | 'unanswerable';
export interface Ref { path: string; startLine: number; endLine: number }
export interface Item { id: string; split: 'dev' | 'test'; type: QType; question: string; refs: Ref[]; incomplete_refs?: boolean; note?: string }
export interface Range { path: string; startLine: number; endLine: number }

export const overlaps = (a: Range, b: Range) => a.path === b.path && a.startLine <= b.endLine && a.endLine >= b.startLine;
/** Jumlah acuan yang tercakup oleh minimal satu rentang. */
export const coveredRefs = (refs: Ref[], ranges: Range[]) => refs.filter((r) => ranges.some((x) => overlaps(x, r))).length;

export function parseArgs(argv: string[]) {
  const pos: string[] = []; const opt: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]!; if (a.startsWith('--')) { opt[a.slice(2)] = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : '1'; } else pos.push(a); }
  return { pos, opt };
}

/** Item bertanda `incomplete_refs: true` (acuan tidak lengkap, A-15) dikecualikan dari metrik utama kecuali `includeIncomplete`; tetap divalidasi dan tetap ada di berkas. */
export function loadDataset(file: string, root: string, split: string, includeIncomplete = false): Item[] {
  const items: Item[] = []; const seen = new Set<string>(); const problems: string[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let it: Item; try { it = JSON.parse(line) as Item; } catch { problems.push(`baris ${i + 1}: bukan JSON`); return; }
    const where = `baris ${i + 1} (${it.id ?? '?'})`;
    if (!it.id || seen.has(it.id)) problems.push(`${where}: id kosong atau ganda`); seen.add(it.id);
    if (!['dev', 'test'].includes(it.split)) problems.push(`${where}: split harus dev atau test`);
    if (!['definition', 'callers', 'flow', 'unanswerable'].includes(it.type)) problems.push(`${where}: type tidak dikenal`);
    if (!it.question?.trim()) problems.push(`${where}: pertanyaan kosong`);
    if (it.incomplete_refs !== undefined && it.incomplete_refs !== true) problems.push(`${where}: incomplete_refs hanya boleh true (hapus bidangnya bila lengkap)`);
    if (it.incomplete_refs && !it.note?.trim()) problems.push(`${where}: incomplete_refs wajib disertai note (alasan dan id pengganti)`);
    if (it.type === 'unanswerable' ? it.refs?.length : !it.refs?.length) problems.push(`${where}: refs ${it.type === 'unanswerable' ? 'harus kosong' : 'wajib diisi'}`);
    for (const r of it.refs ?? []) {
      const f = join(root, r.path);
      if (!existsSync(f)) { problems.push(`${where}: berkas tidak ada: ${r.path}`); continue; }
      const n = readFileSync(f, 'utf8').split('\n').length;
      if (!(r.startLine >= 1 && r.endLine >= r.startLine && r.endLine <= n)) problems.push(`${where}: rentang ${r.path}:${r.startLine}-${r.endLine} di luar berkas (${n} baris)`);
    }
    items.push(it);
  });
  if (problems.length) { console.error('Dataset tidak valid:\n  ' + problems.join('\n  ')); process.exit(1); }
  const inSplit = items.filter((x) => split === 'all' || x.split === split);
  const excluded = inSplit.filter((x) => x.incomplete_refs);
  if (excluded.length) console.log(includeIncomplete ? `Perhatian: menyertakan item beracuan tidak lengkap: ${excluded.map((x) => x.id).join(', ')} (jangan dilaporkan sebagai metrik utama)` : `Dikecualikan dari metrik utama (acuan tidak lengkap): ${excluded.map((x) => x.id).join(', ')}; gunakan --include-incomplete untuk menyertakan`);
  return includeIncomplete ? inSplit : inSplit.filter((x) => !x.incomplete_refs);
}

export async function buildIndex(rootArg: string) {
  const root = resolve(rootArg);
  const store = new SqliteIndexStore(openIndex(':memory:').db);
  await new UpdateOrchestrator(store, new NodeWorkspaceFs(root)).fullRebuild();
  return { root, store, files: store.counts().files };
}

export const csvCell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (rows: Record<string, unknown>[]) => { if (!rows.length) return ''; const cols = Object.keys(rows[0]!); return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n'; };
