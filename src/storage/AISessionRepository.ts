/**
 * storage/AISessionRepository.ts — ai_sessions SQLite CRUD
 *
 * § 1  : Result<T>, tryResultAsync()
 * § 2  : Atomic UPSERT, transaction()
 *
 * DÜZELTMELER:
 *   ❗ BOYUT LİMİTİ    : messages alanı MAX_MESSAGES_COUNT (500) ve
 *      MAX_MESSAGES_BYTES (512 KB) ile sınırlandırılır. Aşılırsa en eski
 *      mesajlar kırpılır (sliding window). SQLite row şişmesi önlenir.
 *   💡 PARSE RECOVERY  : JSON parse hatası → boş dizi ile kurtarılır,
 *      session kayıp olmaz; hata loglama hook'u inject edilebilir.
 *   💡 TITLE AUTO-GEN  : createSession'da title boşsa ilk mesajdan otomatik
 *      üretilir. updateTitle'a gerek kalmadan iyi UX.
 */

import { ok, err, tryResultAsync } from "../core/Result";
import type { Result } from "../core/Result";
import type { ISQLiteDriver } from "../storage/ISQLiteDriver";
import type { UUID } from "../core/Types";
import type { AIModelId } from "../ai/AIModels";
import type { RuntimeMessage } from "../ai/IAIWorkerRuntime";

// ─── DDL ─────────────────────────────────────────────────────────────────────

