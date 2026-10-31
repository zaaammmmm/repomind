import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MemFs, newEngine } from './helpers/memfs.js';
import { LocalQaService, classifyIntent, slotCandidates } from '../src/qa/router.js';
import { DeterministicSummary } from '../src/summary/summary.js';
import type { LocalAnswer } from '../src/contracts.js';

const FILES: Record<string, string> = {
  'src/auth/token.ts': `/** Menandatangani token. */\nexport function signToken(p: { sub: string }): string {\n  return JSON.stringify(p);\n}\nexport function verifyToken(t: string): boolean { return t.length > 0; }\nexport const TTL = 3600;\n`,
  'src/auth/login.ts': `import { signToken } from './token';\n\n/** Login pengguna. */\nexport async function login(email: string) {\n  const token = signToken({ sub: email });\n  return { token, expiresIn: 3600 };\n}\n`,
  'src/mw/guard.ts': `import { verifyToken, TTL } from '../auth/token';\nexport function guard(t: string) { return verifyToken(t) && TTL > 0; }\n`,
  'src/ui/Button.tsx': `export function Button() { return <button>ok</button>; }\n`,
  'src/ui/LoginForm.tsx': `import { Button } from './Button';\nimport { Spinner } from 'ui-lib';\nimport { login } from '../auth/login';\nexport const LoginForm = () => { login('x'); return <form><Button /><Spinner /></form>; };\n`,
  'src/ui/index.ts': `export * from './Button';\nexport * from './LoginForm';\n`,
  'src/pages/Home.tsx': `import { LoginForm } from '../ui';\nexport function Home() { return <LoginForm />; }\n`,
  'src/util/format.ts': `export function format(n: number) { return String(n); }\nexport function pad(s: string) { return s; }\n`,
  'src/util/other/format.ts': `export function format(s: string) { return s.trim(); }\n`,
  'src/main.ts': `import { Home } from './pages/Home';\nimport { guard } from './mw/guard';\nimport { format } from './util/format';\nexport const app = [Home, guard, format];\n`,
};
let qa: LocalQaService; let store: ReturnType<typeof newEngine>['store']; let summary: DeterministicSummary;

beforeAll(async () => {
  const fs = new MemFs(FILES); const e = newEngine(fs); await e.orch.fullRebuild();
  store = e.store; qa = new LocalQaService(store);
  summary = new DeterministicSummary(store, (p) => (p === 'package.json' ? JSON.stringify({ main: 'dist/main.js', bin: { app: './dist/main.js' } }) : undefined));
});
const ask = (q: string) => qa.answer(q);
const secs = (a: LocalAnswer) => { if (a.type !== 'answer') throw new Error(`bukan answer: ${JSON.stringify(a)}`); return a.sections; };
const cites = (a: LocalAnswer, i: number) => secs(a)[i]!.citations.map((c) => `${c.path}:${c.startLine}`);

