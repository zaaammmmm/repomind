import type Database from 'better-sqlite3';
import type { Candidate, RetrievalOptions, RetrievalResult, Retriever } from '../contracts.js';
import type { SqliteIndexStore } from '../store/index-store.js';
import { analyzeQuery, ftsMatchExpr } from './query.js';

export const DEFAULT_RETRIEVAL: RetrievalOptions = { topK: 8, tokenBudget: 4000, maxChunksPerFile: 3 };
export const FUSION = { k: 60, wText: 1.0, wSymbol: 1.5, wGraph: 0.7, textN: 50, symbolN: 20, seeds: 5, edgeCaller: 0.6, edgeCallee: 0.4, hopDecay: 0.5 };

interface ChunkRow { id: number; fileId: number; path: string; sid: number | null; qn: string | null; startLine: number; endLine: number; text: string; tokenEst: number }
type Src = 'text' | 'symbol' | 'graph';
const TEST_PATH = /(^|\/)(tests?|test-d|__tests__|specs?)\/|\.(test|spec)\.[cm]?tsx?$/;

/** Retriever hybrid (bagian 3.5): BM25 (FTS5) + pencocokan simbol + ekspansi graf, difusi RRF berbobot, dikemas dalam anggaran token. */
export class HybridRetriever implements Retriever {
  private readonly db: Database.Database;
  private readonly stChunk; private readonly stChunkAt; private readonly stFts; private readonly stSymExact; private readonly stSymPrefix; private readonly stSymLike;
  private readonly stCallers; private readonly stCallees; private readonly stSymLoc;

  constructor(store: SqliteIndexStore) {
    this.db = store.db;
    const base = `select c.id, c.file_id fileId, f.path, c.symbol_id sid, s.qualified_name qn, c.start_line startLine, c.end_line endLine, c.text, c.token_est tokenEst from chunks c join files f on f.id = c.file_id left join symbols s on s.id = c.symbol_id`;
    this.stChunk = this.db.prepare(`${base} where c.id = ?`);
    this.stChunkAt = this.db.prepare(`${base} where c.file_id = ? and c.start_line <= ? and c.end_line >= ? order by (c.end_line - c.start_line), c.ordinal limit 1`);
    this.stFts = this.db.prepare(`select rowid id from chunks_fts where chunks_fts match ? order by bm25(chunks_fts, 5.0, 2.0, 1.0), rowid limit ?`);
    const sym = `select s.id, s.file_id fileId, s.start_line startLine, s.name, s.is_exported ex from symbols s`;
    this.stSymExact = this.db.prepare(`${sym} where lower(s.name) = lower(?) order by s.is_exported desc, s.parent_id is not null, s.file_id, s.start_line limit 10`);
    this.stSymPrefix = this.db.prepare(`${sym} where lower(s.name) like lower(?) || '%' escape '\\' and lower(s.name) <> lower(?) order by s.is_exported desc, length(s.name), s.file_id, s.start_line limit 10`);
    this.stSymLike = this.db.prepare(`${sym} where lower(s.name) like '%' || lower(?) || '%' escape '\\' order by s.is_exported desc, length(s.name), s.file_id, s.start_line limit 40`);
    this.stCallers = this.db.prepare(`select distinct r.file_id fileId, r.line from symbol_refs r where r.target_symbol_id = ? order by r.file_id, r.line limit 20`);
    this.stCallees = this.db.prepare(`select distinct r.target_symbol_id id from symbol_refs r where r.file_id = ? and r.line between ? and ? and r.target_symbol_id is not null and r.target_symbol_id <> ? order by r.target_symbol_id limit 20`);
    this.stSymLoc = this.db.prepare('select file_id fileId, start_line startLine from symbols where id = ?');
  }

  async retrieve(query: string, opt: Partial<RetrievalOptions> = {}): Promise<RetrievalResult> { return this.run(query, { ...DEFAULT_RETRIEVAL, ...opt }); }

