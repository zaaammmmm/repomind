import type Database from 'better-sqlite3';
import type { Citation, Intent, LocalAnswer, LocalQa } from '../contracts.js';
import type { SqliteIndexStore } from '../store/index-store.js';

export const SUPPORTED_INTENTS: Intent[] = ['DEFINITION', 'USAGES', 'FILE_DEPENDENTS', 'MODULE_EXPORTS', 'DIR_FUNCTIONS', 'COMPONENT_USES', 'IMPACT'];
export type Classified = Intent | 'NEEDS_LLM' | 'UNSUPPORTED';

const MAX_ITEMS = 200;

// ---------------------------------------------------------------- klasifikasi (aturan, bagian 3.6)
const REASONING_START = /^(mengapa|kenapa|why|bagaimana|how|jelaskan|explain|ceritakan|apa (dampak|akibat|tujuan|alasan|maksud)|what (happens|is the purpose|is the reason))\b/;
const RULES: { intent: Intent; test: (q: string) => boolean }[] = [
  { intent: 'IMPACT', test: (q) => /\b(terdampak|berdampak|terpengaruh|affected|impacted|impact)\b/.test(q) },
  { intent: 'MODULE_EXPORTS', test: (q) => /(yang (di)?ekspor|diekspor|ekspor(t)? (dari|apa)|isi (modul|file)|\bexports? (of|from)\b|what (does|is) .* export|apa (saja )?ekspor)/.test(q) },
  { intent: 'DIR_FUNCTIONS', test: (q) => /(daftar|list|tampilkan|show|apa saja|what|which|semua|all)\b.*\b(fungsi|functions?)\b/.test(q) && !/(didefinisikan|dideklarasikan|defined|memakai|menggunakan|digunakan|dipakai|used)/.test(q) },
  { intent: 'COMPONENT_USES', test: (q) => /(komponen|components?)\b/.test(q) && /(dipakai|digunakan|dirender|render(s|ed)?|memakai|menggunakan|\buses?\b|\bused\b)/.test(q) && /(\bapa\b|\bwhat\b|\bwhich\b)/.test(q) && !/(siapa|\bwho\b|di ?mana|\bwhere\b)/.test(q) },
  { intent: 'FILE_DEPENDENTS', test: (q) => /(bergantung|mengimpor|mengimport|\bimports?\b|\bimported\b|depends?\b|dependents?)/.test(q) },
  { intent: 'USAGES', test: (q) => /((siapa|\bwho\b).*(memakai|menggunakan|memanggil|\buses?\b|\bcalls?\b|references?)|(di ?mana|\bwhere\b).*(dipakai|digunakan|dipanggil|dirujuk|\bused\b|\bcalled\b|referenced)|\busages? of\b|references? to|pemakai(an)?)/.test(q) },
  { intent: 'DEFINITION', test: (q) => /((di ?mana|\bwhere\b).*(didefinisikan|dideklarasikan|dibuat|defined|declared|located)|\b(definisi|definition|deklarasi|lokasi)\b|^(di ?mana|where is)\s+\S+\s*\??$)/.test(q) },
];

export function classifyIntent(question: string): Classified {
  const q = question.toLowerCase().replace(/\s+/g, ' ').trim();
  if (REASONING_START.test(q)) return 'NEEDS_LLM';
  for (const r of RULES) if (r.test(q)) return r.intent;
  return /\b(mengapa|kenapa|why|jelaskan|explain|bagaimana|how does|how do)\b/.test(q) ? 'NEEDS_LLM' : 'UNSUPPORTED';
}

// ---------------------------------------------------------------- slot
const STOP = new Set(('di mana yang apa siapa saja dari ke untuk dengan pada dan atau ini itu file modul fungsi komponen kelas class direktori folder didefinisikan dideklarasikan dipakai digunakan memakai menggunakan memanggil mengimpor mengimport bergantung terdampak berdampak jika bila kalau diubah daftar semua isi ekspor diekspor dependen lokasi definisi tampilkan berikan tolong dalam oleh dirender dipanggil dimana adalah akan sebuah ' +
  'where is are the a an of in on to who what which uses use used by does do defined declared imports import module function component directory list show all if changed change affected impact exports exported definition usages references dependents render renders for from that this me please find and or with').split(' '));

