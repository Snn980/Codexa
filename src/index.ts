/**
 * @file     index.ts
 * @module   src
 * @version  1.0.0
 * @since    Phase 1 — Foundation
 *
 * @description
 *   Composition root — tüm bağımlılıkları tek noktada bağlar.
 *   Public API barrel  — dış katmanlar yalnızca bu dosyadan import yapar;
 *   iç modül yollarına doğrudan erişim kapatılır.
 *
 * Sorumluluklar:
 *   1. AppContainer  — bağımlılık ağacını kurar, yaşam döngüsünü yönetir
 *   2. Re-export     — tip, yardımcı ve servis katmanı public yüzeyi
 *   3. UUID factory  — platform-agnostic UUID üretimi (Hermes / Node.js)
 *   4. Singleton     — getApp() / resetApp() (test izolasyonu destekli)
 *
 * Initialization akışı:
 *   getApp().initialize(config?)
 *     → Database.connect()         — driver + pragma + migration
 *     → Repository'ler             — driver + createUUID enjeksiyonu
 *     → SettingsRepository.get()   — autoSaveInterval için gerçek değer
 *     → Service'ler                — repo + eventBus + autoSaveInterval
 *     → state = "ready"
 *
 * Tasarım kararları:
 *   • Service katmanı concrete repo alır (optimistic lock versiyonu için);
 *     IProjectRepository / IFileRepository yüzeyi Phase 2'de genişleyebilir.
 *   • FileService.autoSaveIntervalMs initialize sırasında DB'den okunur;
 *     settings değiştiğinde "settings:changed" eventi dinlenerek güncellenir.
 *   • dispose() → FileService.dispose() → Database.disconnect() sırası garantilidir.
 *   • getApp() Singleton DEĞİL — modul-level instance; test ortamında resetApp() ile temizlenir.
 *
 * @example — Uygulama başlatma (React Native entry point)
 *   import { getApp } from "@/index";
 *
 *   const result = await getApp().initialize();
 *   if (!result.ok) {
 *     Alert.alert("Başlatma hatası", result.error.message);
 *     return;
 *   }
 *   const { projectService, fileService } = getApp().services;
 *
 * @example — Test izolasyonu
 *   import { createApp, resetApp } from "@/index";
 *
 *   let app: AppContainer;
 *   beforeEach(async () => {
 *     app = createApp();
 *     await app.initialize({}, mockDriver);
 *   });
 *   afterEach(async () => {
 *     await app.dispose();
 *     resetApp();
 *   });
 */

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Public Tip Re-exports
// ─────────────────────────────────────────────────────────────────────────────

export type {
  // Tip yardımcıları
  Values,
  DeepReadonly,
  RequireFields,
  UUID,
  Timestamp,
  MetaRecord,

  // Hata sistemi
  AppError,
  Result,
  AsyncResult,

  // Proje modeli
  ProjectMeta,
  IProject,
  CreateProjectDto,
  UpdateProjectDto,

  // Dosya modeli
  IFile,
  CreateFileDto,
  UpdateFileDto,

  // Ayarlar modeli
  ISettings,

  // AI modeli
  AIMessage,
  IAISession,
  AIRateLimitPolicy,

  // Editör modeli
  CursorPosition,
  ITab,

  // Olay sistemi
  AppEventMap,
  EventListener,
  IEventBus,

  // Repository kontratları
  IRepository,
  IProjectRepository,
  IFileRepository,

  // Validasyon
  IValidator,
  ValidationResult,
  ValidationError,
} from "./types/core";

export {
  // Sabitler & enum'lar
  ErrorCode,
  ProjectLanguage,
  ProjectStatus,
  PROJECT_STATUS_TRANSITIONS,
  PROJECT_CONSTRAINTS,
  FileType,
  FILE_EXTENSION_MAP,
  FILE_CONSTRAINTS,
  EditorTheme,
  KeyboardLayout,
  DEFAULT_SETTINGS,
  AIProvider,
  AIPermissionState,
  DEFAULT_AI_RATE_LIMIT,
} from "./types/core";

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Public Yardımcı Re-exports
// ─────────────────────────────────────────────────────────────────────────────

