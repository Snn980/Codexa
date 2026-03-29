// src/storage/chat/ChatHistoryRepository.ts
// § 37 — Chat history persist
//
// Expo Go uyumu: MMKV yerine in-memory store + AsyncStorage flush
// Native build'de aynı API korunur, MMKV geri alınabilir.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ok, err, type Result } from '../../core/Result';
import type { ChatMessage } from '../../hooks/useAIChat';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const MAX_MESSAGES_PER_SESSION = 500;
const MAX_BYTES_PER_SESSION    = 512 * 1024;
const MAX_SESSIONS             = 50;

const KEY_SESSION_MESSAGES = (id: string) => `chat:messages:${id}`;
const KEY_SESSION_META     = (id: string) => `chat:meta:${id}`;
const KEY_SESSION_INDEX    = 'chat:session_index';

// ─── FNV-1a checksum ─────────────────────────────────────────────────────────

function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

function estimateBytes(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    bytes += str.charCodeAt(i) > 127 ? 3 : 1;
  }
  return bytes;
}

function safeParseMessages(raw: string | undefined | null): ChatMessage[] {
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
  } catch { return []; }
}

function safeParseIndex(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? (p as string[]) : [];
  } catch { return []; }
}

function clampMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return [];
  const hasSystem = messages[0]?.role === 'system';
  const pinned    = hasSystem ? [messages[0]] : [];
  const rest      = hasSystem ? messages.slice(1) : [...messages];
  let byteTotal   = pinned.reduce((acc, m) => acc + estimateBytes(m.content), 0);
  const byteFiltered: ChatMessage[] = [];
  const byteLimit = MAX_BYTES_PER_SESSION - 4096;
  for (let i = rest.length - 1; i >= 0; i--) {
    const b = estimateBytes(rest[i].content);
    if (byteTotal + b > byteLimit) break;
    byteTotal += b;
    byteFiltered.unshift(rest[i]);
  }
  const countLimit = MAX_MESSAGES_PER_SESSION - pinned.length;
  return [...pinned, ...byteFiltered.slice(-countLimit)];
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

// ─── In-memory store — sync API için ─────────────────────────────────────────

type Store = Map<string, string>;

// ─── ChatHistoryRepository ────────────────────────────────────────────────────
// Sync API korunur (callerlar değişmez).
// Veriler in-memory Map'te tutulur; arka planda AsyncStorage'a flush edilir.

export class ChatHistoryRepository {
  private readonly _store: Store = new Map();
  private readonly _ns: string;
  private _loaded = false;

  constructor(instanceId = 'chat-history') {
    this._ns = `mmkv:${instanceId}:`;
    // Arka planda yükle — ilk sync erişim boş döner, sonraki çağrılarda dolu gelir
    void this._loadFromStorage();
  }

  // ─── AsyncStorage yükle / kaydet ─────────────────────────────────────────

  private _nsKey(key: string): string {
    return `${this._ns}${key}`;
  }

