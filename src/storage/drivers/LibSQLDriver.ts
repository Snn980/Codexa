/**
 * @file     LibSQLDriver.ts
 *
 * FIX: Multi-statement DDL (ALTER TABLE ... ; ALTER TABLE ...)
 *
 * Sorun:
 *   `prepareAsync` SQLite C API'sinin `sqlite3_prepare_v2` fonksiyonunu kullanır.
 *   Bu fonksiyon tek seferde sadece 1 statement compile eder.
 *   Migration 6'daki 2 ALTER TABLE ifadesinden sadece ilki çalışıyordu.
 *   `files.version` kolonu hiç oluşmuyordu.
 *
 * Fix:
 *   `execute` metodunda DDL path'i (execAsync yerine) noktalı virgüle göre
 *   ayrıştırır ve her statement'ı ayrı ayrı çalıştırır.
 *   Bu sayede tüm migration statement'ları güvenli şekilde uygulanır.
 */

import * as SQLite from 'expo-sqlite';

import type {
  ExecuteResult,
  IDatabaseDriver,
  ITransaction,
  QueryResult,
} from "../Database";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. expo-sqlite Minimal Tip Tanımları
// ─────────────────────────────────────────────────────────────────────────────

interface ExpoSQLiteDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: unknown[]): Promise<{ lastInsertRowId: number; changes: number }>;
  getAllAsync<T>(sql: string, params: unknown[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params: unknown[]): Promise<T | null>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
  withExclusiveTransactionAsync(fn: () => Promise<void>): Promise<void>;
  closeAsync(): Promise<void>;
  prepareAsync(sql: string): Promise<ExpoSQLiteStatement>;
}

