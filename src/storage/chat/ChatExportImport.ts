/**
 * storage/chat/ChatExportImport.ts
 *
 * § 37 (T-P15-2) — Chat geçmişi dışa/içe aktarma.
 *
 * Export formatı (v1):
 * {
 *   version:    1,
 *   exportedAt: number,          // Unix ms
 *   appVersion: string,          // Expo config'den
 *   sessions: [{
 *     meta:     SessionMeta,
 *     messages: ChatMessage[]
 *   }]
 * }
 *
 * Tasarım kararları:
 *   • Export: ChatHistoryRepository'den tüm session'ları okur, JSON string üretir.
 *     Caller (hook/screen) paylaşım mekanizmasını seçer (Share API, dosya).
 *   • Import: Schema validation → duplicate çözümü → repository'ye yaz.
 *     Duplicate strategy: 'skip' | 'overwrite' | 'rename'
 *   • Validation katmanları: JSON parse → version check → field type check → message integrity.
 *   • MAX_IMPORT_SESSIONS: 50 (MAX_SESSIONS ile aynı, aşan session'lar kırpılır).
 *   • MAX_IMPORT_FILE_BYTES: 10MB — büyük dosyalar reddedilir.
 *
 * § 1  : Result<T> — tüm public metodlar throw etmez
 */

import type { Result }           from '../../core/Result';
import { ok, err }               from '../../core/Result';
import type { ChatMessage }      from '../../hooks/useAIChat';
import type { SessionMeta }      from './ChatHistoryRepository';
import { ChatHistoryRepository } from './ChatHistoryRepository';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const EXPORT_VERSION       = 1;
const MAX_IMPORT_SESSIONS  = 50;
const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

// ─── Tipler ───────────────────────────────────────────────────────────────────

export interface ExportedSession {
  meta:     SessionMeta;
  messages: ChatMessage[];
}

export interface ChatExportPayload {
  version:    number;
  exportedAt: number;
  appVersion: string;
  sessions:   ExportedSession[];
}

export type DuplicateStrategy = 'skip' | 'overwrite' | 'rename';

export interface ImportOptions {
  /** Mevcut session ile çakışma durumunda ne yapılsın */
  onDuplicate: DuplicateStrategy;
}

export interface ImportSummary {
  imported:  number;
  skipped:   number;
  overwritten: number;
  renamed:   number;
  errors:    string[];
}

// ─── Validation ───────────────────────────────────────────────────────────────

function isValidMessage(m: unknown): m is ChatMessage {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.id        === 'string' &&
    typeof o.role      === 'string' &&
    ['user', 'assistant', 'system'].includes(o.role as string) &&
    typeof o.content   === 'string' &&
    typeof o.timestamp === 'number'
  );
}

function isValidSessionMeta(m: unknown): m is SessionMeta {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.id           === 'string' && o.id.length > 0 &&
    typeof o.title        === 'string' &&
    typeof o.createdAt    === 'number' &&
    typeof o.updatedAt    === 'number' &&
    typeof o.preview      === 'string' &&
    typeof o.messageCount === 'number' &&
    typeof o.checksum     === 'number'
  );
}

function validatePayload(raw: unknown): Result<ChatExportPayload> {
  if (!raw || typeof raw !== 'object') {
    return err('IMPORT_INVALID_FORMAT', 'Root must be an object');
  }

  const o = raw as Record<string, unknown>;

  if (o.version !== EXPORT_VERSION) {
    return err('IMPORT_VERSION_MISMATCH', `Expected version ${EXPORT_VERSION}, got ${o.version}`);
  }
  if (typeof o.exportedAt !== 'number') {
    return err('IMPORT_INVALID_FORMAT', 'Missing exportedAt');
  }
  if (!Array.isArray(o.sessions)) {
    return err('IMPORT_INVALID_FORMAT', 'sessions must be an array');
  }

  for (let i = 0; i < o.sessions.length; i++) {
    const s = o.sessions[i] as Record<string, unknown>;
    if (!isValidSessionMeta(s.meta)) {
      return err('IMPORT_INVALID_SESSION', `Session[${i}].meta is invalid`);
    }
    if (!Array.isArray(s.messages)) {
      return err('IMPORT_INVALID_SESSION', `Session[${i}].messages is not an array`);
    }
    // messages validation — sadece geçerli mesajları koru (strict değil)
  }

  return ok(raw as ChatExportPayload);
}

// ─── ChatExportImport ─────────────────────────────────────────────────────────

export class ChatExportImport {

  constructor(private readonly _repo: ChatHistoryRepository) {}

  // ─── Export ──────────────────────────────────────────────────────────────────

