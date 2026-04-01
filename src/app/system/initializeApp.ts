/**
 * @file  app/system/initializeApp.ts
 *
 * Uygulama başlatma orchestrator'ı.
 * AppContainer class'ının yerini aldı — saf fonksiyon, daha test edilebilir.
 */

import AsyncStorage              from "@react-native-async-storage/async-storage";

import { createAppConfig }       from "@/config/AppConfig";
import { createAPIKeyStore }     from "@/security/APIKeyStore";
import { PermissionGate }        from "@/permission/PermissionGate";
import { sentryService }         from "@/monitoring/SentryService";
import { Database }              from "@/storage/Database";
import { getApp }                from "@/index";

import { AIContainer }           from "@/core/ai/AIContainer";
import { StorageContainer }      from "@/core/storage/StorageContainer";
import { DownloadContainer }     from "@/core/download/DownloadContainer";

import type { IEventBus }        from "@/core/EventBus";
import type { AppServices }      from "./AppServices";


// ─── Tipler ──────────────────────────────────────────────────────────────────

export interface InitializeAppOptions {
  eventBus:        IEventBus;
  useMockWorkers?: boolean;
}

// ─── initializeApp ───────────────────────────────────────────────────────────

export async function initializeApp(opts: InitializeAppOptions): Promise<AppServices> {
  const { eventBus, useMockWorkers = false } = opts;

  // 1. Config + KeyStore
  const config   = createAppConfig();
  const keyStore = await createAPIKeyStore();

  // 2. AI + Storage — paralel (birbirine bağımlı değil)
  const ai      = new AIContainer();
  const storage = new StorageContainer();

  await Promise.all([
    ai.init({ keyStore, useMockWorkers }),
    storage.init({
      dbDriver: (() => {
        try { return Database.getInstance().getDriver(); }
        catch { return undefined; }
      })(),
    }),
  ]);

  // 3. Download — storage hazır olduktan sonra (modelStorage bağımlılığı)
  const download = new DownloadContainer();
  await download.init({
    eventBus,
    asyncStorage: AsyncStorage,
    modelStorage: storage.modelStorage,
    config,
  });

  // 4. PermissionGate + Sentry
  const permissionGate = new PermissionGate(eventBus);
  sentryService.setupUnhandledRejection();

  // ─── AppServices ───────────────────────────────────────────────

  return {
    // Temel
    config,
    keyStore,
    permissionGate,
    eventBus,
    sentryService,

    // Canonical
    ai,
    storage,
    download,

    // Legacy compatibility layer
    orchestrator:    ai.orchestrator,
    bridge:          ai.bridge,
    appStateMgr:     ai.appStateMgr,
    chatHistory:     storage.chatHistory,
    downloadMgr:     download.downloadMgr,
    downloadManager: download.downloadManager,
    coordinator:     download.coordinator,
    
    // getApp().services bridge
    projectService:     getApp().services.projectService,
    fileService:        getApp().services.fileService,
    settingsRepository: getApp().services.settingsRepository,
  };
}

// ─── disposeApp ──────────────────────────────────────────────────────────────

export function disposeApp(services: AppServices): void {
  services.download.dispose();
  services.ai.dispose();
  services.storage.dispose();
  services.keyStore.dispose();
}