export {
  ok,
  err,
  errFrom,
  isOk,
  isErr,
  mapResult,
  mapError,
  chainResult,
  getOrElse,
  unwrap,
  mapResultAsync,
  chainResultAsync,
  collectResults,
  collectResultsAsync,
  tryResult,
  tryResultAsync,
} from "./utils/result";

// ─────────────────────────────────────────────────────────────────────────────
// § 3. Public Storage Re-exports
// ─────────────────────────────────────────────────────────────────────────────

export type { DatabaseConfig, IDatabaseDriver, ITransaction, QueryResult, ExecuteResult } from "./storage/Database";
export { Database, DEFAULT_DATABASE_CONFIG }                                               from "./storage/Database";

export type { ISettingsRepository } from "./storage/repositories/SettingsRepository";
export { SettingsRepository }       from "./storage/repositories/SettingsRepository";

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Public Servis Re-exports
// ─────────────────────────────────────────────────────────────────────────────

export type { IProjectService } from "./core/Service/ProjectService";
export { ProjectService }       from "./core/Service/ProjectService";

export type { IFileService } from "./core/Service/FileService";
export { FileService }       from "./core/Service/FileService";

export {
  EventBus,
  getAppEventBus,
  createEventBus,
  resetAppEventBus,
} from "./core/EventBus";

// ─────────────────────────────────────────────────────────────────────────────
// § 5. UUID Factory
// ─────────────────────────────────────────────────────────────────────────────

import type { UUID } from "./types/core";

/**
 * Platform-agnostic UUID v4 üretici.
 *
 * Öncelik sırası:
 *   1. globalThis.crypto.randomUUID()  — Hermes ≥ 0.71, Node.js ≥ 19, modern tarayıcılar
 *   2. expo-crypto.randomUUID()        — Expo SDK ortamı (lazy import)
 *   3. Manuel RFC 4122 v4              — CI / eski ortam son çare
 *
 * Neden lazy import?
 *   expo-crypto opsiyonel bağımlılık; web veya Node.js test ortamında bulunmayabilir.
 *   İlk iki yol başarılıysa üçüncüye hiç ulaşılmaz.
 */
function buildUUIDFactory(): () => UUID {
  // 1. Web Crypto API — Hermes / Node.js / tarayıcı
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID === "function"
  ) {
    const { randomUUID } = (globalThis as { crypto: { randomUUID: () => string } }).crypto;
    return () => randomUUID() as UUID;
  }

  // 2. expo-crypto — Expo SDK (synchronous, native module)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Crypto = require("expo-crypto") as { randomUUID(): string };
    if (typeof Crypto.randomUUID === "function") {
      return () => Crypto.randomUUID() as UUID;
    }
  } catch {
    // expo-crypto kurulu değil — bir sonraki yola geç
  }

  // 3. Manuel RFC 4122 v4 — son çare (CI / test / eski ortam)
  return (): UUID => {
    const hex = "0123456789abcdef";
    let uuid   = "";

    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) {
        uuid += "-";
      } else if (i === 14) {
        uuid += "4";               // version bits
      } else if (i === 19) {
        uuid += hex[(Math.random() * 4 + 8) | 0]; // variant bits: 8–b
      } else {
        uuid += hex[(Math.random() * 16) | 0];
      }
    }

    return uuid as UUID;
  };
}

/** Modül yüklenirken bir kez seçilir; tekrar seçim olmaz. */
const createUUID: () => UUID = buildUUIDFactory();

// ─────────────────────────────────────────────────────────────────────────────
// § 6. AppServices — Servis kümesi tipi
// ─────────────────────────────────────────────────────────────────────────────

import type { IProjectService } from "./core/Service/ProjectService";
import type { IFileService }    from "./core/Service/FileService";
import type { IEventBus }       from "./types/core";
import type { ISettingsRepository } from "./storage/repositories/SettingsRepository";