export const AI_SESSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS ai_sessions (
    id         TEXT    PRIMARY KEY,
    model_id   TEXT    NOT NULL,
    title      TEXT    NOT NULL DEFAULT '',
    messages   TEXT    NOT NULL DEFAULT '[]',
    tokens     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_sessions_updated
    ON ai_sessions (updated_at DESC);
`;

// ─── Boyut limitleri ─────────────────────────────────────────────────────────

/** ❗ BOYUT: bu sayıdan fazla mesaj varsa en eskiler kırpılır */
const MAX_MESSAGES_COUNT = 500;
/** ❗ BOYUT: JSON bayt cinsinden üst limit (512 KB) */
const MAX_MESSAGES_BYTES = 512 * 1024;

// ─── Domain tipler ────────────────────────────────────────────────────────────

export interface AISession {
  id: UUID;
  modelId: AIModelId;
  title: string;
  messages: RuntimeMessage[];
  tokens: number;
  createdAt: number;
  updatedAt: number;
}

export interface AISessionSummary {
  id: UUID;
  modelId: AIModelId;
  title: string;
  tokens: number;
  updatedAt: number;
}

// ─── Hata kodları ─────────────────────────────────────────────────────────────

export const AISessionErrorCode = {
  NOT_FOUND:    "AI_SESSION_NOT_FOUND",
  PARSE_ERROR:  "AI_SESSION_PARSE_ERROR",
  WRITE_ERROR:  "AI_SESSION_WRITE_ERROR",
  DELETE_ERROR: "AI_SESSION_DELETE_ERROR",
} as const;

// ─── Yardımcı: title üret ────────────────────────────────────────────────────

/**
 * 💡 TITLE AUTO-GEN: mesajlardan ilk kullanıcı içeriğini alır.
 * 50 karakterde keser, "..." ekler. Boşsa "Yeni Sohbet" döner.
 */
function autoTitle(messages: RuntimeMessage[], fallback = "Yeni Sohbet"): string {
  const first = messages.find((m) => m.role === "user");
  if (!first?.content) return fallback;
  const text = first.content.trim().replace(/\s+/g, " ");
  return text.length > 50 ? text.slice(0, 50) + "…" : text;
}

// ─── Mesaj sliding window ─────────────────────────────────────────────────────

/**
 * ❗ BOYUT: birleştirilmiş mesajları limitle.
 * Önce sayı limiti (son N mesaj), sonra bayt limiti (JSON stringify).
 * Sistem mesajı her zaman korunur (ilk konumda olduğu varsayılır).
 */
function clampMessages(messages: RuntimeMessage[]): RuntimeMessage[] {
  let result = messages;

  // Sayı limiti
  if (result.length > MAX_MESSAGES_COUNT) {
    const systemMsgs = result.filter((m) => m.role === "system");
    const nonSystem  = result.filter((m) => m.role !== "system");
    const kept       = nonSystem.slice(-MAX_MESSAGES_COUNT + systemMsgs.length);
    result = [...systemMsgs, ...kept];
  }

  // Bayt limiti — ikili arama yerine basit döngü (N ≤ 500 olduğu için yeterli)
  while (result.length > 1) {
    const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
    if (bytes <= MAX_MESSAGES_BYTES) break;
    // En eski non-system mesajı çıkar
    const firstNonSystem = result.findIndex((m) => m.role !== "system");
    if (firstNonSystem === -1) break;
    result = [...result.slice(0, firstNonSystem), ...result.slice(firstNonSystem + 1)];
  }

  return result;
}

// ─── Parse yardımcısı ─────────────────────────────────────────────────────────

/**
 * 💡 PARSE RECOVERY: hatalı JSON → boş dizi; session kaybolmaz.
 * `onParseError` inject edilerek loglama yapılabilir.
 */
function safeParseMessages(
  json: string,
  onParseError?: (raw: string) => void,
): RuntimeMessage[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as RuntimeMessage[]) : [];
  } catch {
    onParseError?.(json);
    return [];
  }
}

// ─── Repository arayüzü ──────────────────────────────────────────────────────

export interface IAISessionRepository {
  listSummaries(limit?: number): Promise<Result<AISessionSummary[]>>;
  getSession(id: UUID): Promise<Result<AISession>>;
  createSession(session: Omit<AISession, "createdAt" | "updatedAt">): Promise<Result<AISession>>;
  appendMessages(
    id: UUID,
    newMessages: RuntimeMessage[],
    additionalTokens: number,
  ): Promise<Result<AISession>>;
  updateTitle(id: UUID, title: string): Promise<Result<void>>;
  deleteSession(id: UUID): Promise<Result<void>>;
  clearAll(): Promise<Result<void>>;
}

// ─── AISessionRepository ─────────────────────────────────────────────────────

export class AISessionRepository implements IAISessionRepository {
  private readonly _db: ISQLiteDriver;
  private readonly _now: () => number;
  private readonly _onParseError?: (raw: string) => void;

  constructor(
    db: ISQLiteDriver,
    now: () => number = Date.now,
    onParseError?: (raw: string) => void,
  ) {
    this._db = db;
    this._now = now;
    this._onParseError = onParseError;
  }

  // ─── listSummaries ────────────────────────────────────────────────────

  async listSummaries(limit = 50): Promise<Result<AISessionSummary[]>> {
    return tryResultAsync(async () => {
      const rows = await this._db.all<{
        id: string; model_id: string; title: string;
        tokens: number; updated_at: number;
      }>(
        `SELECT id, model_id, title, tokens, updated_at
         FROM ai_sessions ORDER BY updated_at DESC LIMIT ?`,
        [limit],
      );
      return rows.map((r) => ({
        id: r.id as UUID, modelId: r.model_id as AIModelId,
        title: r.title, tokens: r.tokens, updatedAt: r.updated_at,
      }));
    }, AISessionErrorCode.WRITE_ERROR, "listSummaries failed");
  }

  // ─── getSession ───────────────────────────────────────────────────────

  async getSession(id: UUID): Promise<Result<AISession>> {
    return tryResultAsync(async () => {
      const row = await this._db.get<{
        id: string; model_id: string; title: string;
        messages: string; tokens: number; created_at: number; updated_at: number;
      }>(
        `SELECT id, model_id, title, messages, tokens, created_at, updated_at
         FROM ai_sessions WHERE id = ?`,
        [id],
      );

      if (!row) {
        const e = new Error(`Session not found: ${id}`) as Error & { code: string };
        e.code = AISessionErrorCode.NOT_FOUND;
        throw e;
      }

      // 💡 PARSE RECOVERY
      const messages = safeParseMessages(row.messages, this._onParseError);

      return {
        id: row.id as UUID, modelId: row.model_id as AIModelId,
        title: row.title, messages, tokens: row.tokens,
        createdAt: row.created_at, updatedAt: row.updated_at,
      };
    }, AISessionErrorCode.WRITE_ERROR, "getSession failed");
  }

  // ─── createSession ────────────────────────────────────────────────────

  async createSession(
    session: Omit<AISession, "createdAt" | "updatedAt">,
  ): Promise<Result<AISession>> {
    return tryResultAsync(async () => {
      const now = this._now();
      // 💡 TITLE AUTO-GEN
      const title = session.title.trim() || autoTitle(session.messages);
      // ❗ BOYUT: yeni session'da zaten limite takılmamalı ama savunma
      const messages = clampMessages(session.messages);
      const messagesJson = JSON.stringify(messages);

      await this._db.run(
        `INSERT INTO ai_sessions
           (id, model_id, title, messages, tokens, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [session.id, session.modelId, title, messagesJson, session.tokens, now, now],
      );

      return { ...session, title, messages, createdAt: now, updatedAt: now };
    }, AISessionErrorCode.WRITE_ERROR, "createSession failed");
  }

  // ─── appendMessages ───────────────────────────────────────────────────

  async appendMessages(
    id: UUID,
    newMessages: RuntimeMessage[],
    additionalTokens: number,
  ): Promise<Result<AISession>> {
    return tryResultAsync(async () => {
      await this._db.transaction(async () => {
        const row = await this._db.get<{ messages: string; tokens: number }>(
          `SELECT messages, tokens FROM ai_sessions WHERE id = ?`, [id],
        );
        if (!row) throw new Error(`Session not found: ${id}`);

        // 💡 PARSE RECOVERY + ❗ BOYUT: sliding window
        const existing = safeParseMessages(row.messages, this._onParseError);
        const merged   = clampMessages([...existing, ...newMessages]);
        const updatedAt = this._now();

        await this._db.run(
          `UPDATE ai_sessions
           SET messages = ?, tokens = ?, updated_at = ?
           WHERE id = ?`,
          [JSON.stringify(merged), row.tokens + additionalTokens, updatedAt, id],
        );
      });

      const result = await this.getSession(id);
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    }, AISessionErrorCode.WRITE_ERROR, "appendMessages failed");
  }

  // ─── updateTitle ──────────────────────────────────────────────────────

  async updateTitle(id: UUID, title: string): Promise<Result<void>> {
    return tryResultAsync(async () => {
      await this._db.run(
        `UPDATE ai_sessions SET title = ?, updated_at = ? WHERE id = ?`,
        [title, this._now(), id],
      );
    }, AISessionErrorCode.WRITE_ERROR, "updateTitle failed");
  }

  // ─── deleteSession ────────────────────────────────────────────────────

  async deleteSession(id: UUID): Promise<Result<void>> {
    return tryResultAsync(async () => {
      await this._db.run(`DELETE FROM ai_sessions WHERE id = ?`, [id]);
    }, AISessionErrorCode.DELETE_ERROR, "deleteSession failed");
  }

  // ─── clearAll ─────────────────────────────────────────────────────────

  async clearAll(): Promise<Result<void>> {
    return tryResultAsync(async () => {
      await this._db.run(`DELETE FROM ai_sessions`, []);
    }, AISessionErrorCode.DELETE_ERROR, "clearAll failed");
  }
}
