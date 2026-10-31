// Spike iterasi 1 (ADR-01/02): buktikan better-sqlite3 + FTS5 + WAL + transaksi + trigger bekerja,
// dan ukur throughput insert sebagai gambaran kasar. Jalankan juga di dalam Electron (lihat docs/adr/ADR-02-spike.md).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openIndex } from '../src/store/open.ts';

const dir = mkdtempSync(join(tmpdir(), 'repomind-'));
const { db, recovered } = openIndex(join(dir, 'index.db'));
console.log('node', process.version, process.platform, process.arch, 'abi', process.versions.modules);
console.log('sqlite', db.prepare('select sqlite_version() v').get());
console.log('journal_mode', db.pragma('journal_mode', { simple: true }), 'recovered', recovered);
console.log('fts5', db.prepare("select count(*) c from pragma_compile_options where compile_options like '%FTS5%'").get());

const N = 20000;
const insFile = db.prepare(`insert into files(path,dir,ext,size_bytes,mtime_ms,content_hash,export_surface_hash,analyzer_version,indexed_at_ms)
  values(?,?,?,?,?,?,?,?,?)`);
const insChunk = db.prepare('insert into chunks(id,file_id,ordinal,start_line,end_line,text,token_est) values(?,?,?,?,?,?,?)');
const insFts = db.prepare('insert into chunks_fts(rowid,sym_name,path,body) values(?,?,?,?)');
const t0 = performance.now();
db.transaction(() => {
  for (let i = 1; i <= N; i++) {
    insFile.run(`src/m${i}.ts`, 'src', '.ts', 100, i, `h${i}`, `s${i}`, 1, i);
    insChunk.run(i, i, 0, 1, 10, `export function fn${i}() { return ${i}; }`, 12);
    insFts.run(i, `fn${i} fn ${i}`, `src/m${i}.ts`, `export function fn${i}`);
  }
})();
const t1 = performance.now();
const hit = db.prepare("select rowid, bm25(chunks_fts,5.0,2.0,1.0) s from chunks_fts where chunks_fts match ? order by s limit 3").all('fn777');
const t2 = performance.now();
db.prepare('delete from files where id between 1 and 1000').run();
const left = db.prepare('select (select count(*) from chunks) c, (select count(*) from chunks_fts) f').get();
console.log(`insert ${N} file+chunk+fts: ${(t1 - t0).toFixed(0)} ms; fts query: ${(t2 - t1).toFixed(2)} ms`, hit);
console.log('setelah hapus 1000 file (cascade + trigger FTS):', left);
db.close();