describe('klasifikasi intent (ID dan EN)', () => {
  const table: [string, string][] = [
    ['Di mana signToken didefinisikan?', 'DEFINITION'], ['dimana fungsi login dibuat', 'DEFINITION'], ['Where is signToken defined?', 'DEFINITION'], ['definisi dari TTL', 'DEFINITION'], ['where is Button', 'DEFINITION'],
    ['Siapa saja yang memakai signToken?', 'USAGES'], ['di mana signToken digunakan?', 'USAGES'], ['Who uses signToken?', 'USAGES'], ['where is signToken used', 'USAGES'], ['usages of TTL', 'USAGES'],
    ['File apa yang bergantung pada src/auth/token.ts?', 'FILE_DEPENDENTS'], ['siapa mengimpor token.ts', 'FILE_DEPENDENTS'], ['Which files import token.ts?', 'FILE_DEPENDENTS'], ['dependents of src/auth/token.ts', 'FILE_DEPENDENTS'],
    ['Apa yang diekspor modul src/auth/token.ts?', 'MODULE_EXPORTS'], ['isi modul token.ts', 'MODULE_EXPORTS'], ['What does token.ts export?', 'MODULE_EXPORTS'], ['exports of src/ui/index.ts', 'MODULE_EXPORTS'],
    ['Daftar fungsi di direktori src/util', 'DIR_FUNCTIONS'], ['list functions in src/util', 'DIR_FUNCTIONS'], ['tampilkan semua fungsi di folder util', 'DIR_FUNCTIONS'],
    ['Komponen apa yang dipakai LoginForm?', 'COMPONENT_USES'], ['Which components does LoginForm render?', 'COMPONENT_USES'], ['komponen apa yang dirender oleh Home', 'COMPONENT_USES'],
    ['File apa yang terdampak jika token.ts diubah?', 'IMPACT'], ['What is affected if signToken changes?', 'IMPACT'], ['apa yang terdampak bila Button diubah', 'IMPACT'],
    ['Mengapa token kedaluwarsa dihitung 3600 detik?', 'NEEDS_LLM'], ['Why is the TTL 3600?', 'NEEDS_LLM'], ['Jelaskan tanggung jawab modul auth', 'NEEDS_LLM'], ['Bagaimana alur autentikasi saat login berjalan?', 'NEEDS_LLM'],
    ['buatkan unit test untuk login', 'UNSUPPORTED'], ['refactor fungsi guard', 'UNSUPPORTED'], ['halo', 'UNSUPPORTED'],
  ];
  it.each(table)('%s -> %s', (q, expected) => { expect(classifyIntent(q)).toBe(expected); });
  it('akurasi 100% pada tabel acuan', () => { expect(table.filter(([q, e]) => classifyIntent(q) !== e)).toEqual([]); });
});

describe('slot', () => {
  it('mengutamakan kutipan, lalu path, lalu identifier', () => {
    expect(slotCandidates('di mana `signToken` dipakai di src/auth/login.ts?').map((c) => c.text)).toEqual(['signToken', 'src/auth/login.ts']);
    expect(slotCandidates('Siapa memakai signToken?')[0]).toEqual({ text: 'signToken', rank: 2 });
  });
});

