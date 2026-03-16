/**
 * storage/IRecencyReader.ts
 *
 * ContextRanker'ın kullandığı recency arayüzü.
 * Phase 5.3 — RecencyStore (T-9)
 *
 * § 14.3 kararları:
 *  • Recency window = 30 dakika — ContextRanker normalize eder
 *  • `getLastEditedAt()` ham timestamp döner — skor hesabı ContextRanker'da
 *  • `file:saved` → immediate kayıt
 *  • `doc:changed` → 400ms debounce (§ 11: incremental index tetikleyici)
 */

// ─── EventBus event payloads ───────────────────────────────────────────────

/** EventBus: "file:saved" */
export interface FileSavedEvent {
  readonly fileId:    string;
  readonly projectId: string;
  readonly path:      string;
}

/** EventBus: "doc:changed" */
export interface DocChangedEvent {
  readonly fileId: string;
}

// ─── IRecencyReader ────────────────────────────────────────────────────────

export interface IRecencyReader {
  /**
   * Dosyanın son düzenleme zamanını döner (Unix ms).
   * Hiç kaydedilmemişse `null`.
   * ContextRanker bu değeri 30 dakikalık pencereye göre 0–1 normalize eder.
   */
  getLastEditedAt(fileId: string): Promise<number | null>;

  /**
   * Son N dosyanın fileId listesini düzenleme zamanına göre azalan sırada döner.
   * ContextRanker toplu skor normalizasyonu için kullanır.
   * `limit` belirtilmezse `DEFAULT_RECENCY_LIMIT` (64) kullanılır.
   */
  getRecentFileIds(limit?: number): Promise<ReadonlyArray<string>>;
}

export const DEFAULT_RECENCY_LIMIT = 64;
export const RECENCY_WINDOW_MS     = 30 * 60 * 1_000; // 30 dakika
export const DOC_CHANGE_DEBOUNCE_MS = 400;             // § 11
