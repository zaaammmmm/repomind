import type Database from 'better-sqlite3';
import type { MetricEvent, MetricsSink } from '../contracts.js';

/**
 * FR-EVL-02, FR-LLM-04, FR-PRV-06. Peristiwa hanya memuat angka, status, dan jenis (lihat MetricEvent): tidak ada isi kode,
 * pertanyaan, jawaban, atau kredensial. Dua implementasi: memori (uji, CLI) dan tabel metrics_events (sesi extension).
 */
export class InMemoryMetrics implements MetricsSink {
  readonly events: { tsMs: number; sessionId: string; event: MetricEvent }[] = [];
  constructor(private readonly sessionId = 'session', private readonly now: () => number = Date.now) {}
  record(e: MetricEvent): void { this.events.push({ tsMs: this.now(), sessionId: this.sessionId, event: e }); }
  exportJsonl(): string { return this.events.map((x) => JSON.stringify({ ts_ms: x.tsMs, session_id: x.sessionId, ...x.event })).join('\n') + (this.events.length ? '\n' : ''); }
}

export class SqliteMetrics implements MetricsSink {
  private readonly ins; private readonly all;
  constructor(db: Database.Database, private readonly sessionId: string, private readonly now: () => number = Date.now) {
    this.ins = db.prepare('insert into metrics_events (ts_ms, session_id, kind, payload_json) values (?, ?, ?, ?)');
    this.all = db.prepare('select ts_ms, session_id, kind, payload_json from metrics_events order by id');
  }
  record(e: MetricEvent): void { const { kind, ...rest } = e; this.ins.run(this.now(), this.sessionId, kind, JSON.stringify(rest)); }
  exportJsonl(): string {
    const rows = this.all.all() as { ts_ms: number; session_id: string; kind: string; payload_json: string }[];
    return rows.map((r) => JSON.stringify({ ts_ms: r.ts_ms, session_id: r.session_id, kind: r.kind, ...(JSON.parse(r.payload_json) as object) })).join('\n') + (rows.length ? '\n' : '');
  }
}
