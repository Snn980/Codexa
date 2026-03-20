/**
 * app/AppContainer.ts — Uygulama DI kapsayıcısı
 *
 * DÜZELTME #1 — _require() yanlış field kontrolü:
 *   ❌ private _require<K extends keyof this>(field: K)
 *      this[field] → getter'ı çağırır → getter _require'ı çağırır → sonsuz döngü.
 *
 *   ✅ private _require<T>(value: T | null, name: string): T
 *      Private field değeri doğrudan parametre olarak geçirilir.
 *      Getter'lar: return this._require(this._config, "config")
 *
 * DÜZELTME #2 — EventBus memory leak:
 *   ❌ eventBus.on(...) dönüş değeri saklanmıyordu → dispose'da unsubscribe yok.
 *
 *   ✅ _unsubs: Array<() => void> — tüm unsub fonksiyonları toplanır.
 *      dispose() → _unsubs içindeki her birini çağırır.
 *
 * § 4  : AppContainer DI — singleton, idempotent init, ordered dispose
 */

import { createAppConfig }           from "../config/AppConfig";
import type { IAppConfig }           from "../config/AppConfig";
import { createAPIKeyStore }         from "../security/APIKeyStore";
import type { IAPIKeyStoreExtended } from "../security/APIKeyStore";
import { AIRuntimeManager }          from "../ai/AIRuntimeFactory";
import { AIWorkerBridge }            from "../ai/AIWorkerBridge";
import { AppStateManager }           from "../lifecycle/AppStateManager";
import {
  ModelVersionStore,
  ModelUpdateCoordinator,
}                                    from "../ota/ModelVersionManifest";
import { ModelDownloadManager }      from "../download/ModelDownloadManager";
import { ChatHistoryRepository }    from "../storage/chat/ChatHistoryRepository";
import {
  registerBackgroundDownloadTask,
  scheduleBackgroundDownload,
}                                    from "../background/BackgroundModelDownload";
import {
  registerIOSProcessingTask,
  scheduleIOSProcessingTask,
}                                    from "../background/iOSBGProcessingTask";
import { AIOrchestrator }           from "../ai/orchestration/AIOrchestrator";
import { AIWorkerClient }           from "../ai/AIWorkerClient";
import { generateId }               from "../utils/uuid";
import type { UUID }                from "../core/Types";
import { sentryService, SentryService } from "../monitoring/SentryService";
import type { IStorageInfo }         from "../download/ModelDownloadManager";
import type { IEventBus }            from "../core/EventBus";
import type { IPermissionGate }      from "../permission/PermissionGate";
import type { IDatabaseDriver }      from "../storage/Database";
import { createChatStorageMigrator } from "../storage/chat/ChatStorageMigrator";
import { SQLiteChatRepository }      from "../storage/chat/SQLiteChatRepository";
import { createModelStorage }        from "../storage/StorageFactory";
import { AIModelId }                 from "../ai/AIModels";

// ─── AsyncStorage arayüzü ─────────────────────────────────────────────────────

export interface IAsyncStorage {
  getItem(key: string):              Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string):           Promise<void>;
}

// ─── AppContainerOptions ─────────────────────────────────────────────────────

export interface AppContainerOptions {
  eventBus:        IEventBus;
  asyncStorage:    IAsyncStorage;
  /** § 37.3 — SQLite driver (index.ts'ten inject): migrasyon için gerekli */
  dbDriver?:       IDatabaseDriver;
  useMockWorkers?: boolean;
  configOverride?: Partial<IAppConfig>;
}

// ─── Container state ─────────────────────────────────────────────────────────

type ContainerState =
  | { status: "idle" }
  | { status: "initializing"; promise: Promise<void> }
  | { status: "ready" }
  | { status: "disposed" };

// ─── AppContainer ─────────────────────────────────────────────────────────────

export class AppContainer {
  private _state: ContainerState = { status: "idle" };

  // Private fields
  private _config:        IAppConfig             | null = null;
  private _keyStore:      IAPIKeyStoreExtended   | null = null;
  private _storage:       IStorageInfo           | null = null;
  private _versionStore:  ModelVersionStore      | null = null;
  private _coordinator:   ModelUpdateCoordinator | null = null;
  private _downloadMgr:   ModelDownloadManager   | null = null;
  private _runtimeMgr:    AIRuntimeManager       | null = null;
  private _bridge:        AIWorkerBridge         | null = null;
  private _appStateMgr:   AppStateManager        | null = null;
  private _chatHistory:   ChatHistoryRepository  | null = null;
  private _sqliteChat:    SQLiteChatRepository   | null = null;
  private _orchestrator:  AIOrchestrator         | null = null;

