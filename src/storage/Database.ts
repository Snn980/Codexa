/**
 * @file     Database.ts
 * @module   storage
 * @version  1.1.0
 * @since    Phase 1 — Foundation
 *
 * ── v1.1.0 değişiklikleri ────────────────────────────────────────────────────
 *  [1] ExecuteResult  — execute() artık Promise<ExecuteResult> döner.
 *      rowsAffected: optimistic lock çakışması tespiti için zorunlu.
 *      lastInsertId: INSERT sonrası otomatik ID okuma için.
 *
 *  [2] IDatabaseDriver.execute() imzası güncellendi:
 *        Promise<void>  →  Promise<ExecuteResult>
 *
 *  [3] Migration 6  — projects ve files tablolarına version kolonu eklendi.
 *      ALTER TABLE ... ADD COLUMN version INTEGER NOT NULL DEFAULT 1
 *      Mevcut satırlar version=1 ile başlar.
 */

import type { AppError, AsyncResult, MetaRecord, Result } from "../types/core";
import { ErrorCode }                                       from "../types/core";
import { err, ok, tryResultAsync }                         from "../utils/result";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Driver Abstraction
// ─────────────────────────────────────────────────────────────────────────────

export interface QueryResult<T = MetaRecord> {
  readonly rows:         T[];
  readonly rowsAffected: number;
  readonly lastInsertId: number | null;
}

/**
 * ← [1] DML sonuç tipi.
 * SELECT olmayan her execute() çağrısında döner.
 */
export interface ExecuteResult {
  /** Etkilenen satır sayısı — 0 ise optimistic lock çakışması veya kayıt yok */
  readonly rowsAffected: number;
  /** Son INSERT'in otomatik ID'si — INSERT dışında null */
  readonly lastInsertId: number | null;
}

export interface IDatabaseDriver {
  query<T = MetaRecord>(sql: string, params: readonly unknown[]): Promise<QueryResult<T>>;
  queryOne<T = MetaRecord>(sql: string, params: readonly unknown[]): Promise<T | null>;

  /** ← [2] Promise<void> → Promise<ExecuteResult> */
  execute(sql: string, params?: readonly unknown[]): Promise<ExecuteResult>;