  run(query: string, opt: RetrievalOptions): RetrievalResult {
    const T0 = performance.now(); const timings = { text: 0, symbol: 0, graph: 0, fuse: 0, pack: 0, total: 0 };
    const qa = analyzeQuery(query);
    const chunkCache = new Map<number, ChunkRow>();
    const getChunk = (id: number) => { let c = chunkCache.get(id); if (!c) { c = this.stChunk.get(id) as ChunkRow | undefined; if (c) chunkCache.set(id, c); } return c; };
    const chunkAt = (fileId: number, line: number) => { const c = this.stChunkAt.get(fileId, line, line) as ChunkRow | undefined; if (c) chunkCache.set(c.id, c); return c; };
    const reasons = new Map<number, string[]>();
    const why = (id: number, r: string) => { const l = reasons.get(id) ?? []; if (l.length < 3 && !l.includes(r)) l.push(r); reasons.set(id, l); };

    // ---- 1) teks (BM25)
    let t = performance.now();
    const textIds: number[] = [];
    const expr = ftsMatchExpr(qa.terms);
    if (expr) {
      // Chunk header (import dan pernyataan non-deklarasi) dibuang dari hasil teks kecuali memuat export (barrel); ia jarang informatif dan memakan slot.
      for (const r of this.stFts.all(expr, FUSION.textN) as { id: number }[]) {
        const c = getChunk(r.id); if (!c || (c.sid === null && !/\bexport\b/.test(c.text))) continue;
        textIds.push(r.id); why(r.id, `teks #${textIds.length}`);
      }
    }
    timings.text = performance.now() - t;

    // ---- 2) simbol
    t = performance.now();
    const symScore = new Map<number, { score: number; name: string; fileId: number; startLine: number; exact: boolean; label: string }>();
    const bump = (r: { id: number; fileId: number; startLine: number; name: string }, score: number, label: 'persis' | 'bernama' | 'mirip', exact = false) => {
      const cur = symScore.get(r.id); if (!cur || score > cur.score) symScore.set(r.id, { score, name: r.name, fileId: r.fileId, startLine: r.startLine, exact, label });
    };
    const esc = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);
    type SymR = { id: number; fileId: number; startLine: number; name: string };
    for (const tok of qa.tokens.slice(0, 8)) {
      const clean = tok.replace(/[^A-Za-z0-9_$]/g, ''); if (clean.length < 2) continue;
      // "Cocok persis" (dipaksa masuk) hanya untuk identifier yang disebut eksplisit: huruf besar-kecil sama dan token bukan kata huruf kecil biasa.
      // Kata umum (mis. request) yang cocok banyak simbol hanya diberi skor lebih rendah dan tidak dipaksa.
      const rows = this.stSymExact.all(clean) as SymR[];
      const explicit = qa.identifiers.includes(tok) || /[A-Z]/.test(clean);
      for (const r of rows) {
        if (explicit && r.name === clean) bump(r, 1.0, 'persis', true);
        else bump(r, rows.length > 3 ? 0.6 : 0.9, 'bernama');
      }
      if (clean.length >= 3) (this.stSymPrefix.all(esc(clean), clean) as SymR[]).forEach((r) => bump(r, 0.7, 'mirip'));
    }
    for (const id of qa.identifiers.slice(0, 4)) {
      const parts = id.split(/(?<=[a-z0-9])(?=[A-Z])|_/).filter((p) => p.length >= 2);
      if (parts.length < 2) continue;
      for (const r of this.stSymLike.all(esc(parts[0]!)) as SymR[]) if (parts.every((p) => r.name.toLowerCase().includes(p.toLowerCase()))) bump(r, 0.5, 'mirip');
    }
    const symRanked = [...symScore.entries()].sort((a, b) => b[1].score - a[1].score || a[1].fileId - b[1].fileId || a[1].startLine - b[1].startLine).slice(0, FUSION.symbolN);
    const symbolIds: number[] = []; const forced: number[] = [];
    for (const [, s] of symRanked) {
      const c = chunkAt(s.fileId, s.startLine); if (!c || symbolIds.includes(c.id)) continue;
      symbolIds.push(c.id); why(c.id, s.label === 'persis' ? `simbol cocok persis: ${s.name}` : s.label === 'bernama' ? `simbol bernama: ${s.name}` : `simbol mirip: ${s.name}`);
      if (s.exact && forced.length < 3) forced.push(c.id);
    }
    timings.symbol = performance.now() - t;

