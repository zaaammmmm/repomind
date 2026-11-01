-- RepoMind: skema indeks persisten (SQLite >= 3.38, FTS5 wajib)
-- schema_version = 1. Naikkan PRAGMA user_version setiap perubahan DDL.
-- Aturan: indeks hanya fungsi dari isi file + konfigurasi (bukan riwayat perubahan).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA user_version = 1;

-- ---------------------------------------------------------------- meta
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- kunci: schema_version, analyzer_version, last_sync_ms, tsconfig_hash, exclude_hash, workspace_id

-- ---------------------------------------------------------------- files
CREATE TABLE IF NOT EXISTS files (
  id                   INTEGER PRIMARY KEY,
  path                 TEXT    NOT NULL UNIQUE,         -- relatif terhadap root, pemisah '/'
  dir                  TEXT    NOT NULL,                -- direktori induk, '' untuk root
  ext                  TEXT    NOT NULL CHECK (ext IN ('.ts', '.tsx', '.d.ts')),
  size_bytes           INTEGER NOT NULL,
  mtime_ms             INTEGER NOT NULL,
  content_hash         TEXT    NOT NULL,                -- SHA-256 hex
  export_surface_hash  TEXT    NOT NULL,                -- SHA-256 daftar ekspor + signature
  loc                  INTEGER NOT NULL DEFAULT 0,
  parse_error          INTEGER NOT NULL DEFAULT 0 CHECK (parse_error IN (0, 1)),
  analyzer_version     INTEGER NOT NULL,
  indexed_at_ms        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_dir  ON files(dir);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);   -- deteksi move

-- ---------------------------------------------------------------- symbols
CREATE TABLE IF NOT EXISTS symbols (
  id             INTEGER PRIMARY KEY,
  file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  parent_id      INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  qualified_name TEXT    NOT NULL,                      -- mis. AuthService.login
  kind           TEXT    NOT NULL CHECK (kind IN
                   ('function','class','method','property','interface','type','enum',
                    'namespace','variable','component')),
  start_line     INTEGER NOT NULL,
  start_col      INTEGER NOT NULL,
  end_line       INTEGER NOT NULL,
  end_col        INTEGER NOT NULL,
  signature      TEXT,
  is_exported    INTEGER NOT NULL DEFAULT 0 CHECK (is_exported IN (0, 1)),
  is_default     INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  is_async       INTEGER NOT NULL DEFAULT 0 CHECK (is_async IN (0, 1)),
  has_jsdoc      INTEGER NOT NULL DEFAULT 0 CHECK (has_jsdoc IN (0, 1)),
  jsdoc          TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind, file_id);

