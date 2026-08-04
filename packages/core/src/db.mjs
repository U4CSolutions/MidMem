/**
 * StateDB — the single source-of-truth.
 *
 * One SQLite database (node:sqlite, no external deps) holding entries + FTS5 +
 * vectors + typed graph (nodes/edges) + claims + operation log + audit proofs.
 * The markdown vault is a *projection* of this db, not a parallel store — fixing
 * the scaffold's central flaw (3+ disconnected stores).
 */

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCHEMA_VERSION = 3;

export class StateDB {
  /** @param {string} dbPath */
  constructor(dbPath) {
    this.path = dbPath;
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, type TEXT NOT NULL,
        title TEXT, hash TEXT, ingested_at TEXT NOT NULL, metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS entries (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        tier TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        source_id TEXT,
        provenance TEXT,
        concepts TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        scope TEXT NOT NULL DEFAULT 'shared',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        trust_score REAL NOT NULL DEFAULT 0.5,
        retrieval_count INTEGER NOT NULL DEFAULT 0,
        helpful_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_entries_tier ON entries(tier, status);

      -- Trigram FTS5 for substring/phrase matching (complements token-based entries_fts).
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts_trigram USING fts5(
        content, tokenize='trigram', content='entries', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS entries_tri_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts_trigram(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_tri_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts_trigram(entries_fts_trigram, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_tri_au AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts_trigram(entries_fts_trigram, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO entries_fts_trigram(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        content, type, tier, content='entries', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, content, type, tier)
        VALUES (new.rowid, new.content, new.type, new.tier);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, content, type, tier)
        VALUES ('delete', old.rowid, old.content, old.type, old.tier);
      END;
      CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, content, type, tier)
        VALUES ('delete', old.rowid, old.content, old.type, old.tier);
        INSERT INTO entries_fts(rowid, content, type, tier)
        VALUES (new.rowid, new.content, new.type, new.tier);
      END;

      CREATE TABLE IF NOT EXISTS vectors (
        entry_id TEXT PRIMARY KEY, dim INTEGER NOT NULL, embedding TEXT NOT NULL,
        model TEXT, created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL,
        properties TEXT, source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
        type TEXT NOT NULL, confidence REAL, properties TEXT, source TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);

      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT NOT NULL,
        source TEXT, provenance TEXT, status TEXT NOT NULL DEFAULT 'active',
        metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, operation TEXT NOT NULL, detail TEXT
      );

      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL,
        proof_hash TEXT, detail TEXT
      );

      CREATE TABLE IF NOT EXISTS projected_pages (
        path TEXT PRIMARY KEY, hash TEXT NOT NULL, updated_at TEXT
      );
    `);
    // Migrations for pre-existing databases (idempotent) — must precede any index on a new column.
    this.#ensureColumn('entries', 'scope', "TEXT NOT NULL DEFAULT 'shared'");
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope)');
    // v3: trust scoring + usage feedback + access recency
    this.#ensureColumn('entries', 'trust_score', 'REAL NOT NULL DEFAULT 0.5');
    this.#ensureColumn('entries', 'retrieval_count', 'INTEGER NOT NULL DEFAULT 0');
    this.#ensureColumn('entries', 'helpful_count', 'INTEGER NOT NULL DEFAULT 0');
    this.#ensureColumn('entries', 'last_accessed_at', 'TEXT');
    // v4 (roadmap 2026-08 #4): function axis — memory typed along independent axes (survey
    // arXiv 2607.25380): mem_function (working|episodic|semantic|procedural|prospective) is
    // orthogonal to the persistence tier. Nullable: legacy rows resolve via functionForType.
    this.#ensureColumn('entries', 'mem_function', 'TEXT');
    // v3: backfill the trigram index once for pre-existing rows (triggers cover new rows).
    if (!this.db.prepare("SELECT 1 FROM meta WHERE key='trigram_built'").get()) {
      if (this.db.prepare('SELECT COUNT(*) c FROM entries').get().c > 0)
        this.db.exec("INSERT INTO entries_fts_trigram(entries_fts_trigram) VALUES('rebuild')");
      this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('trigram_built','1')").run();
    }
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  /** Add a column if it doesn't already exist (SQLite has no ADD COLUMN IF NOT EXISTS). */
  #ensureColumn(table, col, def) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }

  /** Run fn inside a transaction; rolls back on throw (atomic writes across tables). */
  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }

  prepare(sql) { return this.db.prepare(sql); }
  exec(sql) { return this.db.exec(sql); }

  logOp(operation, detail) {
    this.db.prepare('INSERT INTO log(ts,operation,detail) VALUES(?,?,?)')
      .run(new Date().toISOString(), operation, JSON.stringify(detail ?? {}));
  }

  recordAudit(kind, proofHash, detail) {
    this.db.prepare('INSERT INTO audit(ts,kind,proof_hash,detail) VALUES(?,?,?,?)')
      .run(new Date().toISOString(), kind, proofHash ?? null, JSON.stringify(detail ?? {}));
  }

  close() { try { this.db.close(); } catch {} }
}
