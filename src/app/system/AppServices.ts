/**
 * @file  app/system/AppServices.ts
 *
 * Uygulama servis kontratı.
 *
 * initializeApp() bu tipi döndürür.
 * useAppBoot, AppProviders ve screen'ler bu tip üzerinden çalışır.
 */

import type { IAppConfig }           from "@/config/AppConfig";
import type { IAPIKeyStoreExtended } from "@/security/APIKeyStore";
import type { IPermissionGate }      from "@/permission/PermissionGate";
import type { IEventBus }            from "@/core/EventBus";
import type { SentryService }        from "@/monitoring/SentryService";

import type { AIContainer }          from "@/core/ai/AIContainer";
import type { StorageContainer }     from "@/core/storage/StorageContainer";
import type { DownloadContainer }    from "@/core/download/DownloadContainer";

// Alt container'lardan gelen tipler — legacy proxy için
import type { AIOrchestrator }       from "@/ai/orchestration/AIOrchestrator";
import type { ChatHistoryRepository } from "@/storage/chat/ChatHistoryRepository";
import type { ModelDownloadManager } from "@/download/ModelDownloadManager";
import type { ModelUpdateCoordinator } from "@/ota/ModelVersionManifest";
import type { AppStateManager }      from "@/lifecycle/AppStateManager";
import type { AIWorkerBridge }       from "@/ai/AIWorkerBridge";

import type { IProjectService }     from "@/core/Service/ProjectService";
import type { IFileService }        from "@/core/Service/FileService";
import type { ISettingsRepository } from "@/storage/repositories/SettingsRepository";

// ─── AppServices ─────────────────────────────────────────────────────────────

export interface AppServices {
  // Temel
  config:         IAppConfig;
  keyStore:       IAPIKeyStoreExtended;
  permissionGate: IPermissionGate;
  eventBus:       IEventBus;
  sentryService:  SentryService;

  // Canonical — container'lara tam erişim
  ai:       AIContainer;
  storage:  StorageContainer;
  download: DownloadContainer;

  // Legacy compatibility layer — screen'ler dokunulmadan çalışır
  // Zamanla screen'ler canonical yola taşındıkça bu satırlar silinir
  orchestrator:  AIOrchestrator;
  bridge:        AIWorkerBridge;
  appStateMgr:   AppStateManager;
  chatHistory:   ChatHistoryRepository;
  downloadMgr:   ModelDownloadManager;
  downloadManager: ModelDownloadManager;
  coordinator:   ModelUpdateCoordinator;

// getApp().services bridge
  projectService:     IProjectService;
  fileService:        IFileService;
  settingsRepository: ISettingsRepository;
}