  // ✅ DÜZELTME #2: unsub fonksiyonları burada toplanır
  private readonly _unsubs: Array<() => void> = [];

  // eventBus + permissionGate — init'te set edilir, public getter ile açılır
  private _eventBus:       IEventBus              | null = null;
  private _permissionGate: IPermissionGate        | null = null;

  // ─── Getters — ✅ DÜZELTME #1: _require(value, name) pattern ────────────

  get config():      IAppConfig             { return this._require(this._config,      "config"); }
  get keyStore():    IAPIKeyStoreExtended   { return this._require(this._keyStore,    "keyStore"); }
  get storage():     IStorageInfo           { return this._require(this._storage,     "storage"); }
  get coordinator(): ModelUpdateCoordinator { return this._require(this._coordinator, "coordinator"); }
  get downloadMgr(): ModelDownloadManager  { return this._require(this._downloadMgr, "downloadMgr"); }
  get bridge():      AIWorkerBridge        { return this._require(this._bridge,       "bridge"); }
  get appStateMgr(): AppStateManager       { return this._require(this._appStateMgr, "appStateMgr"); }
  get chatHistory(): ChatHistoryRepository { return this._require(this._chatHistory, "chatHistory"); }

  /**
   * § 50 — AIOrchestrator: lazy init, bridge hazır olduktan sonra kullanılabilir.
   * İlk erişimde AIWorkerClient oluşturulur; sonraki erişimlerde cached.
   */
  get orchestrator(): AIOrchestrator {
    if (!this._orchestrator) {
      const client = new AIWorkerClient(this.bridge, generateId as () => UUID);
      this._orchestrator = new AIOrchestrator(client);
    }
    return this._orchestrator;
  }
  get eventBus():      IEventBus             { return this._require(this._eventBus,       "eventBus"); }
  get permissionGate(): IPermissionGate      { return this._require(this._permissionGate, "permissionGate"); }

  /**
   * § 63 — SentryService public getter.
   * AIChatScreenV2, AIPanelScreen, ModelsScreen tarafından kullanılır.
   * module-level singleton'ı container üzerinden erişilebilir kılar.
   */
  get sentryService(): SentryService { return sentryService; }

  /**
   * § 61 — downloadManager alias (canonical: downloadMgr).
   * ModelsScreen ve diğer screen'ler bu isimle erişir.
   */
  get downloadManager(): ModelDownloadManager { return this._require(this._downloadMgr, "downloadMgr"); }

  // ─── Init ─────────────────────────────────────────────────────────────────

  async init(opts: AppContainerOptions): Promise<void> {
    if (this._state.status === "ready")        return;
    if (this._state.status === "disposed")     throw new Error("AppContainer disposed");
    if (this._state.status === "initializing") return this._state.promise;

    const promise = this._doInit(opts);
    this._state = { status: "initializing", promise };
    return promise;
  }