interface Cand { text: string; rank: number }
export function slotCandidates(question: string): Cand[] {
  const out: Cand[] = [];
  const quoted = /`([^`]+)`|"([^"]+)"|“([^”]+)”/g;
  let rest = question;
  for (const m of question.matchAll(quoted)) out.push({ text: (m[1] ?? m[2] ?? m[3])!.trim(), rank: 0 });
  rest = rest.replace(quoted, ' ');
  for (let raw of rest.split(/[\s,;:!?()[\]{}]+/)) {
    raw = raw.replace(/(\.|'s)$/g, '').replace(/^\.\//, '');
    if (raw.length < 2 || STOP.has(raw.toLowerCase())) continue;
    const rank = /\/|\.(tsx?|jsx?)$/.test(raw) ? 1 : /[a-z][A-Z]|_|^[A-Z][a-z]|\./.test(raw) ? 2 : 3;
    out.push({ text: raw, rank });
  }
  return out.map((c, i) => ({ ...c, i })).sort((a, b) => a.rank - b.rank || a.i - b.i).map(({ text, rank }) => ({ text, rank }));
}

// ---------------------------------------------------------------- akses indeks
interface SymRow { id: number; name: string; qn: string; kind: string; path: string; fileId: number; s: number; e: number; sig: string | null; exported: number }
const cit = (path: string, s: number, e = s): Citation => ({ path, startLine: s, endLine: e });

class Index {
  constructor(private readonly db: Database.Database) {}
  symbols(name: string): SymRow[] {
    const base = `select s.id, s.name, s.qualified_name qn, s.kind, f.path, f.id fileId, s.start_line s, s.end_line e, s.signature sig, s.is_exported exported from symbols s join files f on f.id = s.file_id`;
    const order = ' order by s.is_exported desc, f.path, s.start_line';
    const q = (where: string, ...a: unknown[]) => this.db.prepare(base + ' where ' + where + order).all(...a) as SymRow[];
    let r = name.includes('.') ? q('s.qualified_name = ?', name) : q('s.name = ? and s.parent_id is null', name);
    if (!r.length && !name.includes('.')) r = q('s.name = ?', name);
    if (!r.length) { const ci = q('lower(s.name) = lower(?)', name); if (new Set(ci.map((x) => x.name)).size === 1) r = ci; }
    return r;
  }
  files(name: string): { id: number; path: string }[] {
    const n = name.replace(/^\.?\//, '');
    const all = this.db.prepare('select id, path from files order by length(path), path').all() as { id: number; path: string }[];
    const exact = all.filter((f) => f.path === n);
    if (exact.length) return exact;
    const variants = [n, `${n}.ts`, `${n}.tsx`, `${n}/index.ts`, `${n}/index.tsx`];
    return all.filter((f) => variants.some((v) => f.path === v || f.path.endsWith('/' + v)));
  }
  dirs(name: string): string[] {
    const n = name.replace(/^\.?\//, '').replace(/\/$/, '');
    if (!n) return [];
    const dirs = (this.db.prepare(`select distinct dir from files where dir <> '' order by dir`).all() as { dir: string }[]).map((d) => d.dir);
    const exact = dirs.filter((d) => d === n);
    if (exact.length) return exact;
    return dirs.filter((d) => d.endsWith('/' + n) || d.startsWith(n + '/') || d.includes('/' + n + '/'));
  }
  names(): string[] {
    const s = (this.db.prepare('select distinct name from symbols where parent_id is null').all() as { name: string }[]).map((r) => r.name);
    const f = (this.db.prepare('select path from files').all() as { path: string }[]).map((r) => r.path.split('/').pop()!);
    return [...new Set([...s, ...f])];
  }
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

// ---------------------------------------------------------------- layanan
export class LocalQaService implements LocalQa {
  private readonly db: Database.Database;
  private readonly ix: Index;
  constructor(store: SqliteIndexStore) { this.db = store.db; this.ix = new Index(store.db); }

  async ask(question: string): Promise<LocalAnswer> { return this.answer(question); }

  answer(question: string): LocalAnswer {
    const intent = classifyIntent(question);
    const cands = slotCandidates(question);
    if (intent === 'NEEDS_LLM') return { type: 'refusal', reason: 'NEEDS_LLM', partialEvidence: this.partialEvidence(question, cands), supportedIntents: SUPPORTED_INTENTS };
    if (intent === 'UNSUPPORTED') return { type: 'refusal', reason: 'UNSUPPORTED', partialEvidence: [], supportedIntents: SUPPORTED_INTENTS };

    switch (intent) {
      case 'DEFINITION': return this.withSymbol(cands, intent, (s) => this.definition(s));
      case 'USAGES': return this.withSymbol(cands, intent, (s) => this.usages(s));
      case 'COMPONENT_USES': return this.withSymbol(cands, intent, (s) => this.componentUses(s));
      case 'FILE_DEPENDENTS': {
        const f = this.firstFile(cands);
        if (f) return this.dependents(f.path, f.id);
        return this.withSymbol(cands, intent, (s) => this.usages(s)); // "siapa mengimpor signToken" -> pemakaian simbol
      }
      case 'MODULE_EXPORTS': {
        const f = this.firstFile(cands) ?? this.firstDirIndex(cands);
        return f ? this.moduleExports(f.path, f.id) : this.notFound(question, cands);
      }
      case 'DIR_FUNCTIONS': {
        for (const c of cands) { const d = this.ix.dirs(c.text); if (d.length === 1) return this.dirFunctions(d[0]!); if (d.length > 1) return { type: 'disambiguation', options: d.map((x) => cit(x, 1)) }; }
        return this.notFound(question, cands);
      }
      case 'IMPACT': {
        for (const c of cands) {
          const filesFirst = c.rank <= 1;
          const f = this.ix.files(c.text); const s = this.ix.symbols(c.text);
          if (filesFirst && f.length === 1) return this.impactFile(f[0]!);
          if (s.length === 1) return this.impactSymbol(s[0]!);
          if (s.length > 1) return { type: 'disambiguation', options: s.map((x) => cit(x.path, x.s, x.e)) };
          if (f.length === 1) return this.impactFile(f[0]!);
          if (f.length > 1) return { type: 'disambiguation', options: f.map((x) => cit(x.path, 1)) };
        }
        return this.notFound(question, cands);
      }
    }
  }

  // ---- pemilihan slot
  private firstFile(cands: Cand[]) { for (const c of cands) { const f = this.ix.files(c.text); if (f.length >= 1 && (c.rank <= 1 || this.ix.symbols(c.text).length === 0)) return f[0]!; } return undefined; }
  private firstDirIndex(cands: Cand[]) { for (const c of cands) for (const d of this.ix.dirs(c.text)) { const i = this.ix.files(`${d}/index`); if (i[0]) return i[0]; } return undefined; }
  private withSymbol(cands: Cand[], _intent: Intent, run: (s: SymRow) => LocalAnswer): LocalAnswer {
    for (const c of cands) {
      const s = this.ix.symbols(c.text);
      if (s.length === 1) return run(s[0]!);
      if (s.length > 1) return { type: 'disambiguation', options: s.slice(0, 10).map((x) => cit(x.path, x.s, x.e)) };
    }
    return this.notFound(cands.map((c) => c.text).join(' '), cands);
  }
  private notFound(_q: string, cands: Cand[]): LocalAnswer {
    const names = this.ix.names(); let best: { n: string; d: number } | undefined;
    for (const c of cands.slice(0, 4)) for (const n of names) {
      const d = editDistance(c.text.toLowerCase(), n.toLowerCase());
      if (d <= Math.max(2, Math.floor(c.text.length * 0.3)) && (!best || d < best.d)) best = { n, d };
    }
    return { type: 'refusal', reason: 'NOT_FOUND', partialEvidence: [], supportedIntents: SUPPORTED_INTENTS, ...(best ? { suggestion: best.n } : {}) };
  }

  // ---- bukti parsial untuk penolakan NEEDS_LLM
  private partialEvidence(question: string, cands: Cand[]): Citation[] {
    const out: Citation[] = []; const seen = new Set<string>();
    const add = (c: Citation) => { const k = `${c.path}:${c.startLine}-${c.endLine}`; if (!seen.has(k) && out.length < 5) { seen.add(k); out.push(c); } };
    for (const num of question.match(/\b\d{3,}\b/g) ?? []) {
      const rows = this.db.prepare(`select f.path, c.start_line s, c.end_line e from chunks_fts x join chunks c on c.id = x.rowid join files f on f.id = c.file_id where chunks_fts match ? order by f.path, c.start_line limit 3`).all(`"${num}"`) as { path: string; s: number; e: number }[];
      rows.forEach((r) => add(cit(r.path, r.s, r.e)));
    }
    for (const c of cands) if (c.rank <= 2) for (const s of this.ix.symbols(c.text).slice(0, 2)) add(cit(s.path, s.s, s.e));
    return out;
  }

  // ---- jawaban per intent
  private definition(s: SymRow): LocalAnswer {
    const secs = [{ title: `Definisi ${s.qn} (${s.kind})`, citations: [cit(s.path, s.s, s.e)], text: s.sig ?? s.qn }];
    if (s.exported) secs.push({ title: 'Status', citations: [], text: 'Diekspor dari modul ini.' });
    return { type: 'answer', intent: 'DEFINITION', sections: secs };
  }

  private usages(s: SymRow): LocalAnswer {
    const refs = this.db.prepare(`select f.path, r.line, r.ref_kind k from symbol_refs r join files f on f.id = r.file_id where r.target_symbol_id = ? order by f.path, r.line limit ?`).all(s.id, MAX_ITEMS + 1) as { path: string; line: number; k: string }[];
    const shown = refs.slice(0, MAX_ITEMS); const nFiles = new Set(shown.map((r) => r.path)).size;
    const deps = this.db.prepare(`select distinct t.path from v_file_edges e join files t on t.id = e.to_file_id where e.from_file_id = ? order by t.path`).all(s.fileId) as { path: string }[];
    return { type: 'answer', intent: 'USAGES', sections: [
      { title: `Definisi ${s.qn} (${s.kind})`, citations: [cit(s.path, s.s, s.e)], text: s.sig ?? s.qn },
      { title: `Dipakai di (${shown.length}${refs.length > MAX_ITEMS ? '+' : ''} lokasi, ${nFiles} file)`, citations: shown.map((r) => cit(r.path, r.line)), text: shown.map((r) => `${r.path}:${r.line} (${r.k})`).join('\n') },
      { title: 'Bergantung pada', citations: deps.map((d) => cit(d.path, 1)), text: deps.map((d) => d.path).join('\n') || 'Tidak ada dependensi internal.' },
    ] };
  }

  private dependents(path: string, fileId: number): LocalAnswer {
    const rows = this.db.prepare(`select f.path, x.line from (
        select file_id, line from imports where resolved_file_id = ? and is_dynamic = 0
        union select file_id, line from exports where source_file_id = ?) x join files f on f.id = x.file_id order by f.path, x.line`).all(fileId, fileId) as { path: string; line: number }[];
    return { type: 'answer', intent: 'FILE_DEPENDENTS', sections: [
      { title: `${path} diimpor langsung oleh ${new Set(rows.map((r) => r.path)).size} file`, citations: rows.slice(0, MAX_ITEMS).map((r) => cit(r.path, r.line)), text: rows.slice(0, MAX_ITEMS).map((r) => `${r.path}:${r.line}`).join('\n') || 'Tidak ada file yang mengimpor file ini.' },
      { title: 'Catatan', citations: [], text: 'Hanya dependen langsung. Tanyakan file apa yang terdampak jika file ini diubah untuk dependen transitif.' },
    ] };
  }

  private moduleExports(path: string, fileId: number): LocalAnswer {
    const rows = this.db.prepare(`select e.export_name n, e.kind k, e.line, e.source_specifier spec, s.kind sk, s.signature sig, s.start_line sl, s.end_line el from exports e left join symbols s on s.id = e.symbol_id where e.file_id = ? order by e.line, e.id`).all(fileId) as
      { n: string; k: string; line: number; spec: string | null; sk: string | null; sig: string | null; sl: number | null; el: number | null }[];
    const groups = new Map<string, typeof rows>();
    const label = (r: (typeof rows)[number]) => (r.k.startsWith('reexport') || r.k === 'namespace' ? 'Re-ekspor' : r.sk === 'component' ? 'Komponen' : r.sk === 'function' ? 'Fungsi' : r.sk === 'class' ? 'Class' : r.sk === 'interface' || r.sk === 'type' || r.sk === 'enum' ? 'Tipe' : 'Variabel dan lainnya');
    for (const r of rows) { const l = label(r); groups.set(l, [...(groups.get(l) ?? []), r]); }
    const sections = [...groups].map(([title, rs]) => ({ title: `${title} (${rs.length})`, citations: rs.map((r) => cit(path, r.sl ?? r.line, r.el ?? r.line)),
      text: rs.map((r) => r.k === 'reexport_all' ? `* dari ${r.spec}` : r.k === 'namespace' ? `${r.n} (namespace dari ${r.spec})` : r.k === 'reexport' ? `${r.n} (dari ${r.spec})` : `${r.n}${r.sig ? ' — ' + r.sig : ''}`).join('\n') }));
    return { type: 'answer', intent: 'MODULE_EXPORTS', sections: sections.length ? sections : [{ title: path, citations: [], text: 'Modul ini tidak mengekspor apa pun.' }] };
  }

  private dirFunctions(dir: string): LocalAnswer {
    const rows = this.db.prepare(`select f.path, s.name, s.start_line s, s.end_line e, s.signature sig from symbols s join files f on f.id = s.file_id where s.kind = 'function' and s.parent_id is null and (f.dir = ? or f.dir like ? || '/%') order by f.path, s.start_line limit ?`).all(dir, dir, MAX_ITEMS + 1) as
      { path: string; name: string; s: number; e: number; sig: string | null }[];
    const shown = rows.slice(0, MAX_ITEMS); const byFile = new Map<string, typeof shown>();
    for (const r of shown) byFile.set(r.path, [...(byFile.get(r.path) ?? []), r]);
    const sections = [...byFile].map(([p, rs]) => ({ title: `${p} (${rs.length})`, citations: rs.map((r) => cit(p, r.s, r.e)), text: rs.map((r) => r.sig ?? r.name).join('\n') }));
    return { type: 'answer', intent: 'DIR_FUNCTIONS', sections: [{ title: `Direktori ${dir}: ${shown.length}${rows.length > MAX_ITEMS ? '+' : ''} fungsi di ${byFile.size} file`, citations: [], text: 'Hanya fungsi tingkat atas (komponen dan method tidak dihitung).' }, ...sections] };
  }

  private componentUses(s: SymRow): LocalAnswer {
    const rows = this.db.prepare(`select r.name, f.path, r.line, ts.kind tk, ts.start_line tsl, ts.end_line tel, tf.path tpath, i.specifier spec, i.status ist from symbol_refs r
        join files f on f.id = r.file_id
        left join symbols ts on ts.id = r.target_symbol_id left join files tf on tf.id = ts.file_id
        left join import_bindings b on b.id = r.binding_id left join imports i on i.id = b.import_id
        where r.ref_kind = 'jsx' and (r.enclosing_symbol_id = ? or r.enclosing_symbol_id in (select id from symbols where parent_id = ?)) order by r.line, r.col`).all(s.id, s.id) as
      { name: string; path: string; line: number; tk: string | null; tsl: number | null; tel: number | null; tpath: string | null; spec: string | null; ist: string | null }[];
    const seen = new Set<string>(); const internal: typeof rows = []; const external: typeof rows = [];
    for (const r of rows) { if (seen.has(r.name)) continue; seen.add(r.name); (r.tpath ? internal : external).push(r); }
    return { type: 'answer', intent: 'COMPONENT_USES', sections: [
      { title: `Definisi ${s.qn}`, citations: [cit(s.path, s.s, s.e)], text: s.sig ?? s.qn },
      { title: `Komponen internal yang dirender (${internal.length})`, citations: internal.map((r) => cit(r.tpath!, r.tsl!, r.tel!)), text: internal.map((r) => `${r.name} (${r.tpath}), dipakai di baris ${r.line}`).join('\n') || 'Tidak ada.' },
      { title: `Komponen eksternal atau tak terselesaikan (${external.length})`, citations: external.map((r) => cit(r.path, r.line)), text: external.map((r) => `${r.name}${r.spec ? ` (dari ${r.spec})` : ''}, baris ${r.line}`).join('\n') || 'Tidak ada.' },
    ] };
  }

  private closure(fileId: number, maxDepth = 50): { path: string; depth: number }[] {
    return this.db.prepare(`with recursive r(file_id, depth) as (select ?, 0 union select e.from_file_id, r.depth + 1 from v_file_edges e join r on e.to_file_id = r.file_id where r.depth < ?)
      select f.path, min(r.depth) depth from r join files f on f.id = r.file_id where r.file_id <> ? group by f.path order by depth, f.path limit ?`).all(fileId, maxDepth, fileId, MAX_ITEMS + 1) as { path: string; depth: number }[];
  }
  private byDepth(rows: { path: string; depth: number }[]) {
    const g = new Map<number, string[]>();
    for (const r of rows.slice(0, MAX_ITEMS)) g.set(r.depth, [...(g.get(r.depth) ?? []), r.path]);
    return [...g].map(([d, ps]) => ({ title: `Kedalaman ${d} (${ps.length} file)`, citations: ps.map((p) => cit(p, 1)), text: ps.join('\n') }));
  }
  private impactFile(f: { id: number; path: string }): LocalAnswer {
    const rows = this.closure(f.id);
    return { type: 'answer', intent: 'IMPACT', sections: [
      { title: `Jika ${f.path} diubah: ${Math.min(rows.length, MAX_ITEMS)}${rows.length > MAX_ITEMS ? '+' : ''} file berpotensi terdampak`, citations: [], text: 'Penutup transitif dependen impor dan re-ekspor. Ini batas atas: tidak semua dependen terdampak oleh setiap jenis perubahan.' },
      ...this.byDepth(rows)] };
  }
  private impactSymbol(s: SymRow): LocalAnswer {
    const direct = this.db.prepare(`select distinct f.path from symbol_refs r join files f on f.id = r.file_id where r.target_symbol_id = ? and r.file_id <> ? order by f.path`).all(s.id, s.fileId) as { path: string }[];
    const directSet = new Set(direct.map((d) => d.path));
    const trans = this.closure(s.fileId).filter((r) => !directSet.has(r.path));
    return { type: 'answer', intent: 'IMPACT', sections: [
      { title: `Jika ${s.qn} diubah: ${direct.length} file memakainya langsung`, citations: direct.map((d) => cit(d.path, 1)), text: direct.map((d) => d.path).join('\n') || 'Tidak ada pemakai di file lain.' },
      { title: `Dependen transitif dari ${s.path} (${trans.length} file, batas atas)`, citations: trans.slice(0, MAX_ITEMS).map((r) => cit(r.path, 1)), text: trans.slice(0, MAX_ITEMS).map((r) => `${r.path} (kedalaman ${r.depth})`).join('\n') },
    ] };
  }
}