  private async _loadFromStorage(): Promise<void> {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const nsKeys = keys.filter(k => k.startsWith(this._ns));
      if (nsKeys.length === 0) { this._loaded = true; return; }
      const pairs = await AsyncStorage.multiGet(nsKeys);
      for (const [k, v] of pairs) {
        if (v != null) this._store.set(k.slice(this._ns.length), v);
      }
    } catch { /* storage erişim hatası — in-memory devam et */ }
    this._loaded = true;
  }

  private _flush(key: string, value: string): void {
    void AsyncStorage.setItem(this._nsKey(key), value).catch(() => {});
  }

  private _flushDelete(key: string): void {
    void AsyncStorage.removeItem(this._nsKey(key)).catch(() => {});
  }

  // ─── Sync storage helpers ─────────────────────────────────────────────────

  private _getString(key: string): string | undefined {
    return this._store.get(key);
  }

  private _set(key: string, value: string): void {
    this._store.set(key, value);
    this._flush(key, value);
  }

  private _delete(key: string): void {
    this._store.delete(key);
    this._flushDelete(key);
  }

  // ─── Index ────────────────────────────────────────────────────────────────

  private _readIndex(): string[] {
    return safeParseIndex(this._getString(KEY_SESSION_INDEX));
  }

  private _writeIndex(ids: string[]): void {
    this._set(KEY_SESSION_INDEX, JSON.stringify(ids));
  }

  private _enforceLRU(currentIndex: string[]): string[] {
    if (currentIndex.length <= MAX_SESSIONS) return currentIndex;
    const toRemove = currentIndex.slice(MAX_SESSIONS);
    for (const id of toRemove) {
      this._delete(KEY_SESSION_MESSAGES(id));
      this._delete(KEY_SESSION_META(id));
    }
    return currentIndex.slice(0, MAX_SESSIONS);
  }

  // ─── Public API (sync) ────────────────────────────────────────────────────

  listSessions(): Result<readonly SessionMeta[]> {
    try {
      const ids   = this._readIndex();
      const metas: SessionMeta[] = [];
      for (const id of ids) {
        const raw = this._getString(KEY_SESSION_META(id));
        if (!raw) continue;
        try { metas.push(JSON.parse(raw) as SessionMeta); } catch { /* atla */ }
      }
      metas.sort((a, b) => b.updatedAt - a.updatedAt);
      return ok(metas);
    } catch (e) {
      return err('CHAT_LIST_FAILED', 'Failed to list sessions', { cause: e });
    }
  }

  createSession(
    id:       string,
    title:    string,
    messages: readonly ChatMessage[] = [],
  ): Result<SessionMeta> {
    try {
      const now        = Date.now();
      const clamped    = clampMessages(messages);
      const serialized = JSON.stringify(clamped);
      const checksum   = fnv1a32(serialized);
      const preview    = clamped.find((m) => m.role === 'user')?.content.slice(0, 80) ?? '';
      const meta: SessionMeta = {
        id, title: title || preview || 'Yeni Sohbet',
        createdAt: now, updatedAt: now, preview,
        messageCount: clamped.length, checksum,
      };
      this._set(KEY_SESSION_MESSAGES(id), serialized);
      this._set(KEY_SESSION_META(id), JSON.stringify(meta));
      const index    = this._readIndex().filter((x) => x !== id);
      const newIndex = this._enforceLRU([id, ...index]);
      this._writeIndex(newIndex);
      return ok(meta);
    } catch (e) {
      return err('CHAT_CREATE_FAILED', `Failed to create session ${id}`, { cause: e });
    }
  }

  getMessages(sessionId: string): Result<readonly ChatMessage[]> {
    try {
      return ok(safeParseMessages(this._getString(KEY_SESSION_MESSAGES(sessionId))));
    } catch (e) {
      return err('CHAT_READ_FAILED', `Failed to read session ${sessionId}`, { cause: e });
    }
  }

  appendMessages(
    sessionId:   string,
    newMessages: readonly ChatMessage[],
  ): Result<SessionMeta> {
    try {
      const existing   = safeParseMessages(this._getString(KEY_SESSION_MESSAGES(sessionId)));
      const metaRaw    = this._getString(KEY_SESSION_META(sessionId));
      const oldMeta    = metaRaw ? (JSON.parse(metaRaw) as SessionMeta) : null;
      const merged     = clampMessages([...existing, ...newMessages]);
      const serialized = JSON.stringify(merged);
      const checksum   = fnv1a32(serialized);
      if (checksum === oldMeta?.checksum) return ok(oldMeta!);
      const now     = Date.now();
      const preview = merged.find((m) => m.role === 'user')?.content.slice(0, 80) ?? '';
      const newMeta: SessionMeta = {
        id: sessionId,
        title:        oldMeta?.title ?? preview ?? 'Yeni Sohbet',
        createdAt:    oldMeta?.createdAt ?? now,
        updatedAt:    now, preview,
        messageCount: merged.length, checksum,
      };
      this._set(KEY_SESSION_MESSAGES(sessionId), serialized);
      this._set(KEY_SESSION_META(sessionId), JSON.stringify(newMeta));
      const index    = this._readIndex().filter((x) => x !== sessionId);
      const newIndex = this._enforceLRU([sessionId, ...index]);
      this._writeIndex(newIndex);
      return ok(newMeta);
    } catch (e) {
      return err('CHAT_APPEND_FAILED', `Failed to append to session ${sessionId}`, { cause: e });
    }
  }

  updateTitle(sessionId: string, title: string): Result<void> {
    try {
      const raw = this._getString(KEY_SESSION_META(sessionId));
      if (!raw) return err('CHAT_NOT_FOUND', `Session not found: ${sessionId}`);
      const meta: SessionMeta = JSON.parse(raw);
      this._set(KEY_SESSION_META(sessionId), JSON.stringify({ ...meta, title, updatedAt: Date.now() }));
      return ok(undefined);
    } catch (e) {
      return err('CHAT_UPDATE_FAILED', `Failed to update title for ${sessionId}`, { cause: e });
    }
  }

  deleteSession(sessionId: string): Result<void> {
    try {
      this._delete(KEY_SESSION_MESSAGES(sessionId));
      this._delete(KEY_SESSION_META(sessionId));
      this._writeIndex(this._readIndex().filter((id) => id !== sessionId));
      return ok(undefined);
    } catch (e) {
      return err('CHAT_DELETE_FAILED', `Failed to delete session ${sessionId}`, { cause: e });
    }
  }

  verifyIntegrity(sessionId: string): boolean {
    try {
      const raw     = this._getString(KEY_SESSION_MESSAGES(sessionId));
      const metaRaw = this._getString(KEY_SESSION_META(sessionId));
      if (!raw || !metaRaw) return false;
      return fnv1a32(raw) === (JSON.parse(metaRaw) as SessionMeta).checksum;
    } catch { return false; }
  }

  clearAll(): void {
    const ids = this._readIndex();
    for (const id of ids) {
      this._delete(KEY_SESSION_MESSAGES(id));
      this._delete(KEY_SESSION_META(id));
    }
    this._delete(KEY_SESSION_INDEX);
  }

  dispose(): void { /* no-op */ }
}
