import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openIndex, SCHEMA_VERSION } from '../src/store/open.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'rm-')), 'index.db');

describe('openIndex (FR-IDX-01, FR-UPD-08)', () => {
  it('membuat indeks baru dengan skema, WAL, dan FTS5', () => {
    const { db, recovered } = openIndex(tmp());
    expect(recovered).toBe(false);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.prepare("select count(*) c from sqlite_master where name='chunks_fts'").get()).toEqual({ c: 1 });
    db.close();
  });

  it('idempoten: membuka ulang tidak mengubah data', () => {
    const p = tmp();
    const a = openIndex(p);
    a.db.prepare("insert into meta(key,value) values('k','v')").run();
    a.db.close();
    const b = openIndex(p);
    expect(b.recovered).toBe(false);
    expect(b.db.prepare("select value from meta where key='k'").get()).toEqual({ value: 'v' });
    b.db.close();
  });

  it('membangun ulang bila berkas korup', () => {
    const p = tmp();
    writeFileSync(p, 'bukan database sqlite, isi sampah '.repeat(200));
    const r = openIndex(p);
    expect(r.recovered).toBe(true);
    expect(r.reason).toBe('corrupt');
    expect(r.db.prepare('select count(*) c from files').get()).toEqual({ c: 0 });
    r.db.close();
  });

  it('membangun ulang bila versi skema tidak cocok', () => {
    const p = tmp();
    const old = new Database(p);
    old.exec('create table x(a)'); old.pragma('user_version = 99'); old.close();
    const r = openIndex(p);
    expect(r.recovered).toBe(true);
    expect(r.reason).toBe('schema');
    r.db.close();
  });

  it('cascade hapus file membersihkan chunk dan FTS (trigger)', () => {
    const { db } = openIndex(tmp());
    db.prepare(`insert into files(id,path,dir,ext,size_bytes,mtime_ms,content_hash,export_surface_hash,analyzer_version,indexed_at_ms)
                values(1,'a.ts','','.ts',1,1,'h','s',1,1)`).run();
    db.prepare('insert into chunks(id,file_id,ordinal,start_line,end_line,text,token_est) values(1,1,0,1,2,?,1)').run('x');
    db.prepare('insert into chunks_fts(rowid,sym_name,path,body) values(1,?,?,?)').run('login', 'a.ts', 'function login');
    db.prepare('delete from files where id=1').run();
    expect(db.prepare('select count(*) c from chunks_fts').get()).toEqual({ c: 0 });
    db.close();
  });

  it('constraint: import resolved wajib punya resolved_file_id', () => {
    const { db } = openIndex(tmp());
    db.prepare(`insert into files(id,path,dir,ext,size_bytes,mtime_ms,content_hash,export_surface_hash,analyzer_version,indexed_at_ms)
                values(1,'a.ts','','.ts',1,1,'h','s',1,1)`).run();
    expect(() => db.prepare("insert into imports(file_id,specifier,status,line) values(1,'./b','resolved',1)").run()).toThrow();
    db.close();
  });
});
