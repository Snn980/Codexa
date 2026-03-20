/**
 * storage/RecencyStore.ts
 *
 * SqliteRecencyStore — IRecencyReader implementasyonu.
 * Phase 5.3 — RecencyStore (T-9)
 *
 * SQLite tablo: file_recency
 *   file_id      TEXT PRIMARY KEY
 *   last_edited  INTEGER NOT NULL   — Unix ms
 *   edit_count   INTEGER NOT NULL DEFAULT 1
 *
 * § 2 kararları:
 *  • Atomic duplicate guard: INSERT OR REPLACE (UNIQUE constraint üzerinde)
 *  • Optimistic lock gerekmez — recency tek satır, son değer canonical
 *
 * § 3 kararları:
 *  • Her `on()` return değeri `_unsubs` dizisinde saklanır
 *  • `dispose()` tüm unsub'ları çağırır
 *  • `emit()` asla throw etmez — handler içindeki hata RecencyStore'u çökertmez
 *
 * § 1 kararları:
 *  • `tryResultAsync()` tüm DB çağrılarını sarar
 *  • `Result<T>.data` — `.value` değil
 */

import type { IRecencyReader, FileSavedEvent, DocChangedEvent } from "./IRecencyReader";
import {
  DEFAULT_RECENCY_LIMIT,
  DOC_CHANGE_DEBOUNCE_MS,
} from "./IRecencyReader";
import type { Result } from "../types/core";
import { ok, err, tryResultAsync } from "../utils/result";

// ─── ISQLiteDriver (minimal — T-8 transaction() eklenmeden önce) ───────────

export interface ISQLiteDriver {
  run(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
  get<T>(sql: string, params?: unknown[]): Promise<T | null>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

// ─── IEventBus (minimal — § 3 kurallarına uygun) ──────────────────────────

export type UnsubFn = () => void;

export interface IEventBus {
  on<T>(event: string, handler: (payload: T) => void): UnsubFn;
  emit<T>(event: string, payload: T): void;
}

// ─── Error codes ──────────────────────────────────────────────────────────

export const RecencyErrorCode = {
  DB_READ_FAILED:    "RECENCY_DB_READ_FAILED",
  DB_WRITE_FAILED:   "RECENCY_DB_WRITE_FAILED",
  ALREADY_DISPOSED:  "RECENCY_ALREADY_DISPOSED",
} as const;
export type RecencyErrorCode = (typeof RecencyErrorCode)[keyof typeof RecencyErrorCode];

// ─── DB row type ──────────────────────────────────────────────────────────

interface RecencyRow {
  file_id:     string;
  last_edited: number;
  edit_count:  number;
}

// ─── SqliteRecencyStore ───────────────────────────────────────────────────

export class SqliteRecencyStore implements IRecencyReader {
  private readonly _db:       ISQLiteDriver;
  private readonly _bus:      IEventBus;
  private readonly _unsubs:   UnsubFn[] = [];
  private readonly _debounce: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private _disposed = false;

  constructor(db: ISQLiteDriver, bus: IEventBus) {
    this._db  = db;
    this._bus = bus;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * DDL + EventBus subscription'ları kur.
   * AppContainer init zincirinde çağrılır.
   */
  async initialize(): Promise<Result<void>> {
    if (this._disposed) {
      return err(RecencyErrorCode.ALREADY_DISPOSED, "RecencyStore disposed");
    }

    const ddlResult = await tryResultAsync(
      () => this._db.run(`
        CREATE TABLE IF NOT EXISTS file_recency (
          file_id     TEXT    PRIMARY KEY,
          last_edited INTEGER NOT NULL,
          edit_count  INTEGER NOT NULL DEFAULT 1
        )
      `),
      RecencyErrorCode.DB_WRITE_FAILED,
      "Failed to create file_recency table",
    );

    if (!ddlResult.ok) return ddlResult;

    // § 3: her on() return değeri saklanır
    this._unsubs.push(
      // file:saved → immediate kayıt
      this._bus.on<FileSavedEvent>("file:saved", ({ fileId }) => {
        void this._record(fileId, Date.now());
      }),

      // doc:changed → 400ms debounce (§ 11)
      this._bus.on<DocChangedEvent>("doc:changed", ({ fileId }) => {
        this._scheduleRecord(fileId);
      }),
    );

    return ok(undefined);
  }

  /**
   * Tüm kaynakları serbest bırak.
   * Bekleyen debounce timer'ları flush edilmez — dispose'da iptal edilir.
   * (Kritik recency'ler `file:saved` ile zaten kaydedilmiştir.)
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // § 3: tüm unsub'ları çağır
    for (const unsub of this._unsubs) {
      unsub();
    }
    this._unsubs.length = 0;

    // Bekleyen debounce timer'larını temizle
    for (const timer of this._debounce.values()) {
      clearTimeout(timer);
    }
    this._debounce.clear();
  }

  // ─── IRecencyReader ─────────────────────────────────────────────────────

  async getLastEditedAt(fileId: string): Promise<number | null> {
    if (this._disposed) return null;

    const result = await tryResultAsync(
      () => this._db.get<RecencyRow>(
        "SELECT last_edited FROM file_recency WHERE file_id = ?",
        [fileId],
      ),
      RecencyErrorCode.DB_READ_FAILED,
      `Failed to read recency for: ${fileId}`,
    );

    if (!result.ok) return null;
    return result.data?.last_edited ?? null;
  }

  async getRecentFileIds(limit: number = DEFAULT_RECENCY_LIMIT): Promise<ReadonlyArray<string>> {
    if (this._disposed) return [];

    const result = await tryResultAsync(
      () => this._db.all<{ file_id: string }>(
        "SELECT file_id FROM file_recency ORDER BY last_edited DESC LIMIT ?",
        [limit],
      ),
      RecencyErrorCode.DB_READ_FAILED,
      "Failed to read recent file IDs",
    );

    if (!result.ok) return [];
    return result.data.map((r) => r.file_id);
  }

  // ─── Manual record (test & direct call) ────────────────────────────────

  /**
   * Bir dosyanın edit zamanını doğrudan kaydet.
   * Test ortamında ve EventBus dışı entegrasyonlarda kullanılır.
   */
  async recordEdit(fileId: string, ts: number = Date.now()): Promise<Result<void>> {
    return this._record(fileId, ts);
  }

  // ─── private ────────────────────────────────────────────────────────────

  private async _record(fileId: string, ts: number): Promise<Result<void>> {
    if (this._disposed) {
      return err(RecencyErrorCode.ALREADY_DISPOSED, "RecencyStore disposed");
    }

    const r = await tryResultAsync(
      () => this._db.run(
        `INSERT INTO file_recency (file_id, last_edited, edit_count)
         VALUES (?, ?, 1)
         ON CONFLICT(file_id) DO UPDATE SET
           last_edited = excluded.last_edited,
           edit_count  = edit_count + 1`,
        [fileId, ts],
      ),
      RecencyErrorCode.DB_WRITE_FAILED,
      `Failed to record edit for: ${fileId}`,
    );
    if (!r.ok) return r;
    return { ok: true, data: undefined };
  }

  /**
   * doc:changed debounce — 400ms.
   * Aynı fileId için gelen yeni event önceki timer'ı sıfırlar.
   */
  private _scheduleRecord(fileId: string): void {
    const existing = this._debounce.get(fileId);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      this._debounce.delete(fileId);
      void this._record(fileId, Date.now());
    }, DOC_CHANGE_DEBOUNCE_MS);

    this._debounce.set(fileId, timer);
  }
}