  private async _doInit(opts: AppContainerOptions): Promise<void> {
    const { eventBus, asyncStorage, useMockWorkers = false, configOverride } = opts;
    this._eventBus = eventBus;

    // 1. AppConfig
    this._config = { ...createAppConfig(), ...configOverride };

    // 2. KeyStore
    this._keyStore = await createAPIKeyStore();

    // 3. Storage
    this._storage = await createModelStorage();

    // 4. ModelVersionStore
    this._versionStore = new ModelVersionStore(asyncStorage);

    // 5. ModelUpdateCoordinator
    this._coordinator = new ModelUpdateCoordinator({
      manifestUrl:  this._config.manifestUrl,
      storage:      this._storage!,
      versionStore: this._versionStore,
    });

    // 6. ModelDownloadManager + eventBus subscriptions
    this._downloadMgr = new ModelDownloadManager(eventBus, this._storage!);

    // ✅ DÜZELTME #2: unsub kaydedilir
    this._unsubs.push(
      eventBus.on("model:download:complete", async ({ modelId }) => {
        await this._coordinator?.onDownloadComplete(modelId);
      }),
    );

    // 7. AIRuntimeManager + Bridge
    this._runtimeMgr = new AIRuntimeManager();
    const runtimeResult = await this._runtimeMgr.init({
      offlineModelId: AIModelId.OFFLINE_GEMMA3_1B,
      keyStore:       this._keyStore!,
      useMock:        useMockWorkers,
    });
    if (!runtimeResult.ok) {
      throw new Error(`AIRuntimeManager init failed: ${(runtimeResult as any).message}`);
    }
    this._bridge = this._runtimeMgr.bridge;

    // 7b. ChatHistoryRepository — MMKV (§ 37, senkron, init gerekmez)
    this._chatHistory = new ChatHistoryRepository();

    // 7b2. § 37.3 (T-P15-6) — SQLite migrasyon eşik kontrolü
    //      dbDriver varsa (index.ts inject eder) + eşik aşıldıysa → migrate
    if (opts.dbDriver) {
      this._sqliteChat = new SQLiteChatRepository(opts.dbDriver);
      const migrator   = createChatStorageMigrator(opts.dbDriver);
      migrator.shouldMigrate().then(async (needed) => {
        if (!needed) return;
        if (__DEV__) console.log('[AppContainer] Chat storage migration: MMKV → SQLite başlıyor');
        const report = await migrator.migrate();
        if (report.ok && __DEV__) {
          console.log('[AppContainer] Chat migration tamamlandı:', {
            sessions: report.value.sessionsMigrated,
            messages: report.value.messagesMigrated,
            duration: `${report.value.durationMs}ms`,
          });
        }
      }).catch((e: unknown) => {
        // Migrasyon hatası kritik değil — MMKV çalışmaya devam eder
        console.warn('[AppContainer] Chat storage migration failed:', e);
      });
    }

    // 7d. Sentry — unhandled promise rejection (§ 32, T-P15-4)
    sentryService.setupUnhandledRejection();

    // 7c. Background download tasks (§ 36, T-P15-5)
    registerBackgroundDownloadTask();        // BackgroundFetch (her platform)
    registerIOSProcessingTask();             // BGProcessingTask (iOS-only, no-op diğerlerinde)

    if (this._config.enableBackgroundDownload) {
      scheduleBackgroundDownload().catch((e: unknown) => {
        console.warn('[AppContainer] scheduleBackgroundDownload failed:', e);
      });
      scheduleIOSProcessingTask().catch((e: unknown) => {
        if (__DEV__) console.warn('[AppContainer] scheduleIOSProcessingTask failed:', e);
      });
    }

    // 8. AppStateManager — en son (bridge hazır)
    this._appStateMgr = new AppStateManager({
      keyStore: this._keyStore,
      bridge:   this._bridge,
    });
    this._appStateMgr.start();

    this._state = { status: "ready" };
  }

  // ─── OTA güncelleme kontrolü ──────────────────────────────────────────────

  async checkForModelUpdates() {
    if (this._state.status !== "ready")         return null;
    if (this._config!.updateCheckIntervalMs === 0) return null;
    return this._coordinator!.check();
  }

  // ─── Dispose ──────────────────────────────────────────────────────────────

  dispose(): void {
    if (this._state.status === "disposed") return;
    this._state = { status: "disposed" };

    // ✅ DÜZELTME #2: tüm eventBus subscription'ları temizlenir
    for (const unsub of this._unsubs) try { unsub(); } catch { /* ignore */ }
    this._unsubs.length = 0;

    // Tersine sıra
    this._appStateMgr?.dispose();
    this._runtimeMgr?.dispose();
    this._keyStore?.dispose();

    this._appStateMgr  = null;
    this._chatHistory  = null;
    this._sqliteChat   = null;
    this._orchestrator = null;
    this._runtimeMgr   = null;
    this._bridge       = null;
    this._coordinator  = null;
    this._downloadMgr  = null;
    this._storage      = null;
    this._keyStore     = null;
    this._versionStore = null;
    this._config       = null;
  }

  // ─── ✅ DÜZELTME #1: _require — private field değerini parametre alır ─────

  /**
   * ❌ ESKİ: _require<K extends keyof this>(field: K)
   *    this[field] → getter → _require → getter → sonsuz döngü
   *
   * ✅ YENİ: _require<T>(value: T | null, name: string): T
   *    Getter'lar private field'ı doğrudan geçirir — getter çağrılmaz.
   */
  private _require<T>(value: T | null, name: string): T {
    if (value == null) {
      throw new Error(
        `AppContainer: '${name}' henüz hazır değil. init() çağrıldı mı?`,
      );
    }
    return value;
  }

  get isReady(): boolean { return this._state.status === "ready"; }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const appContainer = new AppContainer();
