import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MemFs, newEngine, ev } from './helpers/memfs.js';
import { HybridRetriever } from '../src/retrieval/retriever.js';
import { analyzeQuery, ftsMatchExpr } from '../src/retrieval/query.js';

const FILES: Record<string, string> = {
  'src/auth/token.ts': `/** Menandatangani token akses. */\nexport function signToken(payload: { sub: string }): string {\n  return JSON.stringify(payload);\n}\n\nexport function verifyToken(t: string): boolean {\n  return t.length > 0;\n}\n\nexport const TOKEN_TTL_SECONDS = 3600;\n`,
  'src/auth/login.ts': `import { signToken } from './token';\n\n/** Login pengguna lalu terbitkan token. */\nexport async function login(email: string) {\n  const token = signToken({ sub: email });\n  return { token, expiresIn: 3600 };\n}\n`,
  'src/mw/guard.ts': `import { verifyToken } from '../auth/token';\n\nexport function guard(header: string) {\n  return verifyToken(header.replace('Bearer ', ''));\n}\n`,
  'src/ui/LoginForm.tsx': `import { login } from '../auth/login';\n\nexport const LoginForm = () => {\n  const submit = () => login('a@b.c');\n  return <form onSubmit={submit}>masuk</form>;\n};\n`,
  'src/util/format.ts': `export function formatCurrency(n: number) { return n.toFixed(2); }\nexport function formatDate(d: Date) { return d.toISOString(); }\n`,
  'src/db/pool.ts': `export class ConnectionPool {\n  size = 10;\n  acquire() { return this.size; }\n}\n`,
};
let store: ReturnType<typeof newEngine>['store']; let r: HybridRetriever; let fs: MemFs;
beforeAll(async () => { fs = new MemFs(FILES); const e = newEngine(fs); await e.orch.fullRebuild(); store = e.store; r = new HybridRetriever(store); });
afterAll(() => store.close());
const paths = (res: Awaited<ReturnType<HybridRetriever['retrieve']>>) => res.chunks.map((c) => c.path);

describe('analisis kueri', () => {
  it('memecah camelCase, membuang stopword Indonesia dan Inggris', () => {
    const a = analyzeQuery('Bagaimana fungsi signToken membuat token akses?');
    expect(a.terms).toEqual(expect.arrayContaining(['signtoken', 'sign', 'token', 'fungsi', 'membuat', 'akses']));
    expect(a.terms).not.toContain('bagaimana');
    expect(a.identifiers).toEqual(['signToken']);
  });
  it('path dan backtick dikenali', () => {
    const a = analyzeQuery('lihat `TOKEN_TTL_SECONDS` di src/auth/token.ts');
    expect(a.identifiers).toContain('TOKEN_TTL_SECONDS');
    expect(a.pathHints).toEqual(['src/auth/token.ts']);
    expect(a.terms).toEqual(expect.arrayContaining(['auth', 'token']));
  });
  it('ekspresi MATCH aman terhadap operator dan kutip', () => {
    expect(ftsMatchExpr(['a"b', 'x*', 'AND', 'ok_1'])).toBe('"ab" OR "AND" OR "ok_1"');
    expect(ftsMatchExpr(['', 'a'])).toBeUndefined();
  });
});

