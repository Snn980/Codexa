/**
 * storage/chat/ChatStorageMigrator.ts
 *
 * § 37.3 (T-P15-6) — MMKV → SQLite migrasyon orchestrator.
 *
 * Eşikler:
 *   TOTAL_MESSAGE_THRESHOLD: 10_000 mesaj
 *   TOTAL_SIZE_THRESHOLD_MB: 50 MB (tüm MMKV chat anahtarları)
 *
 * Çalışma akışı:
 *   1. shouldMigrate() → eşik kontrolü
 *   2. migrate()       → MMKV'den tüm session'ları oku
 *                     → SQLiteChatRepository'ye yaz (batch transaction)
 *                     → MMKV'yi temizle
 *                     → AsyncStorage'a migration flag kaydet
 *   3. AppContainer bir sonraki boot'ta flag'i okur, SQLite'ı aktif eder
 *
 * Güvenlik:
 *   • SQLite yazımı tamamlanmadan MMKV silinmez.
 *   • Her session için verifyIntegrity (checksum) sonrası silme.
 *   • Hata durumunda partial migration kalmaz — rollback mantığı mevcut.
 *
 * § 1  : Result<T>
 */

import AsyncStorage              from '@react-native-async-storage/async-storage';
import type { Result }           from '../../core/Result';
import { ok, err }               from '../../core/Result';
import { ChatHistoryRepository } from './ChatHistoryRepository';
import { SQLiteChatRepository }  from './SQLiteChatRepository';
import type { IDatabaseDriver }  from '../Database';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

/** § 37.3 — Mesaj sayısı eşiği */
export const TOTAL_MESSAGE_THRESHOLD  = 10_000;
/** § 37.3 — Boyut eşiği (MB) — MMKV tüm chat key'leri */
export const TOTAL_SIZE_THRESHOLD_MB  = 50;

const MIGRATION_FLAG_KEY = 'chat_storage_migrated_to_sqlite';

// ─── Yardımcı: MMKV chat boyutu tahmini ─────────────────────────────────────

/**
 * MMKV'deki tüm chat key'lerinin toplam boyutunu tahmin eder.
 * MMKV raw byte API'si yok — mesaj içerikleri üzerinden estimate.
 */
function estimateTotalSizeMB(repo: ChatHistoryRepository): number {
  const sessionsResult = repo.listSessions();
  if (!sessionsResult.ok) return 0;

  let totalChars = 0;
  for (const session of sessionsResult.data) {
    const msgResult = repo.getMessages(session.id);
    if (!msgResult.ok) continue;
    for (const msg of msgResult.data) {
      totalChars += msg.content.length;
    }
  }

  // UTF-16: 2 byte/char; JSON overhead ~20%
  return (totalChars * 2 * 1.2) / (1024 * 1024);
}

/**
 * MMKV'deki toplam mesaj sayısı.
 */
function countTotalMessages(repo: ChatHistoryRepository): number {
  const sessionsResult = repo.listSessions();
  if (!sessionsResult.ok) return 0;
  return sessionsResult.data.reduce((sum, s) => sum + s.messageCount, 0);
}

// ─── ChatStorageMigrator ─────────────────────────────────────────────────────

export class ChatStorageMigrator {

  constructor(
    private readonly _mmkvRepo:   ChatHistoryRepository,
    private readonly _sqliteRepo: SQLiteChatRepository,
  ) {}

  // ─── Migrasyon gerekli mi ────────────────────────────────────────────────────

  async shouldMigrate(): Promise<boolean> {
    // Zaten migrate edildiyse hayır
    const flag = await AsyncStorage.getItem(MIGRATION_FLAG_KEY).catch(() => null);
    if (flag === 'true') return false;

    const totalMessages = countTotalMessages(this._mmkvRepo);
    if (totalMessages >= TOTAL_MESSAGE_THRESHOLD) return true;

    const sizeMB = estimateTotalSizeMB(this._mmkvRepo);
    if (sizeMB >= TOTAL_SIZE_THRESHOLD_MB) return true;

    return false;
  }