export interface AppServices {
  readonly projectService:    IProjectService;
  readonly fileService:       IFileService;
  readonly settingsRepository: ISettingsRepository;
  readonly eventBus:          IEventBus;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 7. AppContainer
// ─────────────────────────────────────────────────────────────────────────────

import { Database, DEFAULT_DATABASE_CONFIG } from "./storage/Database";
import type { DatabaseConfig, IDatabaseDriver } from "./storage/Database";
import { ProjectRepository }  from "./storage/repositories/ProjectRepository";
import { FileRepository }     from "./storage/repositories/FileRepository";
import { SettingsRepository } from "./storage/repositories/SettingsRepository";
import { ProjectService }     from "./core/Service/ProjectService";
import { FileService }        from "./core/Service/FileService";
import { EventBus }           from "./core/EventBus";
import type { AsyncResult }   from "./types/core";
import { DEFAULT_SETTINGS }   from "./types/core";
import { err, ok }            from "./utils/result";
import { ErrorCode }          from "./types/core";

// Not: const enum Babel/Metro ile uyumsuz; regular enum kullanılır.
enum ContainerState {
  Idle         = "idle",
  Initializing = "initializing",
  Ready        = "ready",
  Disposing    = "disposing",
  Disposed     = "disposed",
  Failed       = "failed",
}

/**
 * Uygulama bağımlılık kapsayıcısı.
 * Tüm repository ve service instance'larını yönetir.
 *
 * Kullanım:
 *   const app = getApp();
 *   await app.initialize();
 *   const { projectService } = app.services;
 *   // ...
 *   await app.dispose();
 */
export class AppContainer {
  private state:    ContainerState = ContainerState.Idle;
  private _services: AppServices | null = null;

  // ── Initialization ─────────────────────────────────────────────

  /**
   * Veritabanını bağlar, repository ve service katmanlarını kurar.
   *
   * @param config   — DB konfigürasyon override'ları (varsayılan: DEFAULT_DATABASE_CONFIG)
   * @param driver   — Test enjeksiyonu için mock driver (opsiyonel)
   *
   * @example
   *   // Üretim
   *   await getApp().initialize();
   *
   *   // Test
   *   await app.initialize({}, mockDriver);
   */
  async initialize(
    config?: Partial<DatabaseConfig>,
    driver?: IDatabaseDriver,
  ): AsyncResult<void> {
    if (this.state === ContainerState.Ready)        return ok(undefined);
    if (this.state === ContainerState.Initializing) {
      return err(ErrorCode.DB_CONNECTION_FAILED, "initialize() zaten çalışıyor");
    }
    if (this.state === ContainerState.Disposed) {
      return err(ErrorCode.DB_CONNECTION_FAILED, "Dispose edilmiş container yeniden başlatılamaz");
    }

    this.state = ContainerState.Initializing;

    // ── 1. Veritabanı bağlantısı ────────────────────────────────
    const db = Database.getInstance();
    const connectResult = await db.connect(config, driver);
    if (!connectResult.ok) {
      this.state = ContainerState.Failed;
      return connectResult;
    }

    const dbDriver = db.getDriver();

    // ── 2. EventBus ─────────────────────────────────────────────
    const eventBus = new EventBus();

    // ── 3. Repository katmanı ───────────────────────────────────
    const projectRepo  = new ProjectRepository(dbDriver, createUUID);
    const fileRepo     = new FileRepository(dbDriver, createUUID);
    const settingsRepo = new SettingsRepository(dbDriver);

    // ── 4. autoSaveInterval — DB'den gerçek değeri oku ──────────
    //    Başarısız olursa DEFAULT_SETTINGS fallback; kritik değil.
    let autoSaveIntervalMs = DEFAULT_SETTINGS.autoSaveInterval;
    const settingsResult = await settingsRepo.get();
    if (settingsResult.ok) {
      autoSaveIntervalMs = settingsResult.data.autoSaveInterval;
    }

    // ── 5. Service katmanı ──────────────────────────────────────
    const projectService = new ProjectService(projectRepo, eventBus);
    const fileService    = new FileService(fileRepo, eventBus, autoSaveIntervalMs);

    // ── 6. "settings:changed" — autoSaveInterval reaktif güncelleme ─
    //    Kullanıcı ayarları değiştirdiğinde FileService yeniden oluşturulmaz;
    //    fileService içindeki interval referansı setter ile güncellenir.
    //    FileService şu an constructor-only interval alıyor;
    //    Phase 2'de setAutoSaveInterval() metodu eklenecek.
    //    Şimdilik: mevcut fileService instance'ını dispose edip yenisini oluştur.
    eventBus.on("settings:changed", (next: any) => {
      if (next.autoSaveInterval !== autoSaveIntervalMs) {
        autoSaveIntervalMs = next.autoSaveInterval;
        // FileService'i yeniden oluştur — dispose + recreate
        // Not: Bu yaklaşım pending save'leri kaybeder.
        // Phase 2'de setAutoSaveInterval(ms) ile yerinde güncelleme yapılacak.
        fileService.dispose();
        const newFileService = new FileService(fileRepo, eventBus, next.autoSaveInterval);

        // Services nesnesini güncelle — readonly olduğu için yeni nesne üret
        this._services = Object.freeze({
          ...this._services!,
          fileService: newFileService,
        });
      }
    });

    // ── 7. Services frozen snapshot ─────────────────────────────
    this._services = Object.freeze({
      projectService,
      fileService,
      settingsRepository: settingsRepo,
      eventBus,
    });

    this.state = ContainerState.Ready;
    return ok(undefined);
  }

