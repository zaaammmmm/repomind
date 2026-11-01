import { describe, it, expect } from 'vitest';
import { MemFs, newEngine, freshDump, ev } from './helpers/memfs.js';

const token = (body = 'return JSON.stringify(p);', sig = 'p: { sub: string }') => `export function signToken(${sig}): string {\n  ${body}\n}\nexport const TTL = 3600;\n`;
const login = `import { signToken } from './token';\nexport function login(e: string) { return signToken({ sub: e }); }\n`;
const guard = `import { signToken, TTL } from '../auth/token';\nexport function guard() { return TTL + signToken({ sub: 'x' }).length; }\n`;
const base = () => new MemFs({ 'src/auth/token.ts': token(), 'src/auth/login.ts': login, 'src/mw/guard.ts': guard, 'src/util/hash.ts': 'export const h = 1;\n', 'src/db.ts': 'export const db = 1;\n' });

const refTargets = (store: ReturnType<typeof newEngine>['store'], file: string) =>
  store.db.prepare(`select r.name, r.target_symbol_id t from symbol_refs r join files f on f.id=r.file_id where f.path=? order by r.id`).all(file);

describe('UpdateOrchestrator: kriteria penerimaan SRS (FR-UPD-*)', () => {
  it('build penuh menautkan referensi lintas file', async () => {
    const fs = base(); const { store, orch } = newEngine(fs); await orch.fullRebuild();
    const r = store.db.prepare(`select s.qualified_name q, f.path p from symbol_refs r join files rf on rf.id=r.file_id join symbols s on s.id=r.target_symbol_id join files f on f.id=s.file_id where rf.path='src/auth/login.ts' and r.name='signToken'`).get();
    expect(r).toEqual({ q: 'signToken', p: 'src/auth/token.ts' });
    expect(store.importersOf('src/auth/token.ts')).toEqual(['src/auth/login.ts', 'src/mw/guard.ts']);
  });

  it('FR-UPD-04a: ubah isi fungsi tanpa ubah ekspor: hanya 1 file diparse, dependen tidak berubah, dump = rebuild', async () => {
    const fs = base(); const { store, orch } = newEngine(fs); await orch.fullRebuild();
    const before = refTargets(store, 'src/auth/login.ts');
    fs.write('src/auth/token.ts', token('// komentar\n  return p.sub + "!";'));
    const rep = await orch.onEvents([ev('src/auth/token.ts')]);
    expect(rep).toMatchObject({ changed: 1, reparsed: 1, affected: 0, rebound: 1 });
    expect(refTargets(store, 'src/auth/login.ts')).toEqual(before);
    expect(store.canonicalDump()).toBe(await freshDump(fs));
  });

  it('FR-UPD-04b: ubah signature: dependen di-relink, id simbol stabil, dump = rebuild', async () => {
    const fs = base(); const { store, orch } = newEngine(fs); await orch.fullRebuild();
    const idBefore = store.db.prepare(`select s.id from symbols s join files f on f.id=s.file_id where f.path='src/auth/token.ts' and s.name='signToken'`).get();
    fs.write('src/auth/token.ts', token('return p.sub;', 'p: { sub: string }, ttl: number'));
    const rep = await orch.onEvents([ev('src/auth/token.ts')]);
    expect(rep.reparsed).toBe(1);
    expect(rep.affected).toBe(2); // login.ts dan guard.ts
    expect(store.db.prepare(`select s.id from symbols s join files f on f.id=s.file_id where f.path='src/auth/token.ts' and s.name='signToken'`).get()).toEqual(idBefore);
    expect(store.canonicalDump()).toBe(await freshDump(fs));
  });

  it('simpan tanpa perubahan isi: dilewati lewat hash (FR-UPD-02)', async () => {
    const fs = base(); const { orch } = newEngine(fs); await orch.fullRebuild();
    fs.write('src/db.ts', 'export const db = 1;\n'); // mtime berubah, isi sama
    expect(await orch.onEvents([ev('src/db.ts')])).toMatchObject({ changed: 0, reparsed: 0 });
  });

  it('FR-UPD-03: pindah file tanpa parse ulang; FTS dan graf konsisten', async () => {
    const fs = base(); const { store, orch } = newEngine(fs); await orch.fullRebuild();
    fs.move('src/util/hash.ts', 'src/shared/hash.ts');
    const rep = await orch.onEvents([ev('src/util/hash.ts', 'delete'), ev('src/shared/hash.ts', 'create')]);
    expect(rep).toMatchObject({ changed: 1, reparsed: 0 });
    expect(store.getFile('src/shared/hash.ts')).toBeTruthy();
    expect(store.getFile('src/util/hash.ts')).toBeUndefined();
    expect(store.db.prepare(`select path from chunks_fts where chunks_fts match 'h'`).all()).toEqual([{ path: 'src/shared/hash.ts' }]);
    expect(store.canonicalDump()).toBe(await freshDump(fs));
  });

  it('pindah file yang diimpor: import dependen menjadi unresolved, lalu pulih bila diperbarui', async () => {
    const fs = base(); const { store, orch } = newEngine(fs); await orch.fullRebuild();
    fs.move('src/auth/token.ts', 'src/auth/jwt.ts');
    await orch.onEvents([ev('src/auth/token.ts', 'delete'), ev('src/auth/jwt.ts', 'create')]);
    expect(store.db.prepare(`select status from imports i join files f on f.id=i.file_id where f.path='src/auth/login.ts'`).get()).toEqual({ status: 'unresolved' });
    expect(store.canonicalDump()).toBe(await freshDump(fs));
    fs.write('src/auth/login.ts', login.replace('./token', './jwt'));
    await orch.onEvents([ev('src/auth/login.ts')]);
    expect(store.canonicalDump()).toBe(await freshDump(fs));
    expect(store.importersOf('src/auth/jwt.ts')).toContain('src/auth/login.ts');
  });

  it('hapus file: dependen unresolved dan dump = rebuild', async () => {
    const fs = base(); const { store, orch } = newEngine(fs); await orch.fullRebuild();
    fs.remove('src/auth/token.ts');
    await orch.onEvents([ev('src/auth/token.ts', 'delete')]);
    expect(store.db.prepare(`select count(*) c from imports where status='unresolved'`).get()).toEqual({ c: 2 });
    expect(store.canonicalDump()).toBe(await freshDump(fs));
  });

  it('tambah file menyelesaikan import yang sebelumnya unresolved', async () => {
    const fs = new MemFs({ 'a.ts': `import { late } from './late';\nexport const x = late();\n` }); const { store, orch } = newEngine(fs); await orch.fullRebuild();
    expect(store.db.prepare(`select status from imports`).get()).toEqual({ status: 'unresolved' });
    fs.write('late.ts', 'export function late() { return 1; }\n');
    await orch.onEvents([ev('late.ts', 'create')]);
    expect(store.db.prepare(`select status from imports`).get()).toEqual({ status: 'resolved' });
    expect(store.canonicalDump()).toBe(await freshDump(fs));
  });

  it('bayangan (shadowing): a.ts baru mengalahkan a/index.ts yang sudah terselesaikan', async () => {
    const fs = new MemFs({ 'main.ts': `import { v } from './a';\nexport const y = v;\n`, 'a/index.ts': 'export const v = 1;\n' }); const { store, orch } = newEngine(fs); await orch.fullRebuild();
    fs.write('a.ts', 'export const v = 2;\n');
    await orch.onEvents([ev('a.ts', 'create')]);
    expect(store.db.prepare(`select rf.path p from imports i join files rf on rf.id=i.resolved_file_id`).get()).toEqual({ p: 'a.ts' });
    expect(store.canonicalDump()).toBe(await freshDump(fs));
  });

  it('A-04: barrel (export *) meneruskan perubahan permukaan ekspor ke pengimpor barrel (hanya edit)', async () => {
    const fs = new MemFs({ 'core.ts': 'export const a = 1;\n', 'barrel.ts': `export * from './core';\n`, 'use.ts': `import { b } from './barrel';\nexport const z = b;\n` });
    const { store, orch } = newEngine(fs); await orch.fullRebuild();
    expect(refTargets(store, 'use.ts')).toEqual([{ name: 'b', t: null }]);
    fs.write('core.ts', 'export const a = 1;\nexport const b = 2;\n');
    const rep = await orch.onEvents([ev('core.ts')]);
    expect(rep.reparsed).toBe(1);
    expect((refTargets(store, 'use.ts')[0] as { t: number | null }).t).not.toBeNull();
    expect(store.canonicalDump()).toBe(await freshDump(fs));
  });

  it('perubahan tsconfig (alias) menautkan ulang tanpa parse', async () => {
    const fs = new MemFs({ 'src/x.ts': 'export const x = 1;\n', 'a.ts': `import { x } from '@/x';\nexport const y = x;\n`, 'tsconfig.json': '{}' });
    const { store, orch } = newEngine(fs); await orch.fullRebuild();
    expect(store.db.prepare(`select status from imports`).get()).toEqual({ status: 'external' });
    fs.write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
    const rep = await orch.onEvents([ev('tsconfig.json')]);
    expect(rep.reparsed).toBe(0);
    expect(store.db.prepare(`select status from imports`).get()).toEqual({ status: 'resolved' });
    expect(store.canonicalDump()).toBe(await freshDump(fs));
  });

  it('FR-UPD-07: sync() merekonsiliasi perubahan di luar event (mis. git checkout)', async () => {
    const fs = base(); const { store, orch } = newEngine(fs); await orch.fullRebuild();
    fs.write('src/db.ts', 'export const db = 2;\nexport const more = 3;\n');
    fs.remove('src/util/hash.ts'); fs.write('src/new.ts', `import { db } from './db';\nexport const n = db;\n`);
    const rec = await orch.reconcile();
    expect(rec).toMatchObject({ changed: ['src/db.ts'], added: ['src/new.ts'], missing: ['src/util/hash.ts'] });
    await orch.sync();
    expect(store.canonicalDump()).toBe(await freshDump(fs));
  });

  it('banjir event beralih ke rekonsiliasi (FR-UPD-10)', async () => {
    const fs = base(); const { store, orch } = newEngine(fs, { floodThreshold: 2 }); await orch.fullRebuild();
    fs.write('src/db.ts', 'export const db = 9;\n'); fs.write('src/auth/login.ts', login + '// x\n'); fs.remove('src/util/hash.ts');
    const rep = await orch.onEvents([ev('src/db.ts'), ev('src/auth/login.ts'), ev('src/util/hash.ts', 'delete')]);
    expect(rep.kind).toBe('reconcile');
    expect(store.canonicalDump()).toBe(await freshDump(fs));
  });

  it('syntax error: file tetap terindeks dan dump = rebuild', async () => {
    const fs = base(); const { store, orch } = newEngine(fs); await orch.fullRebuild();
    fs.write('src/db.ts', 'export const db = 1;\nexport function broken( {\n');
    await orch.onEvents([ev('src/db.ts')]);
    expect(store.getFile('src/db.ts')!.parseError).toBe(true);
    expect(store.canonicalDump()).toBe(await freshDump(fs));
  });

  it('regresi A-05: file barrel ikut diedit dalam batch yang sama dengan sumber re-export-nya', async () => {
    // Ditemukan uji properti (seed 868397970). Tautan file yang diedit direset replaceFile; rantai dependen harus dihitung SETELAH relink file itu.
    const fs = new MemFs({
      'a.ts': '', 'd.ts': '',
      'b.ts': `import { f as f0 } from './c';\nexport function f() { return f0(); }\n`,
      'c.ts': `export * from './a';\n`,
    });
    const { store, orch } = newEngine(fs); await orch.fullRebuild();
    expect(refTargets(store, 'b.ts')).toEqual([{ name: 'f0', t: null }]);
    fs.write('c.ts', `export * from './a';\n// rev 0\n`);
    fs.write('a.ts', 'export function f() { return 0; }\n');
    const rep = await orch.onEvents([ev('c.ts'), ev('a.ts')]);
    expect(rep.kind).toBe('incremental');
    expect((refTargets(store, 'b.ts')[0] as { t: number | null }).t).not.toBeNull();
    expect(store.canonicalDump()).toBe(await freshDump(fs));
  });
});
