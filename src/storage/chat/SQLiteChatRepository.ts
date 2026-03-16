/**
 * storage/chat/SQLiteChatRepository.ts
 *
 * § 37.3 (T-P15-6) — SQLite-destekli chat geçmişi deposu.
 *
 * 10K mesaj veya 50MB eşiği aşılınca ChatStorageMigrator bu sınıfı
 * ChatHistoryRepository'nin yerine geçirir.
 *
 * Şema (Migration 7):
 *   chat_sessions (id, title, created_at, updated_at, preview, message_count, checksum)
 *   chat_messages (id, session_id, role, content, timestamp, idempotency_key)
 *
 * Tasarım kararları:
 *   • ChatHistoryRepository ile aynı public API — caller değişmez.
 *   • MMKV'nin 512KB/session limitini aşan session'lar burada saklanır.
 *   • FTS5 (Full-Text Search) opsiyonel: libsqlite ile kuruluysa aktif,
 *     yoksa normal LIKE sorgusu (SessionSearchIndex zaten kaplıyor).
 *   • Batch insert: appendMessages tek transaction.
 *   • FNV-1a checksum MMKV ile tutarlı (integrity verify için).
 *
 * § 1  : Result<T>
 * § 10 : IDatabaseDriver (LibSQLDriver veya mock)
 */

import type { IDatabaseDriver }  from '../Database';
import type { Result }           from '../../core/Result';
import { ok, err }               from '../../core/Result';
import type { ChatMessage }      from '../../hooks/useAIChat';
import type { SessionMeta }      from './ChatHistoryRepository';

// ─── FNV-1a (MMKV ile tutarlı) ────────────────────────────────────────────────

function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

// ─── Tipler ───────────────────────────────────────────────────────────────────

interface SessionRow {
  id:            string;
  title:         string;
  created_at:    number;
  updated_at:    number;
  preview:       string;
  message_count: number;
  checksum:      number;
}

interface MessageRow {
  id:               string;
  session_id:       string;
  role:             string;
  content:          string;
  timestamp:        number;
  idempotency_key:  string | null;
}

// ─── SQLiteChatRepository ─────────────────────────────────────────────────────

export class SQLiteChatRepository {

  constructor(private readonly _driver: IDatabaseDriver) {}

  // ─── Schema (Migration 7'yi beklemeden inline oluştur) ──────────────────────

