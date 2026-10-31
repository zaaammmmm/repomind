import type Database from 'better-sqlite3';
import type { Citation, SummarySection } from '../contracts.js';
import type { SqliteIndexStore } from '../store/index-store.js';

export type ReadText = (path: string) => string | undefined;
const cit = (path: string, s = 1, e = s): Citation => ({ path, startLine: s, endLine: e });
const topDir = (dir: string) => (dir === '' ? '(akar)' : dir.split('/').slice(0, 2).join('/'));

/**
 * Ringkasan deterministik (FR-SUM-01..04). Dihitung langsung dari indeks pada setiap pemanggilan (murni fungsi dari isi indeks),
 * sehingga tidak pernah usang (spec-amendments A-07). Cache hanya akan dipakai untuk hasil perhalusan LLM.
 */
export class DeterministicSummary {
  private readonly db: Database.Database;
  constructor(store: SqliteIndexStore, private readonly readText: ReadText = () => undefined) { this.db = store.db; }

  async get(): Promise<SummarySection[]> { return this.compute(); }

  compute(): SummarySection[] {
    return [this.general(), this.entrypoints(), this.topModules(), this.exportsPerDir(), this.docs(), this.dirs()];
  }

  private one<T>(sql: string, ...a: unknown[]) { return this.db.prepare(sql).get(...a) as T; }
  private all<T>(sql: string, ...a: unknown[]) { return this.db.prepare(sql).all(...a) as T[]; }

  private general(): SummarySection {
    const c = this.one<{ files: number; tsx: number; syms: number; comps: number; perr: number; unres: number; ext: number }>(`select
      (select count(*) from files) files, (select count(*) from files where ext = '.tsx') tsx,
      (select count(*) from symbols where parent_id is null) syms, (select count(*) from symbols where kind = 'component') comps,
      (select count(*) from files where parse_error = 1) perr,
      (select count(*) from imports where status = 'unresolved' and is_dynamic = 0) unres,
      (select count(distinct external_package) from imports where status = 'external') ext`);
    const items = [
      { text: `${c.files} file TypeScript (${c.files - c.tsx} .ts, ${c.tsx} .tsx)` },
      { text: `${c.syms} simbol tingkat atas, termasuk ${c.comps} komponen React` },
      { text: `${c.ext} paket eksternal diimpor` },
    ];
    if (c.perr) items.push({ text: `${c.perr} file memiliki error sintaks (diindeks sebagian)` });
    if (c.unres) items.push({ text: `${c.unres} import tidak terselesaikan` });
    return { key: 'general', title: 'Ikhtisar', stale: false, items };
  }

