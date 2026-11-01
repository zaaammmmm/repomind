import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const SCHEMA_VERSION = 1;

export interface OpenResult { db: Database.Database; recovered: boolean; reason?: 'corrupt' | 'schema' }

function schemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(join(here, '..', '..', 'sql', 'schema.sql'), 'utf8');
}

/** Buka indeks. Jika korup atau versi skema berbeda, kembalikan db kosong baru (ADR / FR-UPD-08). */
export function openIndex(path: string): OpenResult {
  let reason: OpenResult['reason'];
  let db: Database.Database | undefined;
  try {
    db = new Database(path);
    const ver = db.pragma('user_version', { simple: true }) as number;
    if (ver !== 0 && ver !== SCHEMA_VERSION) reason = 'schema';
    else if (ver !== 0) {
      const ok = db.pragma('integrity_check', { simple: true });
      if (ok !== 'ok') reason = 'corrupt';
    }
  } catch {
    reason = 'corrupt';
  }
  if (reason) {
    try { db?.close(); } catch { /* abaikan */ }
    return { db: recreate(path), recovered: true, reason };
  }
  db!.exec(schemaSql());
  return { db: db!, recovered: false };
}

function recreate(path: string): Database.Database {
  // Pemulihan: file lama dipindah ke .bak oleh pemanggil bila perlu; di sini cukup mulai bersih.
  for (const suffix of ['', '-wal', '-shm']) { try { fs.renameSync(path + suffix, path + suffix + '.bak'); } catch { /* tidak ada */ } }
  const db = new Database(path);
  db.exec(schemaSql());
  return db;
}