  // ── Servis Erişimi ─────────────────────────────────────────────

  /**
   * Başlatılmış servis kümesini döner.
   * initialize() çağrılmadan erişilirse throw fırlatır.
   *
   * @throws Error — initialize() henüz çağrılmamışsa
   */
  get services(): AppServices {
    if (this.state !== ContainerState.Ready || !this._services) {
      throw new Error(
        `[AppContainer] services erişimi başarısız: durum="${this.state}". initialize() önce çağrılmalı.`,
      );
    }
    return this._services;
  }

  /** Container'ın hazır olup olmadığını döner. */
  get isReady(): boolean {
    return this.state === ContainerState.Ready;
  }

  /** Mevcut yaşam döngüsü durumunu döner (diagnostik). */
  get currentState(): string {
    return this.state;
  }

  // ── Dispose ────────────────────────────────────────────────────

  /**
   * Tüm kaynakları serbest bırakır.
   *
   * Sıra garantisi:
   *   1. FileService.dispose()   — bekleyen auto-save timer'ları iptal et
   *   2. EventBus.removeAll()    — listener sızıntısı olmadan kapat
   *   3. Database.disconnect()   — WAL checkpoint + bağlantı kapat
   *
   * @example
   *   // React Native AppState → background
   *   AppState.addEventListener("change", async (state) => {
   *     if (state === "background") await getApp().dispose();
   *   });
   */
  async dispose(): AsyncResult<void> {
    if (this.state === ContainerState.Disposed) return ok(undefined);
    if (this.state !== ContainerState.Ready) {
      return err(
        ErrorCode.DB_CONNECTION_FAILED,
        `Kapatılamaz: durum="${this.state}"`,
      );
    }

    this.state = ContainerState.Disposing;

    // 1. FileService — timer'ları iptal et
    if (this._services) {
      // FileService concrete tip değil IFileService; dispose() IFileService kontratında.
      (this._services.fileService as FileService).dispose();
      // EventBus
      (this._services.eventBus as EventBus).removeAllListeners();
    }

    // 2. Database bağlantısını kapat
    const disconnectResult = await Database.getInstance().disconnect();
    if (!disconnectResult.ok) {
      this.state = ContainerState.Failed;
      return disconnectResult;
    }

    this._services = null;
    this.state     = ContainerState.Disposed;
    return ok(undefined);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 8. Module-level Singleton
// ─────────────────────────────────────────────────────────────────────────────

let appInstance: AppContainer | null = null;

/**
 * Uygulama geneli AppContainer instance'ını döner.
 * İlk çağrıda oluşturulur; sonraki çağrılarda aynı instance döner.
 *
 * @example
 *   const result = await getApp().initialize();
 *   const { projectService } = getApp().services;
 */
export function getApp(): AppContainer {
  if (!appInstance) appInstance = new AppContainer();
  return appInstance;
}

/**
 * Yeni bir AppContainer oluşturur — test izolasyonu için.
 * Her test suite bağımsız container ile çalışır.
 *
 * @example
 *   beforeEach(() => { app = createApp(); });
 */
export function createApp(): AppContainer {
  return new AppContainer();
}

/**
 * Module-level singleton'ı sıfırlar.
 * YALNIZCA test teardown veya hot-reload senaryolarında kullanılır.
 *
 * @example
 *   afterEach(async () => {
 *     await app.dispose();
 *     resetApp();
 *     Database.resetInstance();
 *   });
 */
export function resetApp(): void {
  appInstance = null;
}