  private entrypoints(): SummarySection {
    const items: SummarySection['items'] = []; const seen = new Set<string>();
    const indexed = new Set(this.all<{ path: string }>('select path from files').map((r) => r.path));
    const add = (p: string, why: string) => { if (!seen.has(p)) { seen.add(p); items.push({ text: `${p} (${why})`, citation: cit(p) }); } };
    const paths = [...indexed];
    const PREFERRED = /^(src|source|lib)\//;
    // Petakan target build (mis. ./distribution/index.js) ke sumber: cocok persis, lalu buang segmen direktori awal satu per satu
    // dan terima kecocokan sufiks hanya bila unik (atau tepat satu yang berada di src/source/lib).
    const map = (target: string): string | undefined => {
      const segs = target.replace(/^\.\//, '').replace(/\.(d\.ts|[cm]?js|tsx?|jsx)$/, '').split('/').filter(Boolean);
      for (let k = 0; k < segs.length; k++) {
        const stem = segs.slice(k).join('/');
        const hits = paths.filter((p) => k === 0 ? (p === `${stem}.ts` || p === `${stem}.tsx`) : (p === `${stem}.ts` || p === `${stem}.tsx` || p.endsWith(`/${stem}.ts`) || p.endsWith(`/${stem}.tsx`)));
        if (hits.length === 1) return hits[0];
        if (hits.length > 1) { const pref = hits.filter((h) => PREFERRED.test(h)); if (pref.length === 1) return pref[0]; return undefined; }
      }
      return undefined;
    };
    const pkgText = this.readText('package.json');
    if (pkgText) {
      try {
        const pkg = JSON.parse(pkgText) as Record<string, unknown>;
        const targets: [string, unknown][] = [['main', pkg.main], ['module', pkg.module], ['types', pkg.types ?? pkg.typings], ['bin', pkg.bin]];
        const exp = pkg.exports;
        const flat = (v: unknown, out: string[] = []): string[] => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') Object.values(v).forEach((x) => flat(x, out)); return out; };
        for (const [k, v] of targets) for (const t of flat(v)) { const m = map(t); if (m) add(m, `package.json: ${k}`); }
        for (const t of flat(exp)) { const m = map(t); if (m) add(m, 'package.json: exports'); }
      } catch { /* package.json tidak valid: abaikan */ }
    }
    for (const r of this.all<{ path: string }>(`select path from files where path in ('index.ts','src/index.ts','source/index.ts','src/main.ts','src/main.tsx','src/index.tsx') order by path`)) add(r.path, 'file index/main');
    const heur = this.all<{ path: string }>(`select f.path from files f
        left join (select to_file_id id, count(*) c from v_file_edges group by to_file_id) i on i.id = f.id
        left join (select from_file_id id, count(*) c from v_file_edges group by from_file_id) o on o.id = f.id
        where coalesce(i.c, 0) = 0 and coalesce(o.c, 0) >= 3 and f.path not like '%test%' and f.path not like '%.spec.%' order by o.c desc, f.path limit 3`);
    for (const r of heur) add(r.path, 'heuristik: tidak diimpor siapa pun, mengimpor banyak modul');
    return { key: 'entrypoints', title: 'Titik masuk', stale: false, items: items.length ? items : [{ text: 'Tidak terdeteksi.' }] };
  }

  private topModules(): SummarySection {
    const rows = this.all<{ path: string; n: number }>(`select f.path, count(*) n from v_file_edges e join files f on f.id = e.to_file_id group by f.id order by n desc, f.path limit 5`);
    return { key: 'top_modules', title: 'Modul paling banyak dipakai', stale: false, items: rows.map((r) => ({ text: `${r.path}: dipakai oleh ${r.n} file`, citation: cit(r.path) })) };
  }

  private exportsPerDir(): SummarySection {
    const rows = this.all<{ dir: string; path: string; n: string; line: number }>(`select f.dir, f.path, e.export_name n, e.line from exports e join files f on f.id = e.file_id
      where e.kind in ('named','default') order by f.dir, f.path, e.line`);
    const byDir = new Map<string, typeof rows>();
    for (const r of rows) { const d = topDir(r.dir); byDir.set(d, [...(byDir.get(d) ?? []), r]); }
    const items = [...byDir].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1)).slice(0, 8).map(([d, rs]) => ({
      text: `${d}: ${rs.length} ekspor (${rs.slice(0, 5).map((r) => r.n).join(', ')}${rs.length > 5 ? ', ...' : ''})`, citation: cit(rs[0]!.path, rs[0]!.line) }));
    return { key: 'exports_per_dir', title: 'Ekspor publik per direktori', stale: false, items };
  }

  private docs(): SummarySection {
    const r = this.one<{ total: number; documented: number }>(`select count(*) total, coalesce(sum(has_jsdoc), 0) documented from symbols where kind in ('function','component') and parent_id is null`);
    const pct = r.total ? Math.round((r.documented / r.total) * 100) : 0;
    return { key: 'docs', title: 'Dokumentasi', stale: false, items: [{ text: `Komentar JSDoc ada pada ${pct}% fungsi dan komponen (${r.documented} dari ${r.total})` }] };
  }

  private dirs(): SummarySection {
    const rows = this.all<{ dir: string; files: number; syms: number }>(`select f.dir, count(distinct f.id) files, count(s.id) syms from files f left join symbols s on s.file_id = f.id and s.parent_id is null group by f.dir`);
    const g = new Map<string, { files: number; syms: number }>();
    for (const r of rows) { const d = topDir(r.dir); const a = g.get(d) ?? { files: 0, syms: 0 }; a.files += r.files; a.syms += r.syms; g.set(d, a); }
    return { key: 'dirs', title: 'Struktur direktori', stale: false, items: [...g].sort((a, b) => b[1].files - a[1].files || (a[0] < b[0] ? -1 : 1)).slice(0, 15).map(([d, v]) => ({ text: `${d}: ${v.files} file, ${v.syms} simbol` })) };
  }
}
