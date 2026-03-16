// src/storage/chat/ChatHistoryRepository.ts
// § 37 — Chat history persist (MMKV)
//
// Düzeltilen sorunlar:
//   FIX-10  Session sayısı sınırsız büyüyebilir → LRU cleanup (maxSessions: 50)
//   FIX-11  MAX_BYTES_PER_SESSION enforcement doğrulandı ve güçlendirildi
//           (TextEncoder yerine byte estimate — RN'de TextEncoder performans sorunu)

import { MMKV }                    from 'react-native-mmkv';
import { ok, err, type Result }    from '../../core/Result';
import type { ChatMessage }        from '../hooks/useAIChat';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const MAX_MESSAGES_PER_SESSION = 500;
const MAX_BYTES_PER_SESSION    = 512 * 1024; // 512 KB
/** FIX-10 — LRU session limiti */
const MAX_SESSIONS             = 50;

const KEY_SESSION_MESSAGES = (id: string) => `chat:messages:${id}`;
const KEY_SESSION_META     = (id: string) => `chat:meta:${id}`;
const KEY_SESSION_INDEX    = 'chat:session_index';

// ─── FNV-1a checksum (§ 2) ───────────────────────────────────────────────────

function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

// ─── Byte estimate (FIX-11) ──────────────────────────────────────────────────
// TextEncoder RN'de overhead yaratabilir. UTF-8 için: ASCII ~1 byte, BMP ~3 byte worst case.
// Basit estimate: charCodePoint > 127 → 3 byte, yoksa 1 byte.

function estimateBytes(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    bytes += str.charCodeAt(i) > 127 ? 3 : 1;
  }
  return bytes;
}

// ─── Safe parse ───────────────────────────────────────────────────────────────

function safeParseMessages(raw: string | undefined): ChatMessage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is ChatMessage =>
        typeof m?.id === 'string' &&
        typeof m?.role === 'string' &&
        typeof m?.content === 'string' &&
        typeof m?.timestamp === 'number',
    );
  } catch {
    return [];
  }
}

function safeParseIndex(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? (p as string[]) : [];
  } catch { return []; }
}

// ─── clampMessages (§ 17.3 + FIX-11) ────────────────────────────────────────

function clampMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return [];

  const hasSystem = messages[0]?.role === 'system';
  const pinned    = hasSystem ? [messages[0]] : [];
  const rest      = hasSystem ? messages.slice(1) : [...messages];

  // FIX-11 — byte limiti: reversed iteration, geriden sil
  let byteTotal = pinned.reduce((acc, m) => acc + estimateBytes(m.content), 0);
  const byteFiltered: ChatMessage[] = [];
  const byteLimit = MAX_BYTES_PER_SESSION - 4096; // 4KB header rezerv

  for (let i = rest.length - 1; i >= 0; i--) {
    const b = estimateBytes(rest[i].content);
    if (byteTotal + b > byteLimit) break;
    byteTotal += b;
    byteFiltered.unshift(rest[i]);
  }

  // Sayı limiti
  const countLimit = MAX_MESSAGES_PER_SESSION - pinned.length;
  const countFiltered = byteFiltered.slice(-countLimit);

  return [...pinned, ...countFiltered];
}

// ─── Tipler ───────────────────────────────────────────────────────────────────

export interface SessionMeta {
  readonly id:           string;
  readonly title:        string;
  readonly createdAt:    number;
  readonly updatedAt:    number;
  readonly preview:      string;
  readonly messageCount: number;
  readonly checksum:     number;
}

// ─── ChatHistoryRepository ────────────────────────────────────────────────────

export class ChatHistoryRepository {
  private readonly _storage: MMKV;

  constructor(instanceId = 'chat-history') {
    // FIX (§ 37) — MMKV her zaman id ile açılır; namespace izolasyonu
    this._storage = new MMKV({ id: instanceId });
  }

  // ─── Index ──────────────────────────────────────────────────────────────────

  private _readIndex(): string[] {
    return safeParseIndex(this._storage.getString(KEY_SESSION_INDEX));
  }

  private _writeIndex(ids: string[]): void {
    this._storage.set(KEY_SESSION_INDEX, JSON.stringify(ids));
  }

  // ─── FIX-10: LRU cleanup ────────────────────────────────────────────────────

  /**
   * Session sayısı MAX_SESSIONS'ı aşarsa en eski (index sonundaki) session'ları sil.
   * updatedAt DESC sıralıdır → son eleman en eski.
   */
  private _enforceLRU(currentIndex: string[]): string[] {
    if (currentIndex.length <= MAX_SESSIONS) return currentIndex;

    const toRemove = currentIndex.slice(MAX_SESSIONS);
    for (const id of toRemove) {
      this._storage.delete(KEY_SESSION_MESSAGES(id));
      this._storage.delete(KEY_SESSION_META(id));
    }

    return currentIndex.slice(0, MAX_SESSIONS);
  }

  // ─── listSessions ───────────────────────────────────────────────────────────

  listSessions(): Result<readonly SessionMeta[]> {
    try {
      const ids   = this._readIndex();
      const metas: SessionMeta[] = [];
      for (const id of ids) {
        const raw = this._storage.getString(KEY_SESSION_META(id));
        if (!raw) continue;
        try { metas.push(JSON.parse(raw) as SessionMeta); }
        catch { /* bozuk meta → atla */ }
      }
      metas.sort((a, b) => b.updatedAt - a.updatedAt);
      return ok(metas);
    } catch (e) {
      return err('CHAT_LIST_FAILED', 'Failed to list sessions', { cause: e });
    }
  }

