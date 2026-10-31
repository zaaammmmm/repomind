import type Database from 'better-sqlite3';
import type { FileFacts, FileRow, PosixPath, Resolver } from '../contracts.js';

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const extOf = (p: string): '.ts' | '.tsx' | '.d.ts' => (p.endsWith('.d.ts') ? '.d.ts' : p.endsWith('.tsx') ? '.tsx' : '.ts');

interface ExportRow { symbol_id: number | null; kind: string; source_file_id: number | null; source_name: string | null }

/**
 * Indeks SQLite. Prinsip (spec-amendments A-01, A-04):
 *  - replaceFile melakukan upsert simbol dengan kunci alami (qualified_name, kind, urutan) sehingga id simbol stabil.
 *  - replaceFile hanya menulis fakta mentah; penautan (resolusi import, target referensi) dilakukan relink().
 *  - Isi indeks hanya fungsi dari isi file + konfigurasi, bukan riwayat (diuji lewat canonicalDump).
 */
export class SqliteIndexStore {
  constructor(readonly db: Database.Database) {}

  // ------------------------------------------------------------------ meta + dasar
  getMeta(key: string): string | undefined {
    return (this.db.prepare('select value from meta where key = ?').get(key) as { value: string } | undefined)?.value;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare('insert into meta(key,value) values(?,?) on conflict(key) do update set value = excluded.value').run(key, value);
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  integrityCheck(): boolean { return this.db.pragma('integrity_check', { simple: true }) === 'ok'; }
  close(): void { this.db.close(); }

  private mapFile(r: Record<string, unknown>): FileRow {
    return { id: r.id as number, path: r.path as string, dir: r.dir as string, contentHash: r.content_hash as string,
      exportSurfaceHash: r.export_surface_hash as string, sizeBytes: r.size_bytes as number, mtimeMs: r.mtime_ms as number,
      loc: r.loc as number, parseError: r.parse_error === 1 };
  }
  getFile(path: PosixPath): FileRow | undefined {
    const r = this.db.prepare('select * from files where path = ?').get(path) as Record<string, unknown> | undefined;
    return r && this.mapFile(r);
  }
  hasFile(path: PosixPath): boolean { return this.db.prepare('select 1 from files where path = ?').get(path) !== undefined; }
  listFiles(): FileRow[] { return (this.db.prepare('select * from files order by path').all() as Record<string, unknown>[]).map((r) => this.mapFile(r)); }
  counts() {
    return this.db.prepare(`select (select count(*) from files) files, (select count(*) from symbols) symbols,
      (select count(*) from imports) imports, (select count(*) from chunks) chunks`).get() as { files: number; symbols: number; imports: number; chunks: number };
  }
  touchFile(path: PosixPath, stat: { sizeBytes: number; mtimeMs: number }): void {
    this.db.prepare('update files set size_bytes = ?, mtime_ms = ? where path = ?').run(stat.sizeBytes, stat.mtimeMs, path);
  }
  clear(): void {
    this.db.exec('delete from files; delete from chunks_fts; delete from summary_sections; delete from llm_cache;');
  }

  // ------------------------------------------------------------------ tulis per file
  replaceFile(facts: FileFacts, stat: { sizeBytes: number; mtimeMs: number }, nowMs = 0): { fileId: number; inserted: boolean; previousSurfaceHash?: string } {
    const db = this.db;
    const existing = db.prepare('select id, export_surface_hash h from files where path = ?').get(facts.path) as { id: number; h: string } | undefined;
    let fileId: number;
    if (existing) {
      fileId = existing.id;
      db.prepare(`update files set dir=?, ext=?, size_bytes=?, mtime_ms=?, content_hash=?, export_surface_hash=?, loc=?, parse_error=?, analyzer_version=?, indexed_at_ms=? where id=?`)
        .run(dirOf(facts.path), extOf(facts.path), stat.sizeBytes, stat.mtimeMs, facts.contentHash, facts.exportSurfaceHash, facts.loc, facts.parseError ? 1 : 0, facts.analyzerVersion, nowMs, fileId);
    } else {
      fileId = Number(db.prepare(`insert into files(path,dir,ext,size_bytes,mtime_ms,content_hash,export_surface_hash,loc,parse_error,analyzer_version,indexed_at_ms) values(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(facts.path, dirOf(facts.path), extOf(facts.path), stat.sizeBytes, stat.mtimeMs, facts.contentHash, facts.exportSurfaceHash, facts.loc, facts.parseError ? 1 : 0, facts.analyzerVersion, nowMs).lastInsertRowid);
    }

    // 1) buang yang dimiliki file ini selain simbol (id simbol harus dipertahankan)
    db.prepare('delete from symbol_refs where file_id = ?').run(fileId);
    db.prepare('delete from chunks where file_id = ?').run(fileId); // trigger membersihkan FTS
    db.prepare('delete from exports where file_id = ?').run(fileId);
    db.prepare('delete from imports where file_id = ?').run(fileId); // cascade import_bindings

    // 2) upsert simbol berdasarkan kunci alami
    const oldRows = db.prepare('select id, qualified_name qn, kind from symbols where file_id = ? order by start_line, start_col, id').all(fileId) as { id: number; qn: string; kind: string }[];
    const oldByKey = new Map<string, number>();
    const occ = new Map<string, number>();
    for (const r of oldRows) { const base = `${r.qn}|${r.kind}`; const n = occ.get(base) ?? 0; occ.set(base, n + 1); oldByKey.set(`${base}#${n}`, r.id); }
    const sorted = [...facts.symbols].sort((a, b) => a.range.startLine - b.range.startLine || a.range.startCol - b.range.startCol || a.localId - b.localId);
    const idOf = new Map<number, number>();
    const keep = new Set<number>();
    const occNew = new Map<string, number>();
    const upd = db.prepare(`update symbols set parent_id=?, name=?, qualified_name=?, kind=?, start_line=?, start_col=?, end_line=?, end_col=?, signature=?, is_exported=?, is_default=?, is_async=?, has_jsdoc=?, jsdoc=? where id=?`);
    const ins = db.prepare(`insert into symbols(file_id,parent_id,name,qualified_name,kind,start_line,start_col,end_line,end_col,signature,is_exported,is_default,is_async,has_jsdoc,jsdoc) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    // parent harus diproses lebih dulu: urut localId untuk penetapan id, bukan urut posisi
    const byLocal = [...facts.symbols].sort((a, b) => a.localId - b.localId);
    const keyOf = new Map<number, string>();
    for (const s of sorted) { const base = `${s.qualifiedName}|${s.kind}`; const n = occNew.get(base) ?? 0; occNew.set(base, n + 1); keyOf.set(s.localId, `${base}#${n}`); }
    for (const s of byLocal) {
      const parent = s.parentLocalId !== undefined ? idOf.get(s.parentLocalId) ?? null : null;
      const vals = [s.name, s.qualifiedName, s.kind, s.range.startLine, s.range.startCol, s.range.endLine, s.range.endCol, s.signature ?? null, s.isExported ? 1 : 0, s.isDefault ? 1 : 0, s.isAsync ? 1 : 0, s.jsdoc ? 1 : 0, s.jsdoc ?? null];
      const oldId = oldByKey.get(keyOf.get(s.localId)!);
      if (oldId !== undefined) { upd.run(parent, ...vals, oldId); idOf.set(s.localId, oldId); keep.add(oldId); }
      else idOf.set(s.localId, Number(ins.run(fileId, parent, ...vals).lastInsertRowid));
    }
    const del = db.prepare('delete from symbols where id = ?');
    for (const r of oldRows) if (!keep.has(r.id)) del.run(r.id);

    // 3) ekspor, import, binding, referensi, chunk (mentah; penautan oleh relink)
    const insExp = db.prepare('insert into exports(file_id,export_name,kind,symbol_id,source_specifier,source_name,line) values(?,?,?,?,?,?,?)');
    for (const e of facts.exports) insExp.run(fileId, e.exportName, e.kind, e.symbolLocalId !== undefined ? idOf.get(e.symbolLocalId) ?? null : null, e.sourceSpecifier ?? null, e.sourceName ?? null, e.line);

    const insImp = db.prepare(`insert into imports(file_id,specifier,status,is_type_only,is_dynamic,is_side_effect,line) values(?,?,'unresolved',?,?,?,?)`);
    const insBind = db.prepare('insert into import_bindings(import_id,imported_name,local_name,is_type) values(?,?,?,?)');
    const bindingByLocal = new Map<string, number>();
    for (const i of facts.imports) {
      const impId = Number(insImp.run(fileId, i.specifier, i.isTypeOnly ? 1 : 0, i.isDynamic ? 1 : 0, i.isSideEffect ? 1 : 0, i.line).lastInsertRowid);
      for (const b of i.bindings) {
        const bid = Number(insBind.run(impId, b.importedName, b.localName, b.isType ? 1 : 0).lastInsertRowid);
        if (!bindingByLocal.has(b.localName)) bindingByLocal.set(b.localName, bid);
      }
    }
    const insRef = db.prepare('insert into symbol_refs(file_id,enclosing_symbol_id,name,binding_id,ref_kind,line,col) values(?,?,?,?,?,?,?)');
    for (const r of facts.refs) insRef.run(fileId, r.enclosingLocalId !== undefined ? idOf.get(r.enclosingLocalId) ?? null : null, r.name, r.bindingLocal ? bindingByLocal.get(r.bindingLocal) ?? null : null, r.kind, r.line, r.col);

    const insChunk = db.prepare('insert into chunks(file_id,symbol_id,ordinal,start_line,end_line,text,token_est) values(?,?,?,?,?,?,?)');
    const insFts = db.prepare('insert into chunks_fts(rowid,sym_name,path,body) values(?,?,?,?)');
    for (const c of facts.chunks) {
      const cid = Number(insChunk.run(fileId, c.symbolLocalId !== undefined ? idOf.get(c.symbolLocalId) ?? null : null, c.ordinal, c.startLine, c.endLine, c.text, c.tokenEst).lastInsertRowid);
      insFts.run(cid, c.ftsName, facts.path, c.ftsBody);
    }
    return { fileId, inserted: !existing, ...(existing ? { previousSurfaceHash: existing.h } : {}) };
  }

  /** Pindah file tanpa parse ulang (ekstensi harus sama). Penautan ulang dilakukan pemanggil lewat relink('all'). */
  renameFile(oldPath: PosixPath, newPath: PosixPath): void {
    const row = this.db.prepare('select id from files where path = ?').get(oldPath) as { id: number } | undefined;
    if (!row) throw new Error(`renameFile: tidak ada ${oldPath}`);
    this.db.prepare('update files set path = ?, dir = ? where id = ?').run(newPath, dirOf(newPath), row.id);
    const chunks = this.db.prepare('select id from chunks where file_id = ?').all(row.id) as { id: number }[];
    const sel = this.db.prepare('select sym_name, body from chunks_fts where rowid = ?');
    const del = this.db.prepare('delete from chunks_fts where rowid = ?');
    const ins = this.db.prepare('insert into chunks_fts(rowid,sym_name,path,body) values(?,?,?,?)');
    for (const c of chunks) { const f = sel.get(c.id) as { sym_name: string; body: string }; del.run(c.id); ins.run(c.id, f.sym_name, newPath, f.body); }
  }

  deleteFile(path: PosixPath): void {
    const row = this.db.prepare('select id from files where path = ?').get(path) as { id: number } | undefined;
    if (!row) return;
    // Import yang menunjuk file ini dijadikan placeholder agar CHECK status/resolved_file_id tetap valid; relink menentukan status akhirnya.
    this.db.prepare(`update imports set status='unresolved', resolved_file_id=NULL, external_package=NULL where resolved_file_id = ?`).run(row.id);
    this.db.prepare('delete from files where id = ?').run(row.id);
  }

  // ------------------------------------------------------------------ graf
  importersOf(path: PosixPath): PosixPath[] {
    return (this.db.prepare(`select f.path from v_file_edges e join files f on f.id = e.from_file_id join files t on t.id = e.to_file_id where t.path = ? order by f.path`).all(path) as { path: string }[]).map((r) => r.path);
  }

  /** Dependen langsung + rantai re-export (barrel): perubahan permukaan ekspor F dapat memengaruhi pengimpor barrel (A-04). */
  dependentClosure(fileId: number): Set<number> {
    const importers = this.db.prepare('select distinct from_file_id id from v_file_edges where to_file_id = ?');
    const reexports = this.db.prepare('select 1 from exports where file_id = ? and source_file_id = ? limit 1');
    const out = new Set<number>(); const seen = new Set<number>([fileId]); const queue = [fileId];
    while (queue.length) {
      const x = queue.pop()!;
      for (const { id } of importers.all(x) as { id: number }[]) {
        out.add(id);
        if (!seen.has(id) && reexports.get(id, x)) { seen.add(id); queue.push(id); }
      }
    }
    out.delete(fileId);
    return out;
  }

  // ------------------------------------------------------------------ relink (tanpa parse)
  /** Resolusi ulang import/re-export dan target referensi. Mengembalikan id file yang barisnya benar-benar berubah. */
  relink(resolver: Resolver, scope: 'all' | Iterable<number>): { relinked: number; changed: Set<number> } {
    const db = this.db;
    const all = db.prepare('select id, path from files').all() as { id: number; path: string }[];
    const idByPath = new Map(all.map((f) => [f.path, f.id]));
    const pathById = new Map(all.map((f) => [f.id, f.path]));
    const ids = scope === 'all' ? all.map((f) => f.id) : [...scope].filter((i) => pathById.has(i));
    const changed = new Set<number>();

    const impSel = db.prepare('select id, specifier, status, resolved_file_id r, external_package p from imports where file_id = ?');
    const impUpd = db.prepare('update imports set status=?, resolved_file_id=?, external_package=? where id=?');
    const expSel = db.prepare('select id, source_specifier s, source_file_id f from exports where file_id = ? and source_specifier is not null');
    const expUpd = db.prepare('update exports set source_file_id=? where id=?');
    for (const fid of ids) {
      const path = pathById.get(fid)!;
      for (const i of impSel.all(fid) as { id: number; specifier: string; status: string; r: number | null; p: string | null }[]) {
        const res = resolver.resolve(path, i.specifier);
        const rid = res.status === 'resolved' ? idByPath.get(res.resolvedPath!) ?? null : null;
        const status = res.status === 'resolved' && rid === null ? 'unresolved' : res.status;
        const pkg = status === 'external' ? res.externalPackage ?? null : null;
        if (i.status !== status || i.r !== rid || i.p !== pkg) { impUpd.run(status, rid, pkg, i.id); changed.add(fid); }
      }
      for (const e of expSel.all(fid) as { id: number; s: string; f: number | null }[]) {
        const res = resolver.resolve(path, e.s);
        const rid = res.status === 'resolved' ? idByPath.get(res.resolvedPath!) ?? null : null;
        if (e.f !== rid) { expUpd.run(rid, e.id); changed.add(fid); }
      }
    }

    // fase 2: target referensi
    const expFind = db.prepare(`select symbol_id, kind, source_file_id, source_name from exports where file_id = ? and export_name = ? and kind in ('named','default','reexport','namespace') limit 1`);
    const starSel = db.prepare(`select source_file_id f from exports where file_id = ? and kind = 'reexport_all' and source_file_id is not null order by line, id`);
    const memo = new Map<string, { symbolId: number | null; fileId: number } | null>();
    const resolveExport = (fileId: number, name: string, depth: number, seen: Set<string>): { symbolId: number | null; fileId: number } | null => {
      const key = `${fileId}:${name}`;
      if (memo.has(key)) return memo.get(key)!;
      if (depth > 8 || seen.has(key)) return null;
      seen.add(key);
      let out: { symbolId: number | null; fileId: number } | null = null;
      const row = expFind.get(fileId, name) as ExportRow | undefined;
      if (row) {
        if (row.kind === 'named' || row.kind === 'default') out = { symbolId: row.symbol_id, fileId };
        else if (row.kind === 'reexport') out = row.source_file_id !== null ? resolveExport(row.source_file_id, row.source_name ?? name, depth + 1, seen) : null;
        else if (row.kind === 'namespace') out = row.source_file_id !== null ? { symbolId: null, fileId: row.source_file_id } : null;
      } else if (name !== 'default') {
        for (const s of starSel.all(fileId) as { f: number }[]) { out = resolveExport(s.f, name, depth + 1, seen); if (out) break; }
      }
      seen.delete(key);
      if (depth === 0) memo.set(key, out);
      return out;
    };

    const refSel = db.prepare(`select r.id, r.name, r.binding_id bid, r.target_symbol_id ts, r.target_file_id tf, b.imported_name iname, i.status istatus, i.resolved_file_id ifile
      from symbol_refs r left join import_bindings b on b.id = r.binding_id left join imports i on i.id = b.import_id where r.file_id = ?`);
    const refUpd = db.prepare('update symbol_refs set target_symbol_id=?, target_file_id=? where id=?');
    const localSel = db.prepare('select name, id from symbols where file_id = ? and parent_id is null order by start_line, start_col');
    for (const fid of ids) {
      const local = new Map<string, number>();
      for (const s of localSel.all(fid) as { name: string; id: number }[]) if (!local.has(s.name)) local.set(s.name, s.id);
      for (const r of refSel.all(fid) as { id: number; name: string; bid: number | null; ts: number | null; tf: number | null; iname: string | null; istatus: string | null; ifile: number | null }[]) {
        let ts: number | null = null; let tf: number | null = null;
        if (r.bid !== null) {
          if (r.istatus === 'resolved' && r.ifile !== null) {
            if (r.iname === '*') tf = r.ifile;
            else { const res = resolveExport(r.ifile, r.iname!, 0, new Set()); if (res) { ts = res.symbolId; tf = res.fileId; } }
          }
        } else if (local.has(r.name)) { ts = local.get(r.name)!; tf = fid; }
        if (r.ts !== ts || r.tf !== tf) { refUpd.run(ts, tf, r.id); changed.add(fid); }
      }
    }
    return { relinked: ids.length, changed };
  }

  // ------------------------------------------------------------------ canonical dump (FR-IDX-06)
  /** JSON stabil tanpa id, mtime, dan timestamp. Dua indeks setara bila dump-nya identik. */
  canonicalDump(): string {
    const q = <T>(sql: string) => this.db.prepare(sql).all() as T[];
    const symKey = (file: string, qn: string, kind: string, line: number, col: number) => `${file}::${qn}|${kind}@${line}:${col}`;
    const symbols = q<Record<string, unknown>>(`select s.*, f.path fpath, p.qualified_name pqn from symbols s join files f on f.id = s.file_id left join symbols p on p.id = s.parent_id`);
    const keyById = new Map<number, string>(symbols.map((s) => [s.id as number, symKey(s.fpath as string, s.qualified_name as string, s.kind as string, s.start_line as number, s.start_col as number)]));
    const cmp = (a: unknown, b: unknown) => { const x = JSON.stringify(a), y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0; };

    const files = q<Record<string, unknown>>('select path, dir, ext, size_bytes, content_hash, export_surface_hash, loc, parse_error, analyzer_version from files order by path');
    const symOut = symbols.map((s) => ({ key: keyById.get(s.id as number), name: s.name, parent: s.pqn ?? null, sig: s.signature, exp: s.is_exported, def: s.is_default, async: s.is_async, jsdoc: s.jsdoc,
      end: [s.end_line, s.end_col] })).sort(cmp);
    const exps = q<Record<string, unknown>>(`select e.*, f.path fpath, sf.path spath from exports e join files f on f.id = e.file_id left join files sf on sf.id = e.source_file_id`)
      .map((e) => ({ file: e.fpath, name: e.export_name, kind: e.kind, symbol: e.symbol_id ? keyById.get(e.symbol_id as number) : null, spec: e.source_specifier, sname: e.source_name, srcFile: e.spath ?? null, line: e.line })).sort(cmp);
    const imps = q<Record<string, unknown>>(`select i.*, f.path fpath, rf.path rpath from imports i join files f on f.id = i.file_id left join files rf on rf.id = i.resolved_file_id`)
      .map((i) => ({ id: i.id, file: i.fpath, spec: i.specifier, status: i.status, resolved: i.rpath ?? null, pkg: i.external_package, tonly: i.is_type_only, dyn: i.is_dynamic, side: i.is_side_effect, line: i.line }));
    const bindings = q<Record<string, unknown>>('select import_id, imported_name, local_name, is_type from import_bindings');
    const bByImp = new Map<number, unknown[]>();
    for (const b of bindings) { const l = bByImp.get(b.import_id as number) ?? []; l.push([b.imported_name, b.local_name, b.is_type]); bByImp.set(b.import_id as number, l); }
    const impOut = imps.map(({ id, ...rest }) => ({ ...rest, bindings: (bByImp.get(id as number) ?? []).sort(cmp) })).sort(cmp);
    const refs = q<Record<string, unknown>>(`select r.*, f.path fpath, tf.path tpath, b.local_name bl, i.specifier bspec from symbol_refs r join files f on f.id = r.file_id
      left join files tf on tf.id = r.target_file_id left join import_bindings b on b.id = r.binding_id left join imports i on i.id = b.import_id`)
      .map((r) => ({ file: r.fpath, name: r.name, kind: r.ref_kind, line: r.line, col: r.col, encl: r.enclosing_symbol_id ? keyById.get(r.enclosing_symbol_id as number) : null,
        binding: r.bl ? `${r.bspec}#${r.bl}` : null, tsym: r.target_symbol_id ? keyById.get(r.target_symbol_id as number) : null, tfile: r.tpath ?? null })).sort(cmp);
    const chunks = q<Record<string, unknown>>(`select c.*, f.path fpath, s.id sid, x.sym_name, x.path xpath, x.body from chunks c join files f on f.id = c.file_id left join symbols s on s.id = c.symbol_id
      left join chunks_fts x on x.rowid = c.id`)
      .map((c) => ({ file: c.fpath, ord: c.ordinal, sym: c.sid ? keyById.get(c.sid as number) : null, s: c.start_line, e: c.end_line, text: c.text, tok: c.token_est, fts: [c.sym_name, c.xpath, c.body] })).sort(cmp);
    return JSON.stringify({ files, symbols: symOut, exports: exps, imports: impOut, refs, chunks });
  }
}
