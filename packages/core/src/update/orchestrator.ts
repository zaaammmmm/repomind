import { createHash } from 'node:crypto';
import type { FsEvent, PosixPath, ReconcileResult, UpdateReport } from '../contracts.js';
import { analyze, ANALYZER_VERSION } from '../analyzer/analyze.js';
import { TsResolver } from '../resolver/resolver.js';
import type { SqliteIndexStore } from '../store/index-store.js';
import type { WorkspaceFs } from './workspace-fs.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const isTs = (p: string) => p.endsWith('.ts') || p.endsWith('.tsx');
const isConfig = (p: string) => /(^|\/)(tsconfig|jsconfig)\.json$/.test(p);
const extOf = (p: string) => (p.endsWith('.tsx') ? '.tsx' : '.ts');

interface Plan {
  add: PosixPath[]; edit: PosixPath[]; delete: PosixPath[]; move: { from: PosixPath; to: PosixPath }[];
  sources: Map<PosixPath, string>;
  stats: Map<PosixPath, { sizeBytes: number; mtimeMs: number }>;
}

export interface OrchestratorOptions { floodThreshold: number; now: () => number }

/**
 * Update Orchestrator (bagian 3.3). Invarian: dump(incremental(S, D)) == dump(full(S + D)).
 * Strategi: edit saja -> relink file itu + dependen (bila permukaan ekspor berubah); tambah/hapus/pindah/tsconfig -> relink semua (tanpa parse).
 */
export class UpdateOrchestrator {
  private readonly opt: OrchestratorOptions;
  constructor(private readonly store: SqliteIndexStore, private readonly ws: WorkspaceFs, opt: Partial<OrchestratorOptions> = {}) {
    this.opt = { floodThreshold: 200, now: () => Date.now(), ...opt };
  }

  private resolver() { return new TsResolver(this.ws.root, this.ws.tsconfigs(), (p) => this.store.hasFile(p), this.ws.resolverFs); }
  private configHash(): string { return sha256(this.ws.tsconfigs().map((p) => `${p}\n${this.ws.resolverFs.readFile(`${this.ws.root}/${p}`) ?? ''}`).join('\n--\n')); }

  // ---------------------------------------------------------------- titik masuk
  /** Startup (FR-UPD-07/08): bangun penuh bila kosong atau versi analyzer berbeda; selain itu rekonsiliasi lalu terapkan. */
  async sync(): Promise<UpdateReport> {
    const v = this.store.getMeta('analyzer_version');
    if (v === undefined || Number(v) !== ANALYZER_VERSION) return this.fullRebuild();
    return this.apply(await this.reconcile());
  }

  async fullRebuild(): Promise<UpdateReport> {
    const t0 = performance.now();
    const files = this.ws.list();
    this.store.transaction(() => {
      this.store.clear();
      for (const f of files) {
        const src = this.ws.read(f.path);
        this.store.replaceFile(analyze(f.path, src, f.path.endsWith('.tsx')), f, this.opt.now());
      }
      this.store.relink(this.resolver(), 'all');
      this.store.setMeta('analyzer_version', String(ANALYZER_VERSION));
      this.store.setMeta('tsconfig_hash', this.configHash());
      this.store.setMeta('last_sync_ms', String(this.opt.now()));
    });
    return { changed: files.length, affected: 0, skipped: 0, reparsed: files.length, rebound: files.length, entriesUpdated: files.length, durationMs: performance.now() - t0, kind: 'full' };
  }

  async onEvents(events: FsEvent[]): Promise<UpdateReport> {
    const t0 = performance.now(); // durasi mencakup pemindaian, hashing, dan klasifikasi (bukan hanya penulisan)
    const paths = [...new Set(events.map((e) => e.path))].sort();
    if (paths.length > this.opt.floodThreshold || paths.some((p) => p.endsWith('.gitignore'))) return this.apply(await this.reconcile(), t0);
    return this.applyPlan(this.classify(paths, new Map(this.ws.list().map((f) => [f.path, f]))), paths.some(isConfig), 'incremental', t0);
  }

  async reconcile(): Promise<ReconcileResult> {
    const cur = new Map(this.ws.list().map((f) => [f.path, f]));
    const indexed = this.store.listFiles();
    const all = new Set<string>([...cur.keys(), ...indexed.map((f) => f.path)]);
    const plan = this.classify([...all].sort(), cur);
    const matching = cur.size - plan.add.length - plan.edit.length - plan.move.length;
    return { matching, changed: plan.edit, added: [...plan.add, ...plan.move.map((m) => m.to)].sort(), missing: [...plan.delete, ...plan.move.map((m) => m.from)].sort() };
  }

  async apply(r: ReconcileResult, t0 = performance.now()): Promise<UpdateReport> {
    const paths = [...new Set([...r.changed, ...r.added, ...r.missing])].sort();
    const cur = new Map(this.ws.list().map((f) => [f.path, f]));
    return this.applyPlan(this.classify(paths, cur), this.store.getMeta('tsconfig_hash') !== this.configHash(), 'reconcile', t0);
  }

  async reindexFile(p: PosixPath): Promise<UpdateReport> {
    const t0 = performance.now();
    const cur = new Map(this.ws.list().map((f) => [f.path, f]));
    const f = cur.get(p);
    if (!f) throw new Error(`reindexFile: ${p} tidak dapat diindeks`);
    const plan: Plan = { add: [], edit: this.store.hasFile(p) ? [p] : [], delete: [], move: [], sources: new Map([[p, this.ws.read(p)]]), stats: new Map([[p, f]]) };
    if (!plan.edit.length) plan.add.push(p);
    return this.applyPlan(plan, false, 'incremental', t0);
  }