describe('retrieval hybrid (FR-RET-01..04)', () => {
  it('nama simbol persis: definisi selalu masuk dan pemakainya ikut lewat graf', async () => {
    const res = await r.retrieve('signToken');
    const top = res.chunks.find((c) => c.symbol === 'signToken')!;
    expect(top.path).toBe('src/auth/token.ts');
    expect(top.reason).toContain('simbol cocok persis: signToken');
    expect(paths(res)).toContain('src/auth/login.ts');
    // chunk header (import) hanya ditemukan lewat teks; chunk fungsi login ditemukan lewat graf (pemakai signToken)
    expect(res.chunks.filter((c) => c.path === 'src/auth/login.ts').some((c) => c.sources.includes('graph'))).toBe(true);
  });

  it('pertanyaan bahasa alami: menemukan fungsi lewat istilah dan ekspansi ke callee', async () => {
    const res = await r.retrieve('how does the login create a token');
    expect(paths(res)).toEqual(expect.arrayContaining(['src/auth/login.ts', 'src/auth/token.ts']));
    expect(res.chunks.find((c) => c.path === 'src/auth/token.ts')!.sources).toContain('graph');
  });

  it('pecahan camelCase: "format currency" menemukan formatCurrency', async () => {
    const res = await r.retrieve('format currency');
    expect(res.chunks[0]!.symbol ?? res.chunks[0]!.path).toBeTruthy();
    expect(res.chunks.some((c) => c.text.includes('formatCurrency'))).toBe(true);
  });

  it('kelas dan member: kueri nama kelas mengembalikan chunk kelas', async () => {
    const res = await r.retrieve('ConnectionPool acquire');
    expect(res.chunks.some((c) => c.path === 'src/db/pool.ts')).toBe(true);
  });

  it('literal angka ditemukan lewat teks', async () => {
    expect(paths(await r.retrieve('3600'))).toEqual(expect.arrayContaining(['src/auth/login.ts', 'src/auth/token.ts']));
  });

  it('mematuhi anggaran token, topK, dan maks chunk per file', async () => {
    const res = await r.retrieve('token login guard format pool', { topK: 3, tokenBudget: 60, maxChunksPerFile: 1 });
    expect(res.tokenEstimate).toBeLessThanOrEqual(60 + Math.max(...res.chunks.map((c) => c.tokenEst))); // definisi persis boleh melampaui sendiri
    expect(res.chunks.length).toBeLessThanOrEqual(3);
    const counts = new Map<string, number>(); for (const c of res.chunks) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(1);
    const strict = await r.retrieve('token', { topK: 50, tokenBudget: 30, maxChunksPerFile: 50 });
    expect(strict.chunks.filter((c) => !c.reason.includes('cocok persis')).reduce((n, c) => n + c.tokenEst, 0)).toBeLessThanOrEqual(30);
  });

  it('deklarasi yang dipisah baris kosong TIDAK digabung (teks harus selaras dengan rentang baris)', async () => {
    const res = await r.retrieve('signToken verifyToken TOKEN_TTL_SECONDS', { topK: 10, tokenBudget: 4000, maxChunksPerFile: 5 });
    const t = res.chunks.filter((c) => c.path === 'src/auth/token.ts');
    expect(t).toHaveLength(3);
    for (const c of t) expect(c.text.split('\n').length).toBe(c.endLine - c.startLine + 1);
  });

  it('menggabungkan chunk yang bersebelahan persis (fungsi besar yang dipecah per baris)', async () => {
    const body = Array.from({ length: 150 }, (_, i) => `  const v${i} = marker(${i}, 'xxxxxxxxxxxxxxxx');`).join('\n');
    const src = `export function big() {\n${body}\n}\n`;
    const f2 = new MemFs({ 'big.ts': src }); const e = newEngine(f2); await e.orch.fullRebuild();
    expect((e.store.db.prepare('select count(*) c from chunks').get() as { c: number }).c).toBeGreaterThan(2);
    const res = await new HybridRetriever(e.store).retrieve('marker', { topK: 20, tokenBudget: 4000, maxChunksPerFile: 20 });
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0]!.text).toBe(src.trimEnd());
    expect(res.chunks[0]!.startLine).toBe(1);
    expect(res.chunks[0]!.endLine).toBe(152);
    e.store.close();
  });

  it('keluaran terurut per file dan baris; membawa skor, sumber, dan alasan', async () => {
    const res = await r.retrieve('token login');
    const key = res.chunks.map((c) => `${c.path}:${String(c.startLine).padStart(5, '0')}`);
    expect(key).toEqual([...key].sort());
    for (const c of res.chunks) { expect(c.score).toBeGreaterThan(0); expect(c.sources.length).toBeGreaterThan(0); expect(c.reason.length).toBeGreaterThan(0); }
    expect(res.timingsMs.total).toBeGreaterThan(0);
  });

  it('deterministik', async () => {
    const strip = (x: Awaited<ReturnType<HybridRetriever['retrieve']>>) => ({ ...x, timingsMs: 0 });
    expect(strip(await r.retrieve('login token'))).toEqual(strip(await r.retrieve('login token')));
  });

  it('kueri kosong, hanya stopword, atau penuh karakter khusus tidak error', async () => {
    for (const q of ['', '   ', 'apa yang the of', '"( AND OR NOT * ) ^ :', "'; drop table files; --", 'a b c', '`', '\\ % _']) {
      const res = await r.retrieve(q); expect(res.chunks).toBeDefined();
    }
    expect((await r.retrieve('')).chunks).toEqual([]);
  });

  it('tidak melakukan panggilan jaringan', async () => {
    const f = vi.fn(() => { throw new Error('JARINGAN'); }); vi.stubGlobal('fetch', f);
    try { await r.retrieve('login token'); } finally { vi.unstubAllGlobals(); }
    expect(f).not.toHaveBeenCalled();
  });

  it('mengikuti pembaruan inkremental (FTS konsisten setelah edit, pindah, hapus)', async () => {
    const f2 = new MemFs(FILES); const e = newEngine(f2); await e.orch.fullRebuild(); const rr = new HybridRetriever(e.store);
    expect(paths(await rr.retrieve('uniqueMarkerAlpha'))).toEqual([]);
    f2.write('src/util/format.ts', FILES['src/util/format.ts'] + 'export const uniqueMarkerAlpha = 1;\n'); await e.orch.onEvents([ev('src/util/format.ts')]);
    expect(paths(await rr.retrieve('uniqueMarkerAlpha'))).toEqual(['src/util/format.ts']);
    f2.move('src/util/format.ts', 'src/shared/format.ts'); await e.orch.onEvents([ev('src/util/format.ts', 'delete'), ev('src/shared/format.ts', 'create')]);
    expect(paths(await rr.retrieve('uniqueMarkerAlpha'))).toEqual(['src/shared/format.ts']);
    f2.remove('src/shared/format.ts'); await e.orch.onEvents([ev('src/shared/format.ts', 'delete')]);
    expect(paths(await rr.retrieve('uniqueMarkerAlpha'))).toEqual([]);
    e.store.close();
  });

  it('definisi dipaksa masuk hanya untuk identifier eksplisit, bukan kata umum', async () => {
    const forcedPersis = await r.retrieve('ConnectionPool', { tokenBudget: 1 });       // identifier eksplisit: tetap masuk walau melampaui anggaran
    expect(forcedPersis.chunks.some((c) => c.path === 'src/db/pool.ts')).toBe(true);
    const plain = await r.retrieve('acquire', { tokenBudget: 1 });                       // kata huruf kecil biasa: tunduk pada anggaran
    expect(plain.chunks).toEqual([]);
  });

  it('chunk header berisi import tidak mengisi hasil, tetapi header berisi export (barrel) tetap boleh', async () => {
    const res = await r.retrieve('signToken');
    expect(res.chunks.every((c) => c.symbol !== undefined || c.text.includes('export'))).toBe(true);
    expect(res.chunks.some((c) => c.text.trim() === "import { signToken } from './token';")).toBe(false);
    const f2 = new MemFs({ 'core.ts': 'export const widgetFactory = 1;\n', 'index.ts': "export * from './core';\nexport { widgetFactory as wf } from './core';\n" });
    const e = newEngine(f2); await e.orch.fullRebuild();
    expect((await new HybridRetriever(e.store).retrieve('widgetFactory')).chunks.map((c) => c.path)).toEqual(['core.ts', 'index.ts']);
    e.store.close();
  });

  it('opsi testPenalty menurunkan skor berkas uji secara proporsional (nonaktif secara bawaan)', async () => {
    const f2 = new MemFs({ 'src/calc.ts': 'export function computeTotal(a: number) { return a; }\n', 'test/calc.test.ts': 'export function computeTotal(a: number) { return a + 1; }\n' });
    const e = newEngine(f2); await e.orch.fullRebuild(); const rr = new HybridRetriever(e.store);
    const score = (res: Awaited<ReturnType<HybridRetriever['retrieve']>>, p: string) => res.chunks.find((c) => c.path === p)!.score;
    const off = await rr.retrieve('computeTotal'); const on = await rr.retrieve('computeTotal', { testPenalty: 0.5 });
    expect(score(on, 'src/calc.ts')).toBeCloseTo(score(off, 'src/calc.ts'), 10);
    expect(score(on, 'test/calc.test.ts')).toBeCloseTo(score(off, 'test/calc.test.ts') * 0.5, 10);
    e.store.close();
  });
});