  // ─── createSession ──────────────────────────────────────────────────────────

  createSession(
    id:       string,
    title:    string,
    messages: readonly ChatMessage[] = [],
  ): Result<SessionMeta> {
    try {
      const now        = Date.now();
      const clamped    = clampMessages(messages); // FIX-11
      const serialized = JSON.stringify(clamped);
      const checksum   = fnv1a32(serialized);
      const preview    = clamped.find((m) => m.role === 'user')?.content.slice(0, 80) ?? '';

      const meta: SessionMeta = {
        id,
        title:        title || preview || 'Yeni Sohbet',
        createdAt:    now,
        updatedAt:    now,
        preview,
        messageCount: clamped.length,
        checksum,
      };

      this._storage.set(KEY_SESSION_MESSAGES(id), serialized);
      this._storage.set(KEY_SESSION_META(id), JSON.stringify(meta));

      // Index güncelle + FIX-10 LRU
      const index    = this._readIndex().filter((x) => x !== id);
      const newIndex = this._enforceLRU([id, ...index]);
      this._writeIndex(newIndex);

      return ok(meta);
    } catch (e) {
      return err('CHAT_CREATE_FAILED', `Failed to create session ${id}`, { cause: e });
    }
  }

  // ─── getMessages ────────────────────────────────────────────────────────────

  getMessages(sessionId: string): Result<readonly ChatMessage[]> {
    try {
      const raw = this._storage.getString(KEY_SESSION_MESSAGES(sessionId));
      return ok(safeParseMessages(raw));
    } catch (e) {
      return err('CHAT_READ_FAILED', `Failed to read session ${sessionId}`, { cause: e });
    }
  }

  // ─── appendMessages ─────────────────────────────────────────────────────────

  appendMessages(
    sessionId:   string,
    newMessages: readonly ChatMessage[],
  ): Result<SessionMeta> {
    try {
      const existing   = safeParseMessages(this._storage.getString(KEY_SESSION_MESSAGES(sessionId)));
      const metaRaw    = this._storage.getString(KEY_SESSION_META(sessionId));
      const oldMeta    = metaRaw ? (JSON.parse(metaRaw) as SessionMeta) : null;

      const merged     = clampMessages([...existing, ...newMessages]); // FIX-11
      const serialized = JSON.stringify(merged);
      const checksum   = fnv1a32(serialized);

      // Checksum değişmediyse no-op
      if (checksum === oldMeta?.checksum) return ok(oldMeta!);

      const now     = Date.now();
      const preview = merged.find((m) => m.role === 'user')?.content.slice(0, 80) ?? '';

      const newMeta: SessionMeta = {
        id:           sessionId,
        title:        oldMeta?.title ?? preview ?? 'Yeni Sohbet',
        createdAt:    oldMeta?.createdAt ?? now,
        updatedAt:    now,
        preview,
        messageCount: merged.length,
        checksum,
      };

      this._storage.set(KEY_SESSION_MESSAGES(sessionId), serialized);
      this._storage.set(KEY_SESSION_META(sessionId), JSON.stringify(newMeta));

      // updatedAt değişti → index'i başa taşı (LRU güncelleme)
      const index    = this._readIndex().filter((x) => x !== sessionId);
      const newIndex = this._enforceLRU([sessionId, ...index]);
      this._writeIndex(newIndex);

      return ok(newMeta);
    } catch (e) {
      return err('CHAT_APPEND_FAILED', `Failed to append to session ${sessionId}`, { cause: e });
    }
  }

  // ─── updateTitle ────────────────────────────────────────────────────────────

  updateTitle(sessionId: string, title: string): Result<void> {
    try {
      const raw = this._storage.getString(KEY_SESSION_META(sessionId));
      if (!raw) return err('CHAT_NOT_FOUND', `Session not found: ${sessionId}`);
      const meta: SessionMeta = JSON.parse(raw);
      this._storage.set(
        KEY_SESSION_META(sessionId),
        JSON.stringify({ ...meta, title, updatedAt: Date.now() }),
      );
      return ok(undefined);
    } catch (e) {
      return err('CHAT_UPDATE_FAILED', `Failed to update title for ${sessionId}`, { cause: e });
    }
  }

  // ─── deleteSession ──────────────────────────────────────────────────────────

  deleteSession(sessionId: string): Result<void> {
    try {
      this._storage.delete(KEY_SESSION_MESSAGES(sessionId));
      this._storage.delete(KEY_SESSION_META(sessionId));
      this._writeIndex(this._readIndex().filter((id) => id !== sessionId));
      return ok(undefined);
    } catch (e) {
      return err('CHAT_DELETE_FAILED', `Failed to delete session ${sessionId}`, { cause: e });
    }
  }

  // ─── verifyIntegrity ────────────────────────────────────────────────────────

  verifyIntegrity(sessionId: string): boolean {
    try {
      const raw     = this._storage.getString(KEY_SESSION_MESSAGES(sessionId));
      const metaRaw = this._storage.getString(KEY_SESSION_META(sessionId));
      if (!raw || !metaRaw) return false;
      return fnv1a32(raw) === (JSON.parse(metaRaw) as SessionMeta).checksum;
    } catch { return false; }
  }

  /** Tüm verileri temizle (test / logout) */
  clearAll(): void { this._storage.clearAll(); }

  dispose(): void { /* MMKV global — no-op */ }
}
