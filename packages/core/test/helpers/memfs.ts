import type { PosixPath } from '../../src/contracts.js';
import type { WorkspaceFs } from '../../src/update/workspace-fs.js';
import type { ResolverFs } from '../../src/resolver/resolver.js';
import { openIndex } from '../../src/store/open.js';
import { SqliteIndexStore } from '../../src/store/index-store.js';
import { UpdateOrchestrator } from '../../src/update/orchestrator.js';

export class MemFs implements WorkspaceFs {
  readonly root = '/repo';
  private files = new Map<string, { content: string; mtime: number }>();
  private clock = 1000;
  constructor(init: Record<string, string> = {}) { for (const [p, c] of Object.entries(init)) this.write(p, c); }
  write(p: string, content: string) { this.files.set(p, { content, mtime: ++this.clock }); }
  remove(p: string) { this.files.delete(p); }
  move(from: string, to: string) { const f = this.files.get(from)!; this.files.delete(from); this.files.set(to, f); }
  has(p: string) { return this.files.has(p); }
  paths() { return [...this.files.keys()].sort(); }
  list() {
    return [...this.files].filter(([p]) => /\.tsx?$/.test(p) && !p.endsWith('.d.ts'))
      .map(([path, f]) => ({ path, sizeBytes: Buffer.byteLength(f.content), mtimeMs: f.mtime })).sort((a, b) => (a.path < b.path ? -1 : 1));
  }
  read(p: PosixPath) { return this.files.get(p)!.content; }
  tsconfigs() { return this.paths().filter((p) => /(^|\/)tsconfig\.json$/.test(p)); }
  readonly resolverFs: ResolverFs = {
    fileExists: (a) => this.files.has(this.rel(a)),
    readFile: (a) => this.files.get(this.rel(a))?.content,
    directoryExists: (a) => { const r = this.rel(a); return r === '' || this.paths().some((p) => p.startsWith(r + '/')); },
  };
  private rel(abs: string) { return abs.startsWith(this.root + '/') ? abs.slice(this.root.length + 1) : abs === this.root ? '' : abs; }
}

export function newStore() { return new SqliteIndexStore(openIndex(':memory:').db); }
export function newEngine(fs: MemFs, opt = {}) { const store = newStore(); return { store, orch: new UpdateOrchestrator(store, fs, { now: () => 0, ...opt }) }; }
/** Dump indeks yang dibangun dari nol (acuan kesetaraan). */
export async function freshDump(fs: MemFs): Promise<string> { const e = newEngine(fs); await e.orch.fullRebuild(); const d = e.store.canonicalDump(); e.store.close(); return d; }
export const ev = (path: string, type: 'create' | 'change' | 'delete' = 'change') => ({ path, type, atMs: 0 });