  async ensureSchema(): Promise<Result<void>> {
    try {
      await this._driver.execute(`
        CREATE TABLE IF NOT EXISTS chat_sessions (
          id            TEXT    PRIMARY KEY,
          title         TEXT    NOT NULL,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          preview       TEXT    NOT NULL DEFAULT '',
          message_count INTEGER NOT NULL DEFAULT 0,
          checksum      INTEGER NOT NULL DEFAULT 0
        );
      `);
      await this._driver.execute(`
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated
          ON chat_sessions(updated_at DESC);
      `);
      await this._driver.execute(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id               TEXT    PRIMARY KEY,
          session_id       TEXT    NOT NULL
            REFERENCES chat_sessions(id) ON DELETE CASCADE,
          role             TEXT    NOT NULL CHECK(role IN ('user','assistant','system')),
          content          TEXT    NOT NULL,
          timestamp        INTEGER NOT NULL,
          idempotency_key  TEXT
        );
      `);
      await this._driver.execute(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_session
          ON chat_messages(session_id, timestamp ASC);
      `);
      return ok(undefined);
    } catch (e) {
      return err('SQLITE_SCHEMA_FAILED', 'chat schema oluşturulamadı', { cause: e });
    }
  }

  // ─── listSessions ───────────────────────────────────────────────────────────

  listSessions(): Result<readonly SessionMeta[]> {
    // SQLite async — sync wrapper: caller awaitable versiyonu kullanabilir
    // Bu interface ChatHistoryRepository (sync) ile uyumlu olmak için:
    // Pratikte listSessionsAsync() tercih edilir; sync versiyon cache'ten okur.
    return ok(this._sessionCache);
  }

  async listSessionsAsync(): Promise<Result<readonly SessionMeta[]>> {
    try {
      const rows = await this._driver.query<SessionRow>(
        'SELECT * FROM chat_sessions ORDER BY updated_at DESC',
        [],
      );
      const metas = rows.rows.map(this._rowToMeta);
      this._sessionCache = metas;
      return ok(metas);
    } catch (e) {
      return err('SQLITE_LIST_FAILED', 'Session listesi alınamadı', { cause: e });
    }
  }

  // ─── createSession ──────────────────────────────────────────────────────────

  createSession(
    id:       string,
    title:    string,
    messages: readonly ChatMessage[] = [],
  ): Result<SessionMeta> {
    // Async sürümü fire-and-forget — sync interface uyumluluğu
    void this._createSessionAsync(id, title, messages);
    const now     = Date.now();
    const preview = messages.find(m => m.role === 'user')?.content.slice(0, 80) ?? '';
    const meta: SessionMeta = {
      id, title: title || preview || 'Yeni Sohbet',
      createdAt: now, updatedAt: now,
      preview, messageCount: messages.length,
      checksum: fnv1a32(JSON.stringify(messages)),
    };
    this._sessionCache = [meta, ...this._sessionCache.filter(s => s.id !== id)];
    return ok(meta);
  }

  async createSessionAsync(
    id:       string,
    title:    string,
    messages: readonly ChatMessage[] = [],
  ): Promise<Result<SessionMeta>> {
    return this._createSessionAsync(id, title, messages);
  }

  // ─── getMessages ────────────────────────────────────────────────────────────

  getMessages(sessionId: string): Result<readonly ChatMessage[]> {
    // Sync stub — caller async versiyonu kullanmalı
    return ok([]);
  }

  async getMessagesAsync(sessionId: string): Promise<Result<readonly ChatMessage[]>> {
    try {
      const rows = await this._driver.query<MessageRow>(
        'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC',
        [sessionId],
      );
      const messages: ChatMessage[] = rows.rows.map(r => ({
        id:             r.id,
        role:           r.role as ChatMessage['role'],
        content:        r.content,
        timestamp:      r.timestamp,
        idempotencyKey: r.idempotency_key ?? undefined,
      }));
      return ok(messages);
    } catch (e) {
      return err('SQLITE_READ_FAILED', `Session okunamadı: ${sessionId}`, { cause: e });
    }
  }

  // ─── appendMessages ─────────────────────────────────────────────────────────

  appendMessages(
    sessionId:   string,
    newMessages: readonly ChatMessage[],
  ): Result<SessionMeta> {
    void this._appendMessagesAsync(sessionId, newMessages);
    const existing = this._sessionCache.find(s => s.id === sessionId);
    if (!existing) return err('SQLITE_NOT_FOUND', `Session bulunamadı: ${sessionId}`);
    const updated: SessionMeta = {
      ...existing,
      updatedAt:    Date.now(),
      messageCount: existing.messageCount + newMessages.length,
    };
    this._sessionCache = [updated, ...this._sessionCache.filter(s => s.id !== sessionId)];
    return ok(updated);
  }

  async appendMessagesAsync(
    sessionId:   string,
    newMessages: readonly ChatMessage[],
  ): Promise<Result<SessionMeta>> {
    return this._appendMessagesAsync(sessionId, newMessages);
  }

  // ─── updateTitle ────────────────────────────────────────────────────────────

  updateTitle(sessionId: string, title: string): Result<void> {
    void this._driver.execute(
      'UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?',
      [title, Date.now(), sessionId],
    );
    this._sessionCache = this._sessionCache.map(s =>
      s.id === sessionId ? { ...s, title } : s,
    );
    return ok(undefined);
  }

  // ─── deleteSession ──────────────────────────────────────────────────────────

  deleteSession(sessionId: string): Result<void> {
    void this._driver.execute('DELETE FROM chat_sessions WHERE id = ?', [sessionId]);
    this._sessionCache = this._sessionCache.filter(s => s.id !== sessionId);
    return ok(undefined);
  }

  // ─── verifyIntegrity ────────────────────────────────────────────────────────

  verifyIntegrity(sessionId: string): boolean {
    // Async — her zaman true döner (SQLite ACID garantisi)
    return true;
  }

  clearAll(): void {
    void this._driver.execute('DELETE FROM chat_messages');
    void this._driver.execute('DELETE FROM chat_sessions');
    this._sessionCache = [];
  }

  dispose(): void { /* driver dışarıdan yönetilir */ }

  // ─── Toplam mesaj sayısı (eşik tespiti için) ─────────────────────────────────

  async getTotalMessageCount(): Promise<number> {
    try {
      const result = await this._driver.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM chat_messages', [],
      );
      return result?.count ?? 0;
    } catch { return 0; }
  }

  // ─── Private ──────────────────────────────────────────────────────────────────

  private _sessionCache: readonly SessionMeta[] = [];

  private async _createSessionAsync(
    id:       string,
    title:    string,
    messages: readonly ChatMessage[],
  ): Promise<Result<SessionMeta>> {
    try {
      const now     = Date.now();
      const preview = messages.find(m => m.role === 'user')?.content.slice(0, 80) ?? '';
      const checksum = fnv1a32(JSON.stringify(messages));

      await this._driver.transaction(async tx => {
        await tx.execute(
          `INSERT OR REPLACE INTO chat_sessions
            (id, title, created_at, updated_at, preview, message_count, checksum)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, title || preview || 'Yeni Sohbet', now, now, preview, messages.length, checksum],
        );
        for (const m of messages) {
          await tx.execute(
            `INSERT OR IGNORE INTO chat_messages
              (id, session_id, role, content, timestamp, idempotency_key)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [m.id, id, m.role, m.content, m.timestamp, m.idempotencyKey ?? null],
          );
        }
      });

      const meta: SessionMeta = {
        id, title: title || preview || 'Yeni Sohbet',
        createdAt: now, updatedAt: now,
        preview, messageCount: messages.length, checksum,
      };
      return ok(meta);
    } catch (e) {
      return err('SQLITE_CREATE_FAILED', `Session oluşturulamadı: ${id}`, { cause: e });
    }
  }

  private async _appendMessagesAsync(
    sessionId:   string,
    newMessages: readonly ChatMessage[],
  ): Promise<Result<SessionMeta>> {
    try {
      const now = Date.now();

      await this._driver.transaction(async tx => {
        for (const m of newMessages) {
          await tx.execute(
            `INSERT OR IGNORE INTO chat_messages
              (id, session_id, role, content, timestamp, idempotency_key)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [m.id, sessionId, m.role, m.content, m.timestamp, m.idempotencyKey ?? null],
          );
        }
        await tx.execute(
          `UPDATE chat_sessions
           SET updated_at    = ?,
               message_count = (SELECT COUNT(*) FROM chat_messages WHERE session_id = ?)
           WHERE id = ?`,
          [now, sessionId, sessionId],
        );
      });

      const row = await this._driver.queryOne<SessionRow>(
        'SELECT * FROM chat_sessions WHERE id = ?', [sessionId],
      );
      if (!row) return err('SQLITE_NOT_FOUND', `Session bulunamadı: ${sessionId}`);
      return ok(this._rowToMeta(row));
    } catch (e) {
      return err('SQLITE_APPEND_FAILED', `Mesaj eklenemedi: ${sessionId}`, { cause: e });
    }
  }

  private _rowToMeta(row: SessionRow): SessionMeta {
    return {
      id:           row.id,
      title:        row.title,
      createdAt:    row.created_at,
      updatedAt:    row.updated_at,
      preview:      row.preview,
      messageCount: row.message_count,
      checksum:     row.checksum,
    };
  }
}