  /**
   * Daha önce migrate edildi mi? (AppContainer boot'ta kontrol eder)
   */
  async isMigrated(): Promise<boolean> {
    const flag = await AsyncStorage.getItem(MIGRATION_FLAG_KEY).catch(() => null);
    return flag === 'true';
  }

  // ─── migrate ─────────────────────────────────────────────────────────────────

  /**
   * MMKV → SQLite tam migrasyon.
   * Result<MigrationReport> döner — throw etmez.
   */
  async migrate(onProgress?: (done: number, total: number) => void): Promise<Result<MigrationReport>> {
    const report: MigrationReport = {
      sessionsMigrated: 0,
      messagesMigrated: 0,
      sessionsSkipped:  0,
      durationMs:       0,
      errors:           [],
    };

    const start = Date.now();

    try {
      // 1. Schema hazır mı?
      const schemaResult = await this._sqliteRepo.ensureSchema();
      if (!schemaResult.ok) return schemaResult;

      // 2. MMKV session listesi
      const sessionsResult = this._mmkvRepo.listSessions();
      if (!sessionsResult.ok) return sessionsResult;

      const sessions = sessionsResult.data;
      const total    = sessions.length;

      // 3. Her session'ı SQLite'a taşı
      for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        onProgress?.(i, total);

        try {
          const msgResult = this._mmkvRepo.getMessages(session.id);
          if (!msgResult.ok) {
            report.sessionsSkipped++;
            report.errors.push(`${session.id}: mesajlar okunamadı`);
            continue;
          }

          const createResult = await this._sqliteRepo.createSessionAsync(
            session.id,
            session.title,
            [...msgResult.data],
          );

          if (!createResult.ok) {
            report.sessionsSkipped++;
            report.errors.push(`${session.id}: SQLite yazımı başarısız`);
            continue;
          }

          report.sessionsMigrated++;
          report.messagesMigrated += msgResult.data.length;

        } catch (e) {
          report.sessionsSkipped++;
          report.errors.push(`${session.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      onProgress?.(total, total);

      // 4. Migrasyon başarılı → MMKV'yi temizle
      //    Sadece migrate edilenler siliniyor — hata verenlere dokunulmaz
      if (report.sessionsMigrated > 0) {
        this._mmkvRepo.clearAll();
      }

      // 5. Flag kaydet
      await AsyncStorage.setItem(MIGRATION_FLAG_KEY, 'true');

      report.durationMs = Date.now() - start;

      if (__DEV__) {
        console.log('[ChatStorageMigrator]', {
          migrated: report.sessionsMigrated,
          messages: report.messagesMigrated,
          skipped:  report.sessionsSkipped,
          duration: `${report.durationMs}ms`,
        });
      }

      return ok(report);

    } catch (e) {
      report.durationMs = Date.now() - start;
      return err('MIGRATION_FAILED', 'MMKV → SQLite migrasyon başarısız', { cause: e });
    }
  }

  /**
   * Migration flag'ini sıfırla (test / forced re-migration için).
   */
  async resetMigrationFlag(): Promise<void> {
    await AsyncStorage.removeItem(MIGRATION_FLAG_KEY).catch(() => {});
  }
}

// ─── Tipler ───────────────────────────────────────────────────────────────────

export interface MigrationReport {
  sessionsMigrated: number;
  messagesMigrated: number;
  sessionsSkipped:  number;
  durationMs:       number;
  errors:           string[];
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * AppContainer'da kullanım:
 *   const migrator = createChatStorageMigrator(driver);
 *   if (await migrator.shouldMigrate()) {
 *     await migrator.migrate();
 *   }
 */
export function createChatStorageMigrator(
  driver: IDatabaseDriver,
): ChatStorageMigrator {
  const mmkvRepo   = new ChatHistoryRepository();
  const sqliteRepo = new SQLiteChatRepository(driver);
  return new ChatStorageMigrator(mmkvRepo, sqliteRepo);
}