describe('jawaban per intent', () => {
  it('DEFINITION mengembalikan lokasi dan signature', () => {
    const a = ask('Di mana signToken didefinisikan?');
    expect(secs(a)[0]!.citations).toEqual([{ path: 'src/auth/token.ts', startLine: 2, endLine: 4 }]);
    expect(secs(a)[0]!.text).toContain('export function signToken');
  });
  it('DEFINITION: nama ganda menghasilkan disambiguasi', () => {
    const a = ask('di mana fungsi format didefinisikan?');
    expect(a.type).toBe('disambiguation');
    if (a.type === 'disambiguation') expect(a.options.map((o) => o.path).sort()).toEqual(['src/util/format.ts', 'src/util/other/format.ts']);
  });
  it('USAGES: definisi, lokasi pemakaian, dan bergantung pada', () => {
    const a = ask('Siapa saja yang memakai signToken?');
    expect(cites(a, 1)).toEqual(['src/auth/login.ts:5']);
    expect(secs(a)[2]!.text).toBe('Tidak ada dependensi internal.');
    const b = ask('Siapa yang memakai login?');
    expect(cites(b, 1)).toEqual(['src/ui/LoginForm.tsx:4']);
    expect(secs(b)[2]!.text).toContain('src/auth/token.ts');
  });
  it('USAGES: "siapa mengimpor <simbol>" jatuh ke pemakaian simbol', () => {
    expect(ask('siapa mengimpor signToken').type).toBe('answer');
    expect(cites(ask('siapa mengimpor signToken'), 1)).toEqual(['src/auth/login.ts:5']);
  });
  it('FILE_DEPENDENTS: termasuk sisi re-export (barrel)', () => {
    expect(cites(ask('File apa yang bergantung pada src/auth/token.ts?'), 0)).toEqual(['src/auth/login.ts:1', 'src/mw/guard.ts:1']);
    expect(cites(ask('file apa yang mengimpor Button.tsx'), 0)).toEqual(['src/ui/LoginForm.tsx:1', 'src/ui/index.ts:1']);
  });
  it('MODULE_EXPORTS: dikelompokkan menurut jenis, teks sejajar dengan sitasi', () => {
    const s = secs(ask('Apa yang diekspor modul src/auth/token.ts?'));
    expect(s.map((x) => x.title)).toEqual(['Fungsi (2)', 'Variabel dan lainnya (1)']);
    expect(s[0]!.text!.split('\n')).toHaveLength(s[0]!.citations.length);
    expect(s[0]!.text).toContain('signToken');
    expect(secs(ask('exports of src/ui/index.ts'))[0]!.title).toBe('Re-ekspor (2)');
  });
  it('DIR_FUNCTIONS: hanya fungsi tingkat atas, termasuk subdirektori', () => {
    const s = secs(ask('Daftar fungsi di direktori src/util'));
    expect(s.map((x) => x.title)).toEqual(['Direktori src/util: 3 fungsi di 2 file', 'src/util/format.ts (2)', 'src/util/other/format.ts (1)']);
  });
  it('COMPONENT_USES: memisahkan komponen internal dan eksternal', () => {
    const s = secs(ask('Komponen apa yang dipakai LoginForm?'));
    expect(s[1]!.text).toContain('Button (src/ui/Button.tsx)');
    expect(s[2]!.text).toContain('Spinner (dari ui-lib)');
  });
  it('IMPACT file: penutup transitif per kedalaman, melewati barrel', () => {
    const s = secs(ask('File apa yang terdampak jika src/ui/Button.tsx diubah?'));
    expect(s.map((x) => x.title).slice(1)).toEqual(['Kedalaman 1 (2 file)', 'Kedalaman 2 (1 file)', 'Kedalaman 3 (1 file)']);
    expect(s[1]!.text).toBe('src/ui/LoginForm.tsx\nsrc/ui/index.ts');
    expect(s[3]!.text).toBe('src/main.ts');
  });
  it('IMPACT simbol: pemakai langsung dan dependen transitif', () => {
    const s = secs(ask('What is affected if verifyToken changes?'));
    expect(s[0]!.text).toBe('src/mw/guard.ts');
    expect(s[1]!.text).toContain('src/main.ts');
  });
});

describe('penolakan (FR-LQA-03)', () => {
  it('NEEDS_LLM memberi bukti parsial dari indeks dan tidak mengarang jawaban', () => {
    const a = ask('Mengapa token kedaluwarsa dihitung 3600 detik?');
    expect(a.type).toBe('refusal');
    if (a.type !== 'refusal') return;
    expect(a.reason).toBe('NEEDS_LLM');
    const ev = a.partialEvidence.map((c) => c.path);
    expect(ev).toContain('src/auth/login.ts');
    expect(ev).toContain('src/auth/token.ts');
    expect(a.supportedIntents).toHaveLength(7);
  });
  it('UNSUPPORTED tanpa bukti', () => {
    expect(ask('buatkan unit test untuk login')).toMatchObject({ type: 'refusal', reason: 'UNSUPPORTED', partialEvidence: [] });
  });
  it('NOT_FOUND dengan saran terdekat', () => {
    expect(ask('di mana signTokn didefinisikan?')).toMatchObject({ type: 'refusal', reason: 'NOT_FOUND', suggestion: 'signToken' });
    expect(ask('siapa memakai zzzNoSuchThing')).toMatchObject({ type: 'refusal', reason: 'NOT_FOUND' });
  });
});