  /**
   * Tüm session'ları JSON string olarak export et.
   * Caller Share API ile kullanıcıya sunar.
   */
  async exportAll(appVersion = '1.0.0'): Promise<Result<string>> {
    try {
      const sessionsResult = this._repo.listSessions();
      if (!sessionsResult.ok) return sessionsResult;

      const sessions = sessionsResult.value;
      const exported: ExportedSession[] = [];

      for (const meta of sessions) {
        const msgResult = this._repo.getMessages(meta.id);
        const messages  = msgResult.ok
          ? [...msgResult.value]
          : [];

        exported.push({ meta, messages });
      }

      const payload: ChatExportPayload = {
        version:    EXPORT_VERSION,
        exportedAt: Date.now(),
        appVersion,
        sessions:   exported,
      };

      return ok(JSON.stringify(payload, null, 2));
    } catch (e) {
      return err('EXPORT_FAILED', 'Export failed', { cause: e });
    }
  }

  /**
   * Tek session'ı export et.
   */
  async exportSession(sessionId: string, appVersion = '1.0.0'): Promise<Result<string>> {
    try {
      const sessionsResult = this._repo.listSessions();
      if (!sessionsResult.ok) return sessionsResult;

      const meta = sessionsResult.value.find(s => s.id === sessionId);
      if (!meta) return err('EXPORT_NOT_FOUND', `Session not found: ${sessionId}`);

      const msgResult = this._repo.getMessages(sessionId);
      const messages  = msgResult.ok ? [...msgResult.value] : [];

      const payload: ChatExportPayload = {
        version:    EXPORT_VERSION,
        exportedAt: Date.now(),
        appVersion,
        sessions:   [{ meta, messages }],
      };

      return ok(JSON.stringify(payload, null, 2));
    } catch (e) {
      return err('EXPORT_FAILED', 'Single session export failed', { cause: e });
    }
  }

  // ─── Import ──────────────────────────────────────────────────────────────────

  /**
   * JSON string'den session'ları içe aktar.
   * @param jsonString  Kullanıcının paylaştığı export dosyası
   * @param options     Duplicate çözüm stratejisi
   */
  async importFrom(
    jsonString: string,
    options:    ImportOptions = { onDuplicate: 'skip' },
  ): Promise<Result<ImportSummary>> {
    try {
      // ── Boyut kontrolü
      const byteSize = jsonString.length * 2; // UTF-16 worst case
      if (byteSize > MAX_IMPORT_FILE_BYTES) {
        return err('IMPORT_TOO_LARGE', `File too large: ${Math.round(byteSize / 1024)}KB`);
      }

      // ── JSON parse
      let raw: unknown;
      try {
        raw = JSON.parse(jsonString);
      } catch {
        return err('IMPORT_PARSE_ERROR', 'Invalid JSON');
      }

      // ── Schema validation
      const validationResult = validatePayload(raw);
      if (!validationResult.ok) return validationResult;

      const payload  = validationResult.value;
      const sessions = payload.sessions.slice(0, MAX_IMPORT_SESSIONS);

      // ── Mevcut session ID'leri
      const existingResult = this._repo.listSessions();
      const existingIds    = new Set(
        existingResult.ok ? existingResult.value.map(s => s.id) : [],
      );

      const summary: ImportSummary = {
        imported:    0,
        skipped:     0,
        overwritten: 0,
        renamed:     0,
        errors:      [],
      };

      for (const { meta, messages } of sessions) {
        try {
          const validMessages = messages.filter(isValidMessage);
          const isDuplicate   = existingIds.has(meta.id);

          if (isDuplicate) {
            if (options.onDuplicate === 'skip') {
              summary.skipped++;
              continue;
            }
            if (options.onDuplicate === 'overwrite') {
              this._repo.deleteSession(meta.id);
              this._repo.createSession(meta.id, meta.title, validMessages);
              summary.overwritten++;
              continue;
            }
            if (options.onDuplicate === 'rename') {
              // Yeni ID + "(içe aktarıldı)" suffix
              const newId    = `${meta.id}_imported_${Date.now()}`;
              const newTitle = `${meta.title} (içe aktarıldı)`;
              this._repo.createSession(newId, newTitle, validMessages);
              summary.renamed++;
              continue;
            }
          }

          this._repo.createSession(meta.id, meta.title, validMessages);
          existingIds.add(meta.id);
          summary.imported++;

        } catch (e) {
          summary.errors.push(`Session ${meta.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return ok(summary);

    } catch (e) {
      return err('IMPORT_FAILED', 'Import failed', { cause: e });
    }
  }
}