interface ExpoSQLiteStatement {
  executeAsync(params: unknown[]): Promise<{ lastInsertRowId: number; changes: number }>;
  getEachAsync<T>(params: unknown[]): AsyncIterable<T>;
  finalizeAsync(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Sabitler
// ─────────────────────────────────────────────────────────────────────────────

const MAX_STATEMENT_CACHE = 64;

let savepointCounter = 0;
function nextSavepointName(): string {
  return `sp_${++savepointCounter}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. Row Dönüştürücü
// ─────────────────────────────────────────────────────────────────────────────

function toCamelCase(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    result[camel] = row[key];
  }
  return result;
}

function mapRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((row) => toCamelCase(row) as T);
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Multi-statement SQL Ayrıştırıcı
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Noktalı virgülle ayrılmış SQL bloğunu tek tek statement listesine böler.
 * Boş satırlar ve yorum satırları (--) atlanır.
 *
 * Örnek:
 *   "ALTER TABLE a ADD COLUMN x;\nALTER TABLE b ADD COLUMN y;"
 *   → ["ALTER TABLE a ADD COLUMN x", "ALTER TABLE b ADD COLUMN y"]
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map(s => s.trim())
    // Boş satırları ve sadece yorum içerenleri at
    .filter(s => s.length > 0 && !s.replace(/--[^\n]*/g, '').trim().match(/^$/));
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. StatementCache
// ─────────────────────────────────────────────────────────────────────────────

class StatementCache {
  private readonly cache = new Map<string, {
    statement:  ExpoSQLiteStatement;
    lastUsedAt: number;
  }>();

  async get(sql: string, db: ExpoSQLiteDatabase): Promise<ExpoSQLiteStatement> {
    const cached = this.cache.get(sql);
    if (cached) { cached.lastUsedAt = Date.now(); return cached.statement; }

    if (this.cache.size >= MAX_STATEMENT_CACHE) await this.evictOldest();

    const statement = await db.prepareAsync(sql);
    this.cache.set(sql, { statement, lastUsedAt: Date.now() });
    return statement;
  }

  private async evictOldest(): Promise<void> {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastUsedAt < oldestTime) { oldestTime = entry.lastUsedAt; oldestKey = key; }
    }

    if (oldestKey) {
      await this.cache.get(oldestKey)!.statement.finalizeAsync().catch(() => {});
      this.cache.delete(oldestKey);
    }
  }

  async clear(): Promise<void> {
    await Promise.all(
      [...this.cache.values()].map((e) => e.statement.finalizeAsync().catch(() => {})),
    );
    this.cache.clear();
  }

  get size(): number { return this.cache.size; }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 6. LibSQLTransaction
// ─────────────────────────────────────────────────────────────────────────────

class LibSQLTransaction implements ITransaction {
  constructor(
    private readonly db:    ExpoSQLiteDatabase,
    private readonly cache: StatementCache,
  ) {}

  async query<T>(sql: string, params: readonly unknown[]): Promise<QueryResult<T>> {
    const rows = await this.db.getAllAsync<Record<string, unknown>>(sql, params as unknown[]);
    return { rows: mapRows<T>(rows), rowsAffected: 0, lastInsertId: null };
  }

  async queryOne<T>(sql: string, params: readonly unknown[]): Promise<T | null> {
    const row = await this.db.getFirstAsync<Record<string, unknown>>(sql, params as unknown[]);
    return row ? (toCamelCase(row) as T) : null;
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<ExecuteResult> {
    const trimmed = sql.trim().toUpperCase();

    const isDDL = trimmed.startsWith('CREATE')
      || trimmed.startsWith('ALTER')
      || trimmed.startsWith('DROP')
      || trimmed.startsWith('PRAGMA');

    // FIX: DDL multi-statement — her birini ayrı execAsync ile çalıştır
    if (isDDL || params.length === 0) {
      const statements = splitStatements(sql);
      for (const stmt of statements) {
        const upper = stmt.trim().toUpperCase();
        if (upper.startsWith('PRAGMA')) {
          try { await this.db.runAsync(stmt, []); } catch { /* pragma hatası yut */ }
        } else {
          await this.db.execAsync(stmt + ';');
        }
      }
      return { rowsAffected: 0, lastInsertId: null };
    }

    // DML tek statement — prepareAsync + executeAsync (cache'li)
    const stmt   = await this.cache.get(sql, this.db);
    const result = await stmt.executeAsync(params as unknown[]);
    return {
      rowsAffected: result.changes,
      lastInsertId: result.lastInsertRowId ?? null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 7. LibSQLDriver
// ─────────────────────────────────────────────────────────────────────────────

export class LibSQLDriver implements IDatabaseDriver {
  private db:                ExpoSQLiteDatabase | null = null;
  private connected                   = false;
  private readonly stmtCache = new StatementCache();
  private transactionDepth   = 0;

  constructor(
    private readonly dbPath:    string,
    private readonly timeoutMs: number,
  ) {}

  async query<T>(sql: string, params: readonly unknown[]): Promise<QueryResult<T>> {
    const handle = await this.ensureConnected();
    const rows   = await handle.getAllAsync<Record<string, unknown>>(sql, params as unknown[]);
    return { rows: mapRows<T>(rows), rowsAffected: 0, lastInsertId: null };
  }

  async queryOne<T>(sql: string, params: readonly unknown[]): Promise<T | null> {
    const handle = await this.ensureConnected();
    const row    = await handle.getFirstAsync<Record<string, unknown>>(sql, params as unknown[]);
    return row ? (toCamelCase(row) as T) : null;
  }

  /**
   * FIX: Multi-statement DDL desteği.
   *
   * Eski davranış:
   *   execAsync(sql) — bazı ortamlarda sadece ilk statement çalışırdı
   *
   * Yeni davranış:
   *   splitStatements(sql) → her birini ayrı execAsync ile çalıştır
   *   Bu sayede Migration 6 gibi çok satırlı ALTER TABLE'lar tam çalışır.
   *
   * DML (INSERT, UPDATE, DELETE) değişmedi — runAsync kullanmaya devam eder.
   */
  async execute(sql: string, params: readonly unknown[] = []): Promise<ExecuteResult> {
    const handle     = await this.ensureConnected();
    const trimmedSql = sql.trim().toUpperCase();

    const isDDL = trimmedSql.startsWith('CREATE')
      || trimmedSql.startsWith('ALTER')
      || trimmedSql.startsWith('DROP')
      || trimmedSql.startsWith('PRAGMA');

    // FIX: Multi-statement DDL — her birini ayrı çalıştır
    if (isDDL || params.length === 0) {
      const statements = splitStatements(sql);
      for (const stmt of statements) {
        const upper = stmt.trim().toUpperCase();
        if (upper.startsWith('PRAGMA')) {
          // PRAGMA journal_mode=WAL gibi ifadeler sonuç satırı döndürür,
          // execAsync bunlarda exception fırlatır. runAsync kullan, sonucu yok say.
          try { await handle.runAsync(stmt, []); } catch { /* pragma hatası yut */ }
        } else {
          await handle.execAsync(stmt + ';');
        }
      }
      return { rowsAffected: 0, lastInsertId: null };
    }

    // DML — runAsync gerçek rowsAffected döner
    const result = await handle.runAsync(sql, params as unknown[]);
    return {
      rowsAffected: result.changes,
      lastInsertId: result.lastInsertRowId ?? null,
    };
  }

  async transaction<T>(fn: (tx: ITransaction) => Promise<T>): Promise<T> {
    const handle = await this.ensureConnected();
    const tx     = new LibSQLTransaction(handle, this.stmtCache);

    if (this.transactionDepth === 0) {
      this.transactionDepth++;
      try {
        let result!: T;
        await handle.withExclusiveTransactionAsync(async () => { result = await fn(tx); });
        return result;
      } finally {
        this.transactionDepth--;
      }
    } else {
      const sp = nextSavepointName();
      this.transactionDepth++;
      try {
        await handle.execAsync(`SAVEPOINT ${sp};`);
        const result = await fn(tx);
        await handle.execAsync(`RELEASE SAVEPOINT ${sp};`);
        return result;
      } catch (cause) {
        await handle.execAsync(`ROLLBACK TO SAVEPOINT ${sp};`).catch(() => {});
        throw cause;
      } finally {
        this.transactionDepth--;
      }
    }
  }

  isConnected(): boolean {
    return this.connected && this.db !== null;
  }

  async close(): Promise<void> {
    if (!this.db) return;
    await this.stmtCache.clear();
    await this.db.closeAsync();
    this.db        = null;
    this.connected = false;
  }

  private async ensureConnected(): Promise<ExpoSQLiteDatabase> {
    if (this.db && this.connected) return this.db;
    this.db        = await this.openWithTimeout();
    this.connected = true;
    return this.db;
  }

  private openWithTimeout(): Promise<ExpoSQLiteDatabase> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`SQLite zaman aşımı (${this.timeoutMs}ms): ${this.dbPath}`)),
        this.timeoutMs,
      );
      this.openDatabase()
        .then((db) => { clearTimeout(timer); resolve(db); })
        .catch((e)  => { clearTimeout(timer); reject(e); });
    });
  }

  private async openDatabase(): Promise<ExpoSQLiteDatabase> {
    return SQLite.openDatabaseAsync(this.dbPath) as unknown as Promise<ExpoSQLiteDatabase>;
  }
}