describe('Mode 1 tanpa jaringan dan deterministik (FR-LQA-06, NFR-S-01)', () => {
  it('seluruh intent berjalan dengan fetch dan http diblokir', () => {
    const f = vi.fn(() => { throw new Error('JARINGAN DIPANGGIL'); });
    vi.stubGlobal('fetch', f);
    try {
      for (const q of ['Di mana signToken didefinisikan?', 'Siapa memakai login?', 'file apa yang bergantung pada token.ts', 'isi modul token.ts', 'daftar fungsi di src/util', 'komponen apa yang dipakai LoginForm', 'terdampak jika token.ts diubah', 'mengapa 3600'])
        expect(() => ask(q)).not.toThrow();
    } finally { vi.unstubAllGlobals(); }
    expect(f).not.toHaveBeenCalled();
  });
  it('pertanyaan sama menghasilkan jawaban identik', () => {
    expect(ask('Siapa memakai login?')).toEqual(ask('Siapa memakai login?'));
  });
});

describe('ringkasan deterministik (FR-SUM-01..03)', () => {
  let s: Awaited<ReturnType<DeterministicSummary['get']>>;
  beforeAll(async () => { s = await summary.get(); });
  const sec = (k: string) => s.find((x) => x.key === k)!;
  it('ikhtisar', () => {
    expect(sec('general').items[0]!.text).toBe('10 file TypeScript (7 .ts, 3 .tsx)');
    expect(sec('general').items.map((i) => i.text).join('|')).toContain('1 paket eksternal');
  });
  it('titik masuk dari package.json dan heuristik, dengan sitasi', () => {
    const e = sec('entrypoints').items;
    expect(e[0]).toMatchObject({ text: 'src/main.ts (package.json: main)', citation: { path: 'src/main.ts' } });
  });
  it('titik masuk: memetakan folder build apa pun (distribution/, out/, ...) ke sumber', async () => {
    const fs = new MemFs({ 'source/index.ts': 'export const a = 1;\n', 'source/cli.ts': 'export const c = 1;\n', 'test/index.ts': 'export const t = 1;\n' });
    const e = newEngine(fs); await e.orch.fullRebuild();
    const pkg = JSON.stringify({ main: './distribution/index.js', types: './distribution/index.d.ts', exports: { default: './distribution/index.js' }, bin: { x: 'out/cli.js' } });
    const items = (await new DeterministicSummary(e.store, (p) => (p === 'package.json' ? pkg : undefined)).get()).find((x) => x.key === 'entrypoints')!.items.map((i) => i.text);
    expect(items).toContain('source/index.ts (package.json: main)');
    expect(items).toContain('source/cli.ts (package.json: bin)');
    expect(items.filter((i) => i.startsWith('source/index.ts'))).toHaveLength(1);
  });
  it('modul paling banyak dipakai', () => {
    expect(sec('top_modules').items[0]!.text).toBe('src/auth/token.ts: dipakai oleh 2 file');
  });
  it('cakupan JSDoc', () => {
    expect(sec('docs').items[0]!.text).toBe('Komentar JSDoc ada pada 20% fungsi dan komponen (2 dari 10)');
  });
  it('struktur direktori dan ekspor per direktori memakai dua segmen teratas', () => {
    expect(sec('dirs').items.map((i) => i.text)).toContain('src/ui: 3 file, 2 simbol');
    expect(sec('exports_per_dir').items[0]!.citation).toBeTruthy();
  });
  it('tidak pernah usang: mengikuti perubahan indeks', async () => {
    const fs = new MemFs({ 'a.ts': 'export const a = 1;\n' }); const e = newEngine(fs); await e.orch.fullRebuild();
    const sm = new DeterministicSummary(e.store);
    expect((await sm.get())[0]!.items[0]!.text).toBe('1 file TypeScript (1 .ts, 0 .tsx)');
    fs.write('b.ts', 'export const b = 2;\n'); await e.orch.onEvents([{ path: 'b.ts', type: 'create', atMs: 0 }]);
    expect((await sm.get())[0]!.items[0]!.text).toBe('2 file TypeScript (2 .ts, 0 .tsx)');
  });
});
afterAll(() => store.close());