  // ---------------------------------------------------------------- klasifikasi
  private classify(paths: PosixPath[], cur: Map<PosixPath, { sizeBytes: number; mtimeMs: number }>): Plan {
    const plan: Plan = { add: [], edit: [], delete: [], move: [], sources: new Map(), stats: new Map() };
    const hashOf = new Map<PosixPath, string>();
    for (const p of paths) {
      if (!isTs(p)) continue;
      const onDisk = cur.get(p); const row = this.store.getFile(p);
      if (onDisk && !row) { const src = this.ws.read(p); plan.sources.set(p, src); plan.stats.set(p, onDisk); hashOf.set(p, sha256(src)); plan.add.push(p); }
      else if (onDisk && row) {
        if (onDisk.mtimeMs === row.mtimeMs && onDisk.sizeBytes === row.sizeBytes) continue; // jalur cepat
        const src = this.ws.read(p); const h = sha256(src);
        if (h === row.contentHash) { this.store.touchFile(p, onDisk); continue; }
        plan.sources.set(p, src); plan.stats.set(p, onDisk); plan.edit.push(p);
      } else if (!onDisk && row) plan.delete.push(p);
    }
    // deteksi pindah: hapus + tambah dengan hash dan ekstensi sama (pasangan terurut agar deterministik)
    const used = new Set<string>();
    for (const d of [...plan.delete].sort()) {
      const dh = this.store.getFile(d)!.contentHash;
      const a = [...plan.add].sort().find((x) => !used.has(x) && hashOf.get(x) === dh && extOf(x) === extOf(d));
      if (a) { used.add(a); plan.move.push({ from: d, to: a }); }
    }
    plan.add = plan.add.filter((x) => !used.has(x));
    plan.delete = plan.delete.filter((d) => !plan.move.some((m) => m.from === d));
    for (const m of plan.move) { plan.sources.delete(m.to); const st = cur.get(m.to)!; plan.stats.set(m.to, st); }
    return plan;
  }

  // ---------------------------------------------------------------- terapkan
  private applyPlan(plan: Plan, configChanged: boolean, kind: 'incremental' | 'reconcile', t0: number): UpdateReport {
    const totalChanged = plan.add.length + plan.edit.length + plan.delete.length + plan.move.length;
    if (totalChanged === 0 && !configChanged) return { changed: 0, affected: 0, skipped: this.store.counts().files, reparsed: 0, rebound: 0, entriesUpdated: 0, durationMs: performance.now() - t0, kind };

    let rebound = 0; let affected = new Set<number>(); const parsedIds = new Set<number>();
    this.store.transaction(() => {
      for (const d of plan.delete) this.store.deleteFile(d);
      for (const m of plan.move) { this.store.renameFile(m.from, m.to); const st = plan.stats.get(m.to)!; this.store.touchFile(m.to, st); }
      const surfaceChanged: number[] = []; const edited: number[] = [];
      for (const p of [...plan.add, ...plan.edit]) {
        const facts = analyze(p, plan.sources.get(p)!, p.endsWith('.tsx'));
        const r = this.store.replaceFile(facts, plan.stats.get(p)!, this.opt.now());
        parsedIds.add(r.fileId);
        if (!r.inserted) { edited.push(r.fileId); if (r.previousSurfaceHash !== facts.exportSurfaceHash) surfaceChanged.push(r.fileId); }
      }
      const structural = plan.add.length > 0 || plan.delete.length > 0 || plan.move.length > 0 || configChanged;
      const resolver = this.resolver();
      let res: { relinked: number; changed: Set<number> };
      if (structural) res = this.store.relink(resolver, 'all');
      else {
        // A-05: replaceFile mereset tautan file yang diedit. Relink file-file itu DULU supaya sisi graf (termasuk re-export)
        // pulih, baru hitung rantai dependen dari permukaan ekspor yang berubah, lalu relink dependen.
        const editedSet = new Set(edited);
        const r1 = this.store.relink(resolver, editedSet);
        const dep = new Set<number>();
        for (const f of surfaceChanged) for (const d of this.store.dependentClosure(f)) if (!editedSet.has(d)) dep.add(d);
        const r2 = dep.size ? this.store.relink(resolver, dep) : { relinked: 0, changed: new Set<number>() };
        for (const d of dep) affected.add(d);
        res = { relinked: r1.relinked + r2.relinked, changed: new Set([...r1.changed, ...r2.changed]) };
      }
      rebound = res.relinked;
      for (const c of res.changed) affected.add(c);
      this.store.setMeta('analyzer_version', String(ANALYZER_VERSION));
      this.store.setMeta('tsconfig_hash', this.configHash());
      this.store.setMeta('last_sync_ms', String(this.opt.now()));
    });
    affected = new Set([...affected].filter((i) => !parsedIds.has(i)));
    const total = this.store.counts().files;
    return { changed: totalChanged, affected: affected.size, skipped: Math.max(0, total - totalChanged - affected.size), reparsed: parsedIds.size, rebound, entriesUpdated: totalChanged + affected.size, durationMs: performance.now() - t0, kind };
  }
}