    // ---- 3) graf, dari seed hasil fusi awal
    const rrf = (lists: [number[], number][]) => {
      const m = new Map<number, { score: number; sources: Set<Src> }>();
      const names: Src[] = ['text', 'symbol', 'graph'];
      lists.forEach(([ids, w], li) => ids.forEach((id, rank) => { const e = m.get(id) ?? { score: 0, sources: new Set<Src>() }; e.score += w / (FUSION.k + rank + 1); e.sources.add(names[li]!); m.set(id, e); }));
      return m;
    };
    const order = <T extends { score: number }>(m: Map<number, T>) => [...m.entries()].sort((a, b) => b[1].score - a[1].score || a[0] - b[0]);
    t = performance.now();
    const pre = order(rrf([[textIds, FUSION.wText], [symbolIds, FUSION.wSymbol]]));
    const graphScore = new Map<number, number>();
    for (const [seedId, seed] of pre.slice(0, FUSION.seeds)) {
      const sc = getChunk(seedId); if (!sc) continue;
      const add = (c: ChunkRow | undefined, w: number, r: string) => {
        if (!c || c.id === seedId) return;
        const v = seed.score * FUSION.hopDecay * w; if (v > (graphScore.get(c.id) ?? 0)) { graphScore.set(c.id, v); why(c.id, r); }
      };
      if (sc.sid !== null) for (const r of this.stCallers.all(sc.sid) as { fileId: number; line: number }[]) add(chunkAt(r.fileId, r.line), FUSION.edgeCaller, `graf: memakai ${sc.qn ?? 'seed'}`);
      for (const r of this.stCallees.all(sc.fileId, sc.startLine, sc.endLine, sc.sid ?? -1) as { id: number }[]) {
        const loc = this.stSymLoc.get(r.id) as { fileId: number; startLine: number } | undefined;
        if (loc) add(chunkAt(loc.fileId, loc.startLine), FUSION.edgeCallee, `graf: dipakai oleh ${sc.qn ?? 'seed'}`);
      }
    }
    const graphIds = [...graphScore.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
    timings.graph = performance.now() - t;

    // ---- 4) fusi akhir
    t = performance.now();
    const fusedRaw = rrf([[textIds, FUSION.wText], [symbolIds, FUSION.wSymbol], [graphIds, FUSION.wGraph]]);
    const tp = opt.testPenalty ?? 1;
    if (tp !== 1) for (const [id, e] of fusedRaw) { const c = getChunk(id); if (c && TEST_PATH.test(c.path)) e.score *= tp; }
    const fused = order(fusedRaw);
    const fusedMap = new Map(fused);
    timings.fuse = performance.now() - t;

    // ---- 5) pengemasan
    t = performance.now();
    const chosen: { c: ChunkRow; score: number; sources: Src[]; reason: string }[] = [];
    const perFile = new Map<number, number>(); let tokens = 0;
    const take = (id: number, force: boolean): void => {
      const c = getChunk(id); if (!c || chosen.some((x) => x.c.id === id)) return;
      if (!force && (chosen.length >= opt.topK || (perFile.get(c.fileId) ?? 0) >= opt.maxChunksPerFile || tokens + c.tokenEst > opt.tokenBudget)) return;
      const e = fusedMap.get(id)!; chosen.push({ c, score: e.score, sources: [...e.sources], reason: (reasons.get(id) ?? []).join('; ') });
      perFile.set(c.fileId, (perFile.get(c.fileId) ?? 0) + 1); tokens += c.tokenEst;
    };
    for (const id of forced) take(id, true);
    for (const [id] of fused) take(id, false);
    // urut per file dan baris, lalu gabungkan rentang bersebelahan atau tumpang tindih
    chosen.sort((a, b) => (a.c.path < b.c.path ? -1 : a.c.path > b.c.path ? 1 : a.c.startLine - b.c.startLine));
    const merged: Candidate[] = [];
    for (const x of chosen) {
      const prev = merged[merged.length - 1];
      // hanya bersebelahan persis: baris celah tidak ada di teks chunk, dan chunk dengan awalan sintetis (member kelas) tidak boleh dilebur
      if (prev && prev.path === x.c.path && x.c.startLine === prev.endLine + 1) {
        prev.text += '\n' + x.c.text; prev.endLine = Math.max(prev.endLine, x.c.endLine); prev.tokenEst += x.c.tokenEst;
        prev.score = Math.max(prev.score, x.score); prev.sources = [...new Set([...prev.sources, ...x.sources])];
        prev.reason = [prev.reason, x.reason].filter(Boolean).join('; '); if (!prev.symbol && x.c.qn) prev.symbol = x.c.qn;
      } else merged.push({ chunkId: x.c.id, path: x.c.path, startLine: x.c.startLine, endLine: x.c.endLine, text: x.c.text, tokenEst: x.c.tokenEst, score: x.score, sources: x.sources, reason: x.reason, ...(x.c.qn ? { symbol: x.c.qn } : {}) });
    }
    timings.pack = performance.now() - t; timings.total = performance.now() - T0;
    return { chunks: merged, tokenEstimate: merged.reduce((n, c) => n + c.tokenEst, 0), timingsMs: timings, perSourceCounts: { text: textIds.length, symbol: symbolIds.length, graph: graphIds.length } };
  }
}
