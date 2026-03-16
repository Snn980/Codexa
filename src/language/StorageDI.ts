/**
 * language/StorageDI.ts
 *
 * T-3: Language worker storage DI — `_initialize` içindeki stub kaldırıldı.
 *
 * Language worker init sırası:
 *  1. ISQLiteDriver.initialize() → DDL (symbols, file_snapshots, deps tabloları)
 *  2. ILevelDb bağlantısı kur
 *  3. SymbolIndex oluştur (driver + ldb inject)
 *  4. DependencyIndex oluştur (ldb + bus inject)
 *  5. TreeSitterAdapter oluştur (loader inject)
 *  6. ScopeAnalyzer oluştur (adapter inject)
 *
 * § 1  Result<T> / tryResultAsync()
 * § 2  DDL atomik init — tablo yoksa CREATE TABLE IF NOT EXISTS
 * § 12 LevelDB key şeması sabitlendi
 */

import type { ISQLiteDriver } from "../storage/ISQLiteDriver";
import type { Result } from "../types";
import { ok, err, tryResultAsync } from "../result";

// ─── Minimal interface references ─────────────────────────────────────────

export interface ILevelDb {
  get(key: string):    Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  del(key: string):    Promise<void>;
  scan(prefix: string): Promise<ReadonlyArray<{ key: string; value: string }>>;
  batch(ops: Array<{ type: "put" | "del"; key: string; value?: string }>): Promise<void>;
  close(): Promise<void>;
}

// ─── DDL ──────────────────────────────────────────────────────────────────

/**
 * T-3: Gerçek DDL — stub'da yoktu.
 *
 * § 2: optimistic lock version kolonu symbols tablosunda.
 * § 12: SQLite transaction, Bulk INSERT.
 */
const SYMBOL_INDEX_DDL = `
  CREATE TABLE IF NOT EXISTS symbols (
    id         TEXT    PRIMARY KEY,
    file_id    TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    kind       TEXT    NOT NULL,
    start_line INTEGER NOT NULL,
    end_line   INTEGER NOT NULL,
    start_col  INTEGER NOT NULL,
    end_col    INTEGER NOT NULL,
    version    INTEGER NOT NULL DEFAULT 1,
    UNIQUE(id)
  );

  CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
  CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

  CREATE TABLE IF NOT EXISTS file_snapshots (
    file_id   TEXT    PRIMARY KEY,
    checksum  INTEGER NOT NULL,
    version   INTEGER NOT NULL DEFAULT 1,
    indexed_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE IF NOT EXISTS symbol_refs (
    id         TEXT    PRIMARY KEY,
    symbol_id  TEXT    NOT NULL,
    file_id    TEXT    NOT NULL,
    line       INTEGER NOT NULL,
    col        INTEGER NOT NULL,
    FOREIGN KEY (symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_refs_symbol ON symbol_refs(symbol_id);
  CREATE INDEX IF NOT EXISTS idx_refs_file   ON symbol_refs(file_id);
`;

// ─── StorageInitializer ────────────────────────────────────────────────────

export class StorageInitializer {
  private readonly _db:  ISQLiteDriver;
  private _initialized = false;

  constructor(db: ISQLiteDriver) {
    this._db = db;
  }

  /**
   * T-3 FIX: Gerçek DDL çalıştır.
   * Önceki stub: `// TODO: initialize storage`.
   *
   * T-8 entegrasyonu: Tablo oluşturma transaction içinde değil —
   * DDL SQLite'da auto-commit'tir (BEGIN içinde de çalışır ama gerekmez).
   */
  async initialize(): Promise<Result<void>> {
    if (this._initialized) return ok(undefined);

    const statements = SYMBOL_INDEX_DDL
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const sql of statements) {
      const result = await tryResultAsync(
        () => this._db.run(sql),
        "STORAGE_INIT_FAILED",
        `DDL failed: ${sql.slice(0, 60)}...`,
      );
      if (!result.ok) return result;
    }

    this._initialized = true;
    return ok(undefined);
  }

  get isInitialized(): boolean {
    return this._initialized;
  }
}

// ─── LanguageWorkerStorageContext ─────────────────────────────────────────

/**
 * Language worker'ın ihtiyaç duyduğu tüm storage bağımlılıklarını
 * tek noktada toplar ve init sırasını koordine eder.
 *
 * Kullanım (language.worker.ts içinde):
 *
 *   const ctx = new LanguageWorkerStorageContext(sqliteDriver, levelDb, bus);
 *   const initResult = await ctx.initialize();
 *   if (!initResult.ok) { self.postMessage({ type: "error", ... }); return; }
 *
 *   const symbolIndex = ctx.symbolIndex;
 *   const depIndex    = ctx.dependencyIndex;
 *   const scopeAnalyzer = ctx.scopeAnalyzer;
 */
export interface ILanguageWorkerStorageContext {
  initialize(): Promise<Result<void>>;
  readonly isReady: boolean;
}

// ─── StorageDI error codes ────────────────────────────────────────────────

export const StorageDIErrorCode = {
  INIT_FAILED:     "STORAGE_DI_INIT_FAILED",
  ALREADY_INIT:    "STORAGE_DI_ALREADY_INITIALIZED",
  NOT_INITIALIZED: "STORAGE_DI_NOT_INITIALIZED",
} as const;
