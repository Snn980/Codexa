/**
 * storage/ISQLiteDriver.ts
 *
 * T-8 teknik borcu: `transaction()` metodu eklendi.
 * Önceki tüm `writeSnapshot` implementasyonlarındaki manuel BEGIN/COMMIT
 * bu interface üzerinden temiz transaction semantiği alır.
 *
 * § 1  Result<T> / tryResultAsync()
 * § 2  Atomic duplicate guard — transaction içinde güvenli
 * § 12 SQLite transaction: BEGIN/COMMIT/ROLLBACK — writeSnapshot atomik
 */

// ─── Query result types ────────────────────────────────────────────────────

export interface RunResult {
  rowsAffected: number;
  insertId?:    number | bigint;
}

// ─── ISQLiteDriver ──────────────────────────────────────────────────────────

export interface ISQLiteDriver {
  /** Parameterized query — SELECT değil */
  run(sql: string, params?: unknown[]): Promise<RunResult>;

  /** Tek satır SELECT — bulunamazsa null */
  get<T>(sql: string, params?: unknown[]): Promise<T | null>;

  /** Çok satır SELECT */
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * T-8: Atomik transaction.
   *
   * `fn` başarıyla tamamlanırsa COMMIT, throw ederse ROLLBACK.
   * İç içe transaction yoktur — tüm çağrılar flat.
   *
   * § 12: `writeSnapshot` bu metodu kullanır; manuel BEGIN/COMMIT kaldırıldı.
   *
   * @example
   * await driver.transaction(async () => {
   *   await driver.run("DELETE FROM symbols WHERE file_id = ?", [fileId]);
   *   await driver.run("INSERT INTO symbols ...", []);
   * });
   */
  transaction<T = void>(fn: () => Promise<T>): Promise<T>;

  /**
   * execute() — DDL/DML için run() alias'ı (SymbolIndex API uyumu).
   * Parameterized sorgu çalıştırır; SELECT için DEĞİL.
   */
  execute?(sql: string, params?: unknown[]): Promise<RunResult>;

  /**
   * query<T>() — SELECT için all() alias'ı (SymbolIndex API uyumu).
   * Sonuç satırlarını dizi olarak döner.
   */
  query?<T>(sql: string, params?: unknown[]): Promise<T[]>;

  /** DDL + başlangıç verilerini hazırla */
  initialize?(): Promise<void>;

  /** Bağlantıyı kapat */
  close?(): Promise<void>;
}

// ─── SqliteDriverBase (transaction() varsayılan implementasyon) ─────────────

/**
 * Gerçek ortamda expo-sqlite veya better-sqlite3 driver bu class'ı extends eder.
 * `transaction()` için minimal BEGIN/COMMIT/ROLLBACK default'u sağlar —
 * driver native transaction API'si varsa override eder.
 *
 * Test ortamında MockSqliteDriver bu base'i extend edebilir.
 */
export abstract class SqliteDriverBase implements ISQLiteDriver {
  abstract run(sql: string, params?: unknown[]): Promise<RunResult>;
  abstract get<T>(sql: string, params?: unknown[]): Promise<T | null>;
  abstract all<T>(sql: string, params?: unknown[]): Promise<T[]>;

  async transaction<T = void>(fn: () => Promise<T>): Promise<T> {
    await this.run("BEGIN");
    try {
      const result = await fn();
      await this.run("COMMIT");
      return result;
    } catch (e) {
      await this.run("ROLLBACK").catch(() => {});
      throw e;
    }
  }
}
