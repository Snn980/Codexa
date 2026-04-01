/**
 * @file  core/download/DownloadContainer.ts
 *
 * Download katmanı — model indirme, OTA güncelleme, background tasks.
 * Framework bağımsız: sadece download servislerini başlatır.
 */

import {
  ModelVersionStore,
  ModelUpdateCoordinator,
}                               from "@/ota/ModelVersionManifest";
import { ModelDownloadManager } from "@/download/ModelDownloadManager";
import {
  registerBackgroundDownloadTask,
  scheduleBackgroundDownload,
}                               from "@/background/BackgroundModelDownload";
import {
  registerIOSProcessingTask,
  scheduleIOSProcessingTask,
}                               from "@/background/iOSBGProcessingTask";
import type { IStorageInfo }    from "@/download/ModelDownloadManager";
import type { IEventBus }       from "@/core/EventBus";
import type { IAppConfig }      from "@/config/AppConfig";
import type { AIModelId }       from "@/ai/AIModels";

export interface IAsyncStorage {
  getItem(key: string):                Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string):             Promise<void>;
}

export interface DownloadContainerOptions {
  eventBus:     IEventBus;
  asyncStorage: IAsyncStorage;
  modelStorage: IStorageInfo;
  config:       IAppConfig;
}

export class DownloadContainer {
  private _downloadMgr:  ModelDownloadManager   | null = null;
  private _versionStore: ModelVersionStore      | null = null;
  private _coordinator:  ModelUpdateCoordinator | null = null;

  private readonly _unsubs: Array<() => void> = [];

  get downloadMgr():     ModelDownloadManager   { return this._require(this._downloadMgr,  "downloadMgr"); }
  get downloadManager(): ModelDownloadManager   { return this.downloadMgr; }
  get coordinator():     ModelUpdateCoordinator { return this._require(this._coordinator,   "coordinator"); }

  async init(opts: DownloadContainerOptions): Promise<void> {
    const { eventBus, asyncStorage, modelStorage, config } = opts;

    // OTA
    this._versionStore = new ModelVersionStore(asyncStorage);
    this._coordinator  = new ModelUpdateCoordinator({
      manifestUrl:  config.manifestUrl,
      storage:      modelStorage,
      versionStore: this._versionStore,
    });

    // Download manager + OTA bağlantısı
    this._downloadMgr = new ModelDownloadManager(eventBus, modelStorage);
    this._unsubs.push(
      eventBus.on("model:download:complete", async ({ modelId }: { modelId: string; localPath: string }) => {
        await this._coordinator?.onDownloadComplete(modelId as AIModelId);
      }),
    );

    // Background tasks
    registerBackgroundDownloadTask();
    registerIOSProcessingTask();

    if (config.enableBackgroundDownload) {
      scheduleBackgroundDownload().catch((e: unknown) => {
        console.warn("[DownloadContainer] scheduleBackgroundDownload failed:", e);
      });
      scheduleIOSProcessingTask().catch((e: unknown) => {
        if (__DEV__) console.warn("[DownloadContainer] scheduleIOSProcessingTask failed:", e);
      });
    }
  }

  async checkForModelUpdates(config: IAppConfig) {
    if (!this._coordinator)                 return null;
    if (config.updateCheckIntervalMs === 0) return null;
    return this._coordinator.check();
  }

  dispose(): void {
    for (const unsub of this._unsubs) try { unsub(); } catch { /* ignore */ }
    this._unsubs.length = 0;

    this._downloadMgr  = null;
    this._coordinator  = null;
    this._versionStore = null;
  }

  private _require<T>(value: T | null, name: string): T {
    if (value === null) throw new Error(`DownloadContainer: '${name}' henüz hazır değil.`);
    return value;
  }
}