-- ---------------------------------------------------------------- exports
CREATE TABLE IF NOT EXISTS exports (
  id                INTEGER PRIMARY KEY,
  file_id           INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  export_name       TEXT    NOT NULL,                   -- 'default' untuk export default; '*' untuk export *
  kind              TEXT    NOT NULL CHECK (kind IN ('named','default','reexport','reexport_all','namespace')),
  symbol_id         INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  source_specifier  TEXT,                               -- untuk re-export
  source_name       TEXT,                               -- nama asli di modul sumber (re-export bernama)
  source_file_id    INTEGER REFERENCES files(id) ON DELETE SET NULL,
  line              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exports_file   ON exports(file_id);
CREATE INDEX IF NOT EXISTS idx_exports_source ON exports(source_file_id);

-- ---------------------------------------------------------------- imports
CREATE TABLE IF NOT EXISTS imports (
  id               INTEGER PRIMARY KEY,
  file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  specifier        TEXT    NOT NULL,                    -- mentah, mis. './token' atau '@/auth/login'
  status           TEXT    NOT NULL CHECK (status IN ('resolved','external','unresolved')),
  resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  external_package TEXT,
  is_type_only     INTEGER NOT NULL DEFAULT 0 CHECK (is_type_only IN (0, 1)),
  is_dynamic       INTEGER NOT NULL DEFAULT 0 CHECK (is_dynamic IN (0, 1)),  -- dynamic tidak masuk graf
  is_side_effect   INTEGER NOT NULL DEFAULT 0 CHECK (is_side_effect IN (0, 1)),
  line             INTEGER NOT NULL,
  CHECK ((status = 'resolved') = (resolved_file_id IS NOT NULL)),
  CHECK ((status = 'external') = (external_package IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_imports_file       ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_resolved   ON imports(resolved_file_id);
CREATE INDEX IF NOT EXISTS idx_imports_unresolved ON imports(status, specifier);

CREATE TABLE IF NOT EXISTS import_bindings (
  id            INTEGER PRIMARY KEY,
  import_id     INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  imported_name TEXT    NOT NULL,                       -- 'default' | '*' | nama ekspor
  local_name    TEXT    NOT NULL,
  is_type       INTEGER NOT NULL DEFAULT 0 CHECK (is_type IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_bindings_import ON import_bindings(import_id);

-- ---------------------------------------------------------------- symbol_refs
-- Referensi mentah + target terselesaikan. Re-resolve cukup meng-UPDATE kolom target_*.
CREATE TABLE IF NOT EXISTS symbol_refs (
  id                   INTEGER PRIMARY KEY,
  file_id              INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  enclosing_symbol_id  INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  name                 TEXT    NOT NULL,                -- nama lokal di sumber
  binding_id           INTEGER REFERENCES import_bindings(id) ON DELETE SET NULL,
  ref_kind             TEXT    NOT NULL CHECK (ref_kind IN
                         ('call','ref','type','extends','implements','jsx')),
  line                 INTEGER NOT NULL,
  col                  INTEGER NOT NULL,
  target_symbol_id     INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  target_file_id       INTEGER REFERENCES files(id)   ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_file    ON symbol_refs(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_target  ON symbol_refs(target_symbol_id);
CREATE INDEX IF NOT EXISTS idx_refs_binding ON symbol_refs(binding_id);
CREATE INDEX IF NOT EXISTS idx_refs_name    ON symbol_refs(name);

-- ---------------------------------------------------------------- chunks + FTS
CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  symbol_id   INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  ordinal     INTEGER NOT NULL,                         -- urutan dalam file
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  text        TEXT    NOT NULL,
  token_est   INTEGER NOT NULL,
  UNIQUE (file_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);

-- rowid = chunks.id. Isi FTS diisi aplikasi dalam transaksi yang sama dengan INSERT chunks.
-- Kolom: sym_name (nama + qualified + hasil pecah camelCase), path, body (kode + term tambahan).
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  sym_name, path, body,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
);
-- bobot bm25 yang dianjurkan: bm25(chunks_fts, 5.0, 2.0, 1.0)

CREATE TRIGGER IF NOT EXISTS trg_chunks_fts_delete
AFTER DELETE ON chunks
BEGIN
  DELETE FROM chunks_fts WHERE rowid = old.id;
END;

-- ---------------------------------------------------------------- ringkasan + cache LLM
CREATE TABLE IF NOT EXISTS summary_sections (
  section_key   TEXT PRIMARY KEY,                       -- 'general','entrypoints','top_modules','exports:src/auth',...
  payload_json  TEXT    NOT NULL,
  stale         INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
  computed_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS summary_section_sources (
  section_key TEXT    NOT NULL REFERENCES summary_sections(section_key) ON DELETE CASCADE,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (section_key, file_id)
);
-- File hilang -> tandai bagian ringkasan yang bergantung padanya sebagai usang
CREATE TRIGGER IF NOT EXISTS trg_files_delete_stale_summary
BEFORE DELETE ON files
BEGIN
  UPDATE summary_sections SET stale = 1
  WHERE section_key IN (SELECT section_key FROM summary_section_sources WHERE file_id = old.id);
END;

CREATE TABLE IF NOT EXISTS llm_cache (
  cache_key      TEXT PRIMARY KEY,                      -- SHA-256(section_id + hash sumber terurut + prompt_version + model)
  section_key    TEXT,
  kind           TEXT    NOT NULL CHECK (kind IN ('summary_refine')),
  response       TEXT    NOT NULL,
  model          TEXT    NOT NULL,
  prompt_version INTEGER NOT NULL,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  created_at_ms  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_cache_sources (
  cache_key TEXT    NOT NULL REFERENCES llm_cache(cache_key) ON DELETE CASCADE,
  file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (cache_key, file_id)
);
-- File terhapus -> hapus entri cache yang bergantung (dilakukan aplikasi atau trigger berikut)
CREATE TRIGGER IF NOT EXISTS trg_files_delete_llm_cache
BEFORE DELETE ON files
BEGIN
  DELETE FROM llm_cache
  WHERE cache_key IN (SELECT cache_key FROM llm_cache_sources WHERE file_id = old.id);
END;

-- ---------------------------------------------------------------- metrik
CREATE TABLE IF NOT EXISTS metrics_events (
  id           INTEGER PRIMARY KEY,
  ts_ms        INTEGER NOT NULL,
  session_id   TEXT    NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN
                 ('index_full','index_update','reconcile','retrieval','qa_local','llm_call')),
  payload_json TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_kind_ts ON metrics_events(kind, ts_ms);

-- ---------------------------------------------------------------- view turunan
-- Sisi graf file -> file (hanya import resolved, bukan dinamis)
-- Termasuk sisi re-export (barrel: export ... from) agar fan-in dan analisis dampak tidak melewatkan file barrel.
CREATE VIEW IF NOT EXISTS v_file_edges AS
SELECT i.file_id AS from_file_id, i.resolved_file_id AS to_file_id
FROM imports i
WHERE i.status = 'resolved' AND i.is_dynamic = 0
UNION
SELECT e.file_id, e.source_file_id
FROM exports e
WHERE e.source_file_id IS NOT NULL;

CREATE VIEW IF NOT EXISTS v_fan_in AS
SELECT to_file_id AS file_id, COUNT(*) AS fan_in FROM v_file_edges GROUP BY to_file_id;

CREATE VIEW IF NOT EXISTS v_fan_out AS
SELECT from_file_id AS file_id, COUNT(*) AS fan_out FROM v_file_edges GROUP BY from_file_id;

CREATE VIEW IF NOT EXISTS v_dir_stats AS
SELECT f.dir AS dir,
       COUNT(DISTINCT f.id) AS file_count,
       COUNT(s.id)          AS symbol_count
FROM files f LEFT JOIN symbols s ON s.file_id = f.id AND s.parent_id IS NULL
GROUP BY f.dir;

-- ---------------------------------------------------------------- contoh query intent
-- DEFINITION   : SELECT f.path, s.start_line FROM symbols s JOIN files f ON f.id=s.file_id
--                WHERE s.name = :name ORDER BY s.is_exported DESC, f.path;
-- USAGES       : SELECT f.path, r.line FROM symbol_refs r JOIN files f ON f.id=r.file_id
--                WHERE r.target_symbol_id = :sym ORDER BY f.path, r.line;
-- DEPENDENTS   : SELECT f.path FROM v_file_edges e JOIN files f ON f.id=e.from_file_id
--                WHERE e.to_file_id = :file ORDER BY f.path;
-- EXPORTS      : SELECT export_name, kind, line FROM exports WHERE file_id = :file ORDER BY line;
-- DIR_FUNCTIONS: SELECT f.path, s.name, s.start_line FROM symbols s JOIN files f ON f.id=s.file_id
--                WHERE s.kind='function' AND f.dir LIKE :dir || '%' ORDER BY f.path, s.start_line;
-- COMPONENT_USES: SELECT DISTINCT t.name, f.path, t.start_line FROM symbol_refs r
--                JOIN symbols t ON t.id=r.target_symbol_id JOIN files f ON f.id=t.file_id
--                WHERE r.enclosing_symbol_id = :component AND r.ref_kind IN ('jsx','call');
-- IMPACT       : lihat query rekursif pada dokumen spesifikasi bagian 4.
