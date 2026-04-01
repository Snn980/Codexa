/**
 * @file  core/storage/StorageContainer.ts
 *
 * Storage katmanı — model depolama, chat repository'leri, migrasyon.
 * Framework bağımsız: sadece storage servislerini başlatır.
 */

import { ChatHistoryRepository }     from "@/storage/chat/ChatHistoryRepository";
import { createChatStorageMigrator } from "@/storage/chat/ChatStorageMigrator";
import { SQLiteChatRepository }      from "@/storage/chat/SQLiteChatRepository";
import { createModelStorage }        from "@/storage/StorageFactory";
import type { IStorageInfo }         from "@/download/ModelDownloadManager";
import type { IDatabaseDriver }      from "@/storage/Database";

export interface StorageContainerOptions {
  dbDriver?: IDatabaseDriver;
}

export class StorageContainer {
  private _modelStorage: IStorageInfo          | null = null;
  private _chatHistory:  ChatHistoryRepository | null = null;
  private _sqliteChat:   SQLiteChatRepository  | null = null;

  get modelStorage(): IStorageInfo          { return this._require(this._modelStorage, "modelStorage"); }
  get chatHistory():  ChatHistoryRepository { return this._require(this._chatHistory,  "chatHistory"); }

  /** null olabilir — dbDriver inject edilmediyse SQLite kullanılamaz. */
  get sqliteChat(): SQLiteChatRepository | null { return this._sqliteChat; }

  async init(opts: StorageContainerOptions = {}): Promise<void> {
    this._modelStorage = await createModelStorage();
    this._chatHistory  = new ChatHistoryRepository();

    if (opts.dbDriver) {
      this._sqliteChat = new SQLiteChatRepository(opts.dbDriver);
      this._runMigration(opts.dbDriver);
    }
  }

  dispose(): void {
    this._sqliteChat   = null;
    this._chatHistory  = null;
    this._modelStorage = null;
  }

  /** Migrasyon kritik değil — hata olursa MMKV çalışmaya devam eder. */
  private _runMigration(dbDriver: IDatabaseDriver): void {
    const migrator = createChatStorageMigrator(dbDriver);

    migrator.shouldMigrate().then(async (needed) => {
      if (!needed) return;
      if (__DEV__) console.log("[StorageContainer] Chat migration: MMKV → SQLite başlıyor");

      const report = await migrator.migrate();
      if (report.ok && __DEV__) {
        console.log("[StorageContainer] Migration tamamlandı:", {
          sessions: report.data.sessionsMigrated,
          messages: report.data.messagesMigrated,
          duration: `${report.data.durationMs}ms`,
        });
      }
    }).catch((e: unknown) => {
      console.warn("[StorageContainer] Migration failed:", e);
    });
  }

  private _require<T>(value: T | null, name: string): T {
    if (value === null) throw new Error(`StorageContainer: '${name}' henüz hazır değil.`);
    return value;
  }
}