  transaction<T>(fn: (tx: ITransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  isConnected(): boolean;
}

export interface ITransaction {
  query<T = MetaRecord>(sql: string, params: readonly unknown[]): Promise<QueryResult<T>>;
  queryOne<T = MetaRecord>(sql: string, params: readonly unknown[]): Promise<T | null>;
  execute(sql: string, params?: readonly unknown[]): Promise<ExecuteResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Konfigürasyon
// ─────────────────────────────────────────────────────────────────────────────

export interface DatabaseConfig {
  readonly path:               string;
  readonly enableWAL:          boolean;
  readonly timeoutMs:          number;
  readonly foreignKeys:        boolean;
  readonly migrationTimeoutMs: number;
}

export const DEFAULT_DATABASE_CONFIG: Readonly<DatabaseConfig> = Object.freeze({
  path:               "ide.db",
  enableWAL:          true,
  timeoutMs:          5_000,
  foreignKeys:        true,
  migrationTimeoutMs: 30_000,
});

// ─────────────────────────────────────────────────────────────────────────────
// § 3. Migration Sistemi
// ─────────────────────────────────────────────────────────────────────────────

export interface Migration {
  readonly version:     number;
  readonly description: string;
  readonly up:          string;
  readonly down?:       string;
}

interface MigrationRecord {
  version:     number;
  description: string;
  applied_at:  number;
  checksum:    string;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Migration Listesi
// ─────────────────────────────────────────────────────────────────────────────

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version:     1,
    description: "Migration tablosunu oluştur",
    up: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version      INTEGER PRIMARY KEY,
        description  TEXT    NOT NULL,
        applied_at   INTEGER NOT NULL,
        checksum     TEXT    NOT NULL
      );
    `,
  },
  {
    version:     2,
    description: "Projects tablosunu oluştur",
    up: `
      CREATE TABLE IF NOT EXISTS projects (
        id           TEXT    PRIMARY KEY,
        name         TEXT    NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
        description  TEXT    NOT NULL DEFAULT '',
        language     TEXT    NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'empty',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        meta_json    TEXT    NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_projects_status     ON projects(status);
      CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);
    `,
    down: `DROP TABLE IF EXISTS projects;`,
  },
  {
    version:     3,
    description: "Files tablosunu oluştur",
    up: `
      CREATE TABLE IF NOT EXISTS files (
        id           TEXT    PRIMARY KEY,
        project_id   TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path         TEXT    NOT NULL CHECK(length(path) <= 512),
        name         TEXT    NOT NULL,
        type         TEXT    NOT NULL DEFAULT 'unknown',
        content      TEXT    NOT NULL DEFAULT '',
        checksum     TEXT    NOT NULL,
        size         INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        is_dirty     INTEGER NOT NULL DEFAULT 0 CHECK(is_dirty IN (0, 1))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_files_project_path
        ON files(project_id, path);
      CREATE INDEX IF NOT EXISTS idx_files_project_id
        ON files(project_id);
    `,
    down: `DROP TABLE IF EXISTS files;`,
  },
  {
    version:     4,
    description: "Settings tablosunu oluştur",
    up: `
      CREATE TABLE IF NOT EXISTS settings (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
      );
      INSERT OR IGNORE INTO settings(key, value) VALUES
        ('fontSize',         '14'),
        ('lineHeight',       '1.5'),
        ('tabSize',          '2'),
        ('insertSpaces',     'true'),
        ('wordWrap',         'true'),
        ('showLineNumbers',  'true'),
        ('showMinimap',      'false'),
        ('theme',            'dark'),
        ('keyboardLayout',   'default'),
        ('autoSaveInterval', '3000'),
        ('maxTabs',          '8');
    `,
    down: `DROP TABLE IF EXISTS settings;`,
  },
  {
    version:     5,
    description: "AI sessions tablosunu oluştur",
    up: `
      CREATE TABLE IF NOT EXISTS ai_sessions (
        id            TEXT    PRIMARY KEY,
        provider      TEXT    NOT NULL,
        messages_json TEXT    NOT NULL DEFAULT '[]',
        total_tokens  INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_provider
        ON ai_sessions(provider);
    `,
    down: `DROP TABLE IF EXISTS ai_sessions;`,
  },
  {
    /**
     * ← [3] Optimistic lock için version kolonu.
     * ALTER TABLE IF NOT EXIST kolonu desteklemiyor;
     * önce kolonun var olup olmadığını kontrol eden pragma kullanılır.
     * Mevcut satırlar DEFAULT 1 ile başlar.
     */
    version:     6,
    description: "projects ve files tablolarına version kolonu ekle",
    up: `
      ALTER TABLE projects ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE files    ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
    `,
    down: `
      -- SQLite ALTER TABLE DROP COLUMN desteklemez (v3.35 öncesi).
      -- Rollback gerekiyorsa tablo yeniden oluşturulmalı.
    `,
  },
  {
    /**
     * § 37.3 (T-P15-6) — Chat geçmişi SQLite tabloları.
     *
     * MMKV → SQLite migrasyon eşiği:
     *   • 10.000 mesaj veya 50 MB → ChatStorageMigrator devreye girer.
     * chat_sessions: SessionMeta karşılığı.
     * chat_messages: ChatMessage listesi, session_id FK ile ilişkili.
     * FTS5 sanal tablosu: tam metin araması (SQLite FTS5 extension mevcutsa).
     */
    version:     7,
    description: "chat_sessions ve chat_messages tablolarını oluştur",
    up: `
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id            TEXT    PRIMARY KEY,
        title         TEXT    NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        preview       TEXT    NOT NULL DEFAULT '',
        message_count INTEGER NOT NULL DEFAULT 0,
        checksum      INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated
        ON chat_sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS chat_messages (
        id               TEXT    PRIMARY KEY,
        session_id       TEXT    NOT NULL
          REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role             TEXT    NOT NULL CHECK(role IN ('user','assistant','system')),
        content          TEXT    NOT NULL,
        timestamp        INTEGER NOT NULL,
        idempotency_key  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session
        ON chat_messages(session_id, timestamp ASC);
    `,
    down: `
      DROP TABLE IF EXISTS chat_messages;
      DROP TABLE IF EXISTS chat_sessions;
    `,
  },
  {
    version:     8,
    description: "settings tablosuna autoRun ekle (§ 68)",
    up: `
      INSERT OR IGNORE INTO settings(key, value) VALUES
        ('autoRun', 'false');
    `,
    down: `
      DELETE FROM settings WHERE key = 'autoRun';
    `,
  },
]);

// ─────────────────────────────────────────────────────────────────────────────
// § 5. MigrationRunner
// ─────────────────────────────────────────────────────────────────────────────

class MigrationRunner {
  constructor(private readonly driver: IDatabaseDriver) {}

  async run(migrations: readonly Migration[]): AsyncResult<void> {
    const bootstrap = migrations[0];
    if (!bootstrap) return ok(undefined);

    try {
      await this.driver.execute(bootstrap.up);
    } catch (cause) {
      return err(
        ErrorCode.DB_MIGRATION_FAILED,
        "Migration bootstrap tablosu oluşturulamadı",
        { cause: String(cause) },
      );
    }

    const appliedResult = await tryResultAsync(
      () => this.driver.query<MigrationRecord>(
        "SELECT version, checksum FROM schema_migrations ORDER BY version ASC",
        [],
      ),
      ErrorCode.DB_MIGRATION_FAILED,
      "Uygulanan migration'lar okunamadı",
    );

    if (!appliedResult.ok) return appliedResult;

    const appliedVersions = new Map(
      appliedResult.data.rows.map((r) => [r.version, r.checksum]),
    );

    const pending = migrations
      .slice(1)
      .filter((m) => !appliedVersions.has(m.version));

    for (const migration of pending) {
      const applyResult = await this.applyOne(migration);
      if (!applyResult.ok) return applyResult;
    }

    return ok(undefined);
  }

  private async applyOne(migration: Migration): AsyncResult<void> {
    return tryResultAsync(
      () =>
        this.driver.transaction(async (tx) => {
          await tx.execute(migration.up);
          await tx.execute(
            `INSERT INTO schema_migrations(version, description, applied_at, checksum)
             VALUES (?, ?, ?, ?)`,
            [
              migration.version,
              migration.description,
              Date.now(),
              this.simpleChecksum(migration.up),
            ],
          );
        }),
      ErrorCode.DB_MIGRATION_FAILED,
      `Migration v${migration.version} (${migration.description}) başarısız`,
      { version: migration.version },
    );
  }

  private simpleChecksum(sql: string): string {
    let hash = 0;
    for (let i = 0; i < sql.length; i++) {
      const char = sql.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, "0");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 6. Database — Singleton
// ─────────────────────────────────────────────────────────────────────────────

const enum ConnectionState {
  Idle       = "idle",
  Connecting = "connecting",
  Ready      = "ready",
  Closing    = "closing",
  Closed     = "closed",
  Failed     = "failed",
}

export class Database {
  private static instance: Database | null = null;

  public static getInstance(): Database {
    if (!Database.instance) Database.instance = new Database();
    return Database.instance;
  }

  public static resetInstance(): void {
    Database.instance = null;
  }

  private driver: IDatabaseDriver | null   = null;
  private state:  ConnectionState          = ConnectionState.Idle;
  private config: Readonly<DatabaseConfig> = DEFAULT_DATABASE_CONFIG;
  private runner: MigrationRunner | null   = null;

  private constructor() {}

  public async connect(
    config?: Partial<DatabaseConfig>,
    driver?: IDatabaseDriver,
  ): AsyncResult<void> {
    if (this.state === ConnectionState.Ready)      return ok(undefined);
    if (this.state === ConnectionState.Connecting) {
      return err(ErrorCode.DB_CONNECTION_FAILED, "Bağlantı zaten devam ediyor");
    }

    this.state  = ConnectionState.Connecting;
    this.config = Object.freeze({ ...DEFAULT_DATABASE_CONFIG, ...config });

    const resolveResult = await this.resolveDriver(driver);
    if (!resolveResult.ok) { this.state = ConnectionState.Failed; return resolveResult; }

    this.driver = resolveResult.data;
    this.runner = new MigrationRunner(this.driver);

    const pragmaResult = await this.applyPragmas();
    if (!pragmaResult.ok) { this.state = ConnectionState.Failed; return pragmaResult; }

    const migrationResult = await this.runner.run(MIGRATIONS);
    if (!migrationResult.ok) { this.state = ConnectionState.Failed; return migrationResult; }

    this.state = ConnectionState.Ready;
    return ok(undefined);
  }

  public getDriver(): IDatabaseDriver {
    if (this.state !== ConnectionState.Ready || !this.driver) {
      throw new Error(
        `[Database] getDriver() başarısız: durum="${this.state}". connect() önce çağrılmalı.`,
      );
    }
    return this.driver;
  }

  public async disconnect(): AsyncResult<void> {
    if (this.state === ConnectionState.Closed) return ok(undefined);
    if (this.state !== ConnectionState.Ready) {
      return err(ErrorCode.DB_CONNECTION_FAILED, `Kapatılamaz: durum="${this.state}"`);
    }

    this.state = ConnectionState.Closing;
    const closeResult = await tryResultAsync(
      () => this.driver!.close(),
      ErrorCode.DB_CONNECTION_FAILED,
      "Bağlantı kapatılamadı",
    );

    this.state  = closeResult.ok ? ConnectionState.Closed : ConnectionState.Failed;
    this.driver = null;
    return closeResult;
  }

  public getState(): string { return this.state; }

  public async healthCheck(): AsyncResult<{ latencyMs: number }> {
    if (this.state !== ConnectionState.Ready) {
      return err(ErrorCode.DB_CONNECTION_FAILED, `Sağlık kontrolü başarısız: durum="${this.state}"`);
    }
    const start = Date.now();
    return tryResultAsync(
      async () => { await this.driver!.queryOne("SELECT 1 AS ping", []); return { latencyMs: Date.now() - start }; },
      ErrorCode.DB_QUERY_FAILED,
      "Sağlık kontrolü başarısız",
    );
  }

  public async withTransaction<T>(fn: (tx: ITransaction) => Promise<T>): AsyncResult<T> {
    if (this.state !== ConnectionState.Ready) {
      return err(ErrorCode.DB_CONNECTION_FAILED, "Transaction başlatılamaz: bağlantı hazır değil");
    }
    return tryResultAsync(
      () => this.driver!.transaction(fn),
      ErrorCode.DB_QUERY_FAILED,
      "Transaction başarısız — otomatik rollback yapıldı",
    );
  }

  private async resolveDriver(injected?: IDatabaseDriver): AsyncResult<IDatabaseDriver> {
    if (injected) return ok(injected);
    // TS2322 FIX: LibSQLDriver → IDatabaseDriver upcast için generic açıkça belirtilir.
    // TypeScript, Result<LibSQLDriver> → Result<IDatabaseDriver> covariance'ını
    // union type'larda her zaman otomatik çıkaramaz; <IDatabaseDriver> bunu garantiler.
    return tryResultAsync<IDatabaseDriver>(
      async () => {
        const { LibSQLDriver } = await import("./drivers/LibSQLDriver");
        return new LibSQLDriver(this.config.path, this.config.timeoutMs);
      },
      ErrorCode.DB_CONNECTION_FAILED,
      "Veritabanı sürücüsü yüklenemedi",
    );
  }

  private async applyPragmas(): AsyncResult<void> {
    const pragmas = [
      this.config.foreignKeys ? "PRAGMA foreign_keys = ON;"  : "PRAGMA foreign_keys = OFF;",
      this.config.enableWAL   ? "PRAGMA journal_mode = WAL;" : "PRAGMA journal_mode = DELETE;",
      "PRAGMA synchronous = NORMAL;",
      "PRAGMA temp_store = MEMORY;",
      "PRAGMA cache_size = -8192;",
    ];

    for (const pragma of pragmas) {
      const result = await tryResultAsync(
        () => this.driver!.execute(pragma),
        ErrorCode.DB_CONNECTION_FAILED,
        `Pragma uygulanamadı: ${pragma}`,
      );
      if (!result.ok) return result;
    }
    return ok(undefined);
  }
}
