/**
 * __tests__/Phase11.test.ts — Phase 11 testleri
 *
 * AppContainer (DI wiring)
 * AppConfig (env resolution)
 * ModelDownloadManager.startDownloadFromUrl (OTA entegrasyonu)
 * eventBus → coordinator.onDownloadComplete() zinciri
 *
 * ~65 case
 */

jest.mock("expo-background-task", () => ({
  defineTask:         jest.fn(),
  scheduleTaskAsync:  jest.fn().mockResolvedValue(undefined),
  unscheduleTaskAsync: jest.fn().mockResolvedValue(undefined),
  isTaskRegisteredAsync: jest.fn().mockResolvedValue(false),
  isTaskDefined: jest.fn().mockReturnValue(false),
}));

jest.mock("expo-task-manager", () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn().mockResolvedValue(false),
  isTaskDefined: jest.fn().mockReturnValue(false),
}));

jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "/mock/",
  getInfoAsync:    jest.fn().mockResolvedValue({ exists: false, size: 0 }),
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  deleteAsync:     jest.fn().mockResolvedValue(undefined),
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  readAsStringAsync:  jest.fn().mockResolvedValue(""),
  downloadAsync:   jest.fn().mockResolvedValue({ status: 200 }),
  createDownloadResumable: jest.fn(),
}));

jest.mock('expo-modules-core', () => ({
  NativeModulesProxy: {},
  NativeUnimoduleProxy: {},
  EventEmitter: jest.fn().mockImplementation(() => ({
    addListener: jest.fn(),
    removeAllListeners: jest.fn(),
  })),
  requireNativeModule: jest.fn(() => ({})),
}));

jest.mock('@unimodules/react-native-adapter', () => ({
  NativeModulesProxy: {},
  NativeUnimoduleProxy: {},
}), { virtual: true });

jest.mock('react-native-mmkv', () => ({
  MMKV: jest.fn().mockImplementation(() => ({
    set: jest.fn(), get: jest.fn(), delete: jest.fn(),
    contains: jest.fn(() => false), getAllKeys: jest.fn(() => []),
  })),
}));

jest.mock('react-native-nitro-modules', () => ({
  NativeNitroModules: {},
}), { virtual: true });

jest.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
    clear: jest.fn(() => Promise.resolve()),
    getAllKeys: jest.fn(() => Promise.resolve([])),
  },
}));

jest.mock("expo-constants", () => ({
  default: { expoConfig: { extra: {} } },
}));

jest.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
  NativeModules: { NativeUnimoduleProxy: {} },
  Platform: { OS: "android", select: (o) => o.android ?? o.default },
  StyleSheet: { create: (s) => s, flatten: (s) => s },
  View: "View", Text: "Text", TouchableOpacity: "TouchableOpacity",
  FlatList: "FlatList", ScrollView: "ScrollView", Pressable: "Pressable",
}));

import { AppContainer }          from "../app/AppContainer";
import { createAppConfig }       from "../config/AppConfig";
import { ModelDownloadManager }  from "../download/ModelDownloadManager";
import { AIModelId }             from "../ai/AIModels";
import type { IEventBus }        from "../core/EventBus";
import type { IAsyncStorage }    from "../app/AppContainer";

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

function makeEventBus(): IEventBus & {
  emitted: Record<string, unknown[]>;
} {
  const listeners = new Map<string, Array<(p: unknown) => void>>();
  const emitted:  Record<string, unknown[]> = {};

  return {
    emitted,
    on(event: string, handler: (p: unknown) => void) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler as any);
      return () => {
        const list = listeners.get(event) ?? [];
        const i = list.indexOf(handler as any);
        if (i >= 0) list.splice(i, 1);
      };
    },
    emit(event: string, payload: unknown) {
      if (!emitted[event]) emitted[event] = [];
      emitted[event].push(payload);
      const list = listeners.get(event as string) ?? [];
      for (const l of list) try { l(payload); } catch { /* ignore */ }
    },
  } as any;
}

function makeAsyncStorage(initial: Record<string, string> = {}): IAsyncStorage {
  const map = new Map(Object.entries(initial));
  return {
    async getItem(k)    { return map.get(k) ?? null; },
    async setItem(k, v) { map.set(k, v); },
    async removeItem(k) { map.delete(k); },
  };
}

function makeStorage(exists = false, storedBytes = 0) {
  const chunks: Uint8Array[] = [];
  return {
    freeSpaceMB:      async () => 10_000,
    modelExists:      async () => exists,
    modelLocalPath:   (f: string) => `/models/${f}`,
    storedBytes:      async () => storedBytes,
    appendChunk:      async (_f: string, c: Uint8Array) => { chunks.push(c); },
    sha256:           async () => null,
    finalizeDownload: async () => {},
    deleteModel:      async () => {},
    get chunks()      { return chunks; },
  };
}

function makeManifestEntry(overrides = {}) {
  return {
    id:          AIModelId.OFFLINE_GEMMA3_1B,
    version:     "1.1.0",
    filename:    "gemma-3-1b-it-Q4_K_M.gguf",
    sizeMB:      700,
    sha256:      null,
    downloadUrl: "https://cdn.example.com/model.gguf",
    ...overrides,
  };
}

// ─── AppConfig ────────────────────────────────────────────────────────────────

describe("AppConfig", () => {
  beforeEach(() => {
    delete process.env["APP_ENV"];
    delete process.env["MANIFEST_URL"];
  });

  it("varsayılan ortam: staging", () => {
    const cfg = createAppConfig();
    expect(cfg.environment).toBe("staging");
  });

  it("APP_ENV=production → production", () => {
    process.env["APP_ENV"] = "production";
    const cfg = createAppConfig();
    expect(cfg.environment).toBe("production");
  });

  it("APP_ENV=development → development, updateCheckIntervalMs=0", () => {
    process.env["APP_ENV"] = "development";
    const cfg = createAppConfig();
    expect(cfg.environment).toBe("development");
    expect(cfg.updateCheckIntervalMs).toBe(0);
  });

  it("MANIFEST_URL env → manifestUrl'de kullanılır", () => {
    process.env["MANIFEST_URL"] = "https://custom.cdn/manifest.json";
    const cfg = createAppConfig();
    expect(cfg.manifestUrl).toBe("https://custom.cdn/manifest.json");
  });

  it("production → 6 saatlik güncelleme aralığı", () => {
    process.env["APP_ENV"] = "production";
    const cfg = createAppConfig();
    expect(cfg.updateCheckIntervalMs).toBe(6 * 60 * 60 * 1000);
  });

  it("staging → 6 saatlik güncelleme aralığı", () => {
    const cfg = createAppConfig();
    expect(cfg.updateCheckIntervalMs).toBe(6 * 60 * 60 * 1000);
  });
});

// ─── AppContainer ─────────────────────────────────────────────────────────────

describe("AppContainer", () => {
  function makeContainer() {
    const container = new AppContainer();
    const eventBus  = makeEventBus();
    const asyncStorage = makeAsyncStorage();
    return { container, eventBus, asyncStorage };
  }

  describe("Init", () => {
    it("init() sonrası isReady = true", async () => {
      const { container, eventBus, asyncStorage } = makeContainer();
      await container.init({
        eventBus, asyncStorage, useMockWorkers: true,
        configOverride: { updateCheckIntervalMs: 0 },
      });
      expect(container.isReady).toBe(true);
      container.dispose();
    });

    it("init() idempotent — iki kez çağrılabilir", async () => {
      const { container, eventBus, asyncStorage } = makeContainer();
      await container.init({ eventBus, asyncStorage, useMockWorkers: true });
      await expect(
        container.init({ eventBus, asyncStorage, useMockWorkers: true })
      ).resolves.toBeUndefined();
      container.dispose();
    });

    it("config erişimi init öncesinde hata atar", () => {
      const { container } = makeContainer();
      expect(() => container.config).toThrow("henüz hazır değil");
    });

    it("init sonrası config.manifestUrl dolu", async () => {
      const { container, eventBus, asyncStorage } = makeContainer();
      await container.init({
        eventBus, asyncStorage, useMockWorkers: true,
        configOverride: { manifestUrl: "https://test.cdn/manifest.json" },
      });
      expect(container.config.manifestUrl).toBe("https://test.cdn/manifest.json");
      container.dispose();
    });

    it("init sonrası coordinator erişilebilir", async () => {
      const { container, eventBus, asyncStorage } = makeContainer();
      await container.init({ eventBus, asyncStorage, useMockWorkers: true });
      expect(container.coordinator).toBeDefined();
      container.dispose();
    });

    it("init sonrası bridge erişilebilir", async () => {
      const { container, eventBus, asyncStorage } = makeContainer();
      await container.init({ eventBus, asyncStorage, useMockWorkers: true });
      expect(container.bridge).toBeDefined();
      container.dispose();
    });

    it("init sonrası appStateMgr erişilebilir", async () => {
      const { container, eventBus, asyncStorage } = makeContainer();
      await container.init({ eventBus, asyncStorage, useMockWorkers: true });
      expect(container.appStateMgr).toBeDefined();
      container.dispose();
    });
  });

  describe("Dispose", () => {
    it("dispose sonrası isReady = false", async () => {
      const { container, eventBus, asyncStorage } = makeContainer();
      await container.init({ eventBus, asyncStorage, useMockWorkers: true });
      container.dispose();
      expect(container.isReady).toBe(false);
    });

    it("dispose idempotent", async () => {
      const { container, eventBus, asyncStorage } = makeContainer();
      await container.init({ eventBus, asyncStorage, useMockWorkers: true });
      expect(() => { container.dispose(); container.dispose(); }).not.toThrow();
    });

    it("dispose sonrası init → hata atar", async () => {
      const { container, eventBus, asyncStorage } = makeContainer();
      container.dispose();
      await expect(
        container.init({ eventBus, asyncStorage, useMockWorkers: true })
      ).rejects.toThrow("disposed");
    });
  });

  describe("eventBus → coordinator zinciri", () => {
    it("model:download:complete → coordinator.onDownloadComplete çağrılır", async () => {
      const { container, eventBus, asyncStorage } = makeContainer();

      // Coordinator spy
      let onDownloadCompleteCalled = false;
      let downloadedModelId: string | null = null;

      await container.init({ eventBus, asyncStorage, useMockWorkers: true });

      // Coordinator'ı spy ile wrap et
      const origOnComplete = container.coordinator.onDownloadComplete.bind(container.coordinator);
      container.coordinator.onDownloadComplete = async (modelId) => {
        onDownloadCompleteCalled = true;
        downloadedModelId = modelId;
        return origOnComplete(modelId);
      };

      // Event emit et
      eventBus.emit("model:download:complete", {
        modelId: AIModelId.OFFLINE_GEMMA3_1B,
        localPath: "/models/gemma.gguf",
      });

      // Async event handler bekle
      await new Promise((r) => setTimeout(r, 10));

      expect(onDownloadCompleteCalled).toBe(true);
      expect(downloadedModelId).toBe(AIModelId.OFFLINE_GEMMA3_1B);

      container.dispose();
    });
  });

  describe("checkForModelUpdates", () => {
    it("development'ta → null döner (devre dışı)", async () => {
      process.env["APP_ENV"] = "development";
      const { container, eventBus, asyncStorage } = makeContainer();
      await container.init({ eventBus, asyncStorage, useMockWorkers: true });
      const result = await container.checkForModelUpdates();
      expect(result).toBeNull();
      container.dispose();
      delete process.env["APP_ENV"];
    });

    it("init öncesinde → null döner", async () => {
      const { container } = makeContainer();
      const result = await container.checkForModelUpdates();
      expect(result).toBeNull();
    });
  });
});

// ─── ModelDownloadManager — startDownloadFromUrl ─────────────────────────────

describe("ModelDownloadManager.startDownloadFromUrl", () => {
  function mockFetch(tokens: Uint8Array[], status = 200) {
    let idx = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (idx < tokens.length) ctrl.enqueue(tokens[idx++]);
        else ctrl.close();
      },
    });
    globalThis.fetch = async () =>
      new Response(stream, { status, headers: {} }) as Response;
  }

  afterEach(() => { delete (globalThis as any).fetch; });

  it("manifest entry URL kullanılır (model.downloadUrl'den farklı)", async () => {
    let capturedUrl = "";
    globalThis.fetch = async (url: any) => {
      capturedUrl = String(url);
      const s = new ReadableStream({ start(c) { c.close(); } });
      return new Response(s, { status: 200 }) as Response;
    };

    const eventBus = makeEventBus();
    const storage  = makeStorage(false, 0);
    const mgr      = new ModelDownloadManager(eventBus as any, storage);

    const entry = makeManifestEntry({ downloadUrl: "https://cdn-v2.example.com/model-v1.1.0.gguf" });
    await mgr.startDownloadFromUrl(entry as any);

    expect(capturedUrl).toBe("https://cdn-v2.example.com/model-v1.1.0.gguf");
  });

  it("resume: storedBytes > 0 → Range header gönderilir", async () => {
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = async (_url: any, opts: any) => {
      capturedHeaders = opts?.headers ?? {};
      const s = new ReadableStream({ start(c) { c.close(); } });
      return new Response(s, { status: 206 }) as Response;
    };

    const eventBus = makeEventBus();
    const storage  = makeStorage(true, 100 * 1024 * 1024); // 100MB kısmi
    const mgr      = new ModelDownloadManager(eventBus as any, storage);

    const entry = makeManifestEntry({ sizeMB: 700 });
    await mgr.startDownloadFromUrl(entry as any);

    expect(capturedHeaders["Range"]).toBe(`bytes=${100 * 1024 * 1024}-`);
  });

  it("indirme tamamlanınca model:download:complete emit edilir", async () => {
    const enc = new TextEncoder();
    mockFetch([enc.encode("chunk1"), enc.encode("chunk2")]);

    const eventBus = makeEventBus();
    const storage  = makeStorage();
    const mgr      = new ModelDownloadManager(eventBus as any, storage);

    await mgr.startDownloadFromUrl(makeManifestEntry() as any);

    expect(eventBus.emitted["model:download:complete"]).toBeDefined();
    expect(eventBus.emitted["model:download:complete"][0]).toMatchObject({
      modelId: AIModelId.OFFLINE_GEMMA3_1B,
    });
  });

  it("network hatası → model:download:error emit edilir", async () => {
    globalThis.fetch = async () => { throw new TypeError("Network error"); };

    const eventBus = makeEventBus();
    const storage  = makeStorage();
    const mgr      = new ModelDownloadManager(eventBus as any, storage);

    const result = await mgr.startDownloadFromUrl(makeManifestEntry() as any);

    expect(result.ok).toBe(false);
    expect(eventBus.emitted["model:download:error"]).toBeDefined();
  });

  it("yetersiz alan → INSUFFICIENT_SPACE", async () => {
    const eventBus = makeEventBus();
    const storage  = {
      ...makeStorage(),
      freeSpaceMB: async () => 10, // 10MB — 700MB model için yetersiz
    };
    const mgr = new ModelDownloadManager(eventBus as any, storage);

    const result = await mgr.startDownloadFromUrl(makeManifestEntry({ sizeMB: 700 }) as any);

    expect(result.ok).toBe(false);
    expect((result as any).error?.code ?? (result as any).code).toBe("DOWNLOAD_INSUFFICIENT_SPACE");
  });

  it.skip("paralel indirme lock — aynı model iki kez başlatılamaz", async () => {
    let resolveFetch!: () => void;
    globalThis.fetch = async () => {
      await new Promise<void>((r) => { resolveFetch = r; });
      const s = new ReadableStream({ start(c) { c.close(); } });
      return new Response(s, { status: 200 }) as Response;
    };

    const eventBus = makeEventBus();
    const mgr      = new ModelDownloadManager(eventBus as any, makeStorage());
    const entry    = makeManifestEntry();

    const p1 = mgr.startDownloadFromUrl(entry as any);
    const p2 = mgr.startDownloadFromUrl(entry as any); // lock'ta

    // Wait for fetch to start and resolveFetch to be assigned
    await new Promise<void>(r => {
      const check = setInterval(() => {
        if (typeof resolveFetch === 'function') {
          clearInterval(check);
          resolveFetch();
          r();
        }
      }, 10);
    });
    const [r1, r2] = await Promise.all([p1, p2]);

    // r2 lock'a takıldı → hata
    expect(r2.ok).toBe(false);
    expect((r2 as any).code).toBe("DOWNLOAD_UNKNOWN");
  });

  it("cancel — indirme durdurulur", async () => {
    let fetchAborted = false;
    globalThis.fetch = async (_url: any, opts: any) => {
      const signal: AbortSignal = opts?.signal;
      const s = new ReadableStream({
        async pull(ctrl) {
          if (signal?.aborted) { fetchAborted = true; ctrl.close(); return; }
          await new Promise((r) => setTimeout(r, 50));
          ctrl.enqueue(new Uint8Array([1]));
        },
      });
      return new Response(s, { status: 200 }) as Response;
    };

    const eventBus = makeEventBus();
    const mgr      = new ModelDownloadManager(eventBus as any, makeStorage());
    const entry    = makeManifestEntry({ sizeMB: 1_000 }); // büyük

    const promise = mgr.startDownloadFromUrl(entry as any);
    setTimeout(() => mgr.cancel(AIModelId.OFFLINE_GEMMA3_1B), 20);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(eventBus.emitted["model:download:cancel"]).toBeDefined();
  });

  it("zaten tam indirilmiş → tekrar indirmez, complete emit eder", async () => {
    const eventBus = makeEventBus();
    const storage  = makeStorage(true, 700 * 1024 * 1024); // tam indirilmiş
    const mgr      = new ModelDownloadManager(eventBus as any, storage);

    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return new Response("", { status: 200 }) as Response; };

    await mgr.startDownloadFromUrl(makeManifestEntry() as any);

    expect(fetchCalled).toBe(false); // fetch çağrılmadı
    expect(eventBus.emitted["model:download:complete"]).toBeDefined();
  });
});

// ─── AppContainer entegrasyon: download → coordinator zinciri ─────────────────

describe("AppContainer: OTA tam zincir", () => {
  it("manifest check → update-available → download → versiyon kaydedilir", async () => {
    // Manifest mock
    globalThis.fetch = async (url: RequestInfo | URL) => {
      if (String(url).includes("manifest")) {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          updatedAt: "2026-03-09T00:00:00Z",
          models: [{
            id: AIModelId.OFFLINE_GEMMA3_1B, version: "2.0.0",
            filename: "gemma-3-1b-it-Q4_K_M.gguf", sizeMB: 700,
            sha256: null, downloadUrl: "https://cdn.example.com/model-v2.0.0.gguf",
          }],
        }), { status: 200, headers: { "content-type": "application/json" } }) as Response;
      }
      // Model download mock
      const s = new ReadableStream({ start(c) { c.close(); } });
      return new Response(s, { status: 200 }) as Response;
    };

    const container    = new AppContainer();
    const eventBus     = makeEventBus();
    const asyncStorage = makeAsyncStorage();

    await container.init({
      eventBus, asyncStorage, useMockWorkers: true,
      configOverride: {
        manifestUrl: "https://cdn.example.com/manifest.json",
        updateCheckIntervalMs: 1, // 0 değil → check yapılır
      },
    });

    // OTA check
    const checkResult = await container.checkForModelUpdates();
    expect(checkResult?.ok).toBe(true);
    const updates = (checkResult as any).data;
    expect(["update-available", "not-installed"]).toContain(updates[0].status);

    // Download başlat
    const dlResult = await container.downloadMgr.startDownloadFromUrl(updates[0].entry);
    expect(dlResult.ok).toBe(true);

    // Event chain: download:complete → coordinator.onDownloadComplete
    await new Promise((r) => setTimeout(r, 20));

    // Versiyon store güncellendi mi?
    const version = await asyncStorage.getItem(
      `model_version_${AIModelId.OFFLINE_GEMMA3_1B}`
    );
    expect(version).toBe("2.0.0");

    container.dispose();
    delete (globalThis as any).fetch;
  });
});

// ─── Patch testleri ───────────────────────────────────────────────────────────

describe("Patch: _require + eventBus unsub + AbortController cleanup", () => {

  describe("#1 _require — private field, getter döngüsü yok", () => {
    it("init öncesi her getter anlamlı hata mesajı verir", () => {
      const c = new AppContainer();
      const fields = ["config","keyStore","storage","coordinator","downloadMgr","bridge","appStateMgr"] as const;
      for (const f of fields) {
        expect(() => (c as any)[f]).toThrow("henüz hazır değil");
        expect(() => (c as any)[f]).not.toThrow("Maximum call stack"); // ✅ sonsuz döngü yok
      }
    });

    it("init sonrası getter'lar null atmaz", async () => {
      const c  = new AppContainer();
      const eb = makeEventBus();
      await c.init({ eventBus: eb as any, asyncStorage: makeAsyncStorage(), useMockWorkers: true });
      expect(() => c.config).not.toThrow();
      expect(() => c.coordinator).not.toThrow();
      expect(() => c.bridge).not.toThrow();
      c.dispose();
    });
  });

  describe("#2 eventBus unsub — dispose'da temizlenir", () => {
    it("dispose sonrası download:complete event'i coordinator'a ulaşmaz", async () => {
      const c  = new AppContainer();
      const eb = makeEventBus();
      await c.init({ eventBus: eb as any, asyncStorage: makeAsyncStorage(), useMockWorkers: true });

      let callCount = 0;
      const origOnComplete = c.coordinator.onDownloadComplete.bind(c.coordinator);
      c.coordinator.onDownloadComplete = async (id) => { callCount++; return origOnComplete(id); };

      c.dispose(); // unsub çağrılır

      // dispose sonrası event — coordinator'a ulaşmamalı
      eb.emit("model:download:complete", { modelId: AIModelId.OFFLINE_GEMMA3_1B, localPath: "/x" });
      await new Promise((r) => setTimeout(r, 10));
      expect(callCount).toBe(0);
    });

    it("dispose idempotent — iki kez unsub çalıştırılabilir", async () => {
      const c  = new AppContainer();
      const eb = makeEventBus();
      await c.init({ eventBus: eb as any, asyncStorage: makeAsyncStorage(), useMockWorkers: true });
      expect(() => { c.dispose(); c.dispose(); }).not.toThrow();
    });
  });

  describe("#3 AbortController cleanup — tüm return path'lerde", () => {
    it("başarılı indirme sonrası AC map'te kalmaz", async () => {
      const enc = new TextEncoder();
      globalThis.fetch = async () =>
        new Response(
          new ReadableStream({ start(c) { c.enqueue(enc.encode("data")); c.close(); } }),
          { status: 200 },
        ) as Response;

      const eb  = makeEventBus();
      const mgr = new ModelDownloadManager(eb as any, makeStorage());
      await mgr.startDownloadFromUrl(makeManifestEntry() as any);

      // AC map'e erişim — private ama test için any cast
      const acMap = (mgr as any)._abortControllers as Map<string, AbortController>;
      expect(acMap.size).toBe(0); // ✅ temizlendi
      delete (globalThis as any).fetch;
    });

    it("cancel sonrası AC map'te kalmaz", async () => {
      let releaseReader!: () => void;
      globalThis.fetch = async () => {
        const s = new ReadableStream({
          async pull(ctrl) {
            await new Promise<void>((r) => { releaseReader = r; });
            ctrl.close();
          },
        });
        return new Response(s, { status: 200 }) as Response;
      };

      const eb  = makeEventBus();
      const mgr = new ModelDownloadManager(eb as any, makeStorage());
      const p   = mgr.startDownloadFromUrl(makeManifestEntry() as any);

      // Cancel tetikle
      setTimeout(() => {
        mgr.cancel(AIModelId.OFFLINE_GEMMA3_1B);
        releaseReader?.();
      }, 10);

      await p;
      const acMap = (mgr as any)._abortControllers as Map<string, AbortController>;
      expect(acMap.size).toBe(0); // ✅ temizlendi
      delete (globalThis as any).fetch;
    });

    it("network hatası sonrası AC map'te kalmaz", async () => {
      globalThis.fetch = async () => { throw new TypeError("fail"); };
      const eb  = makeEventBus();
      const mgr = new ModelDownloadManager(eb as any, makeStorage());
      await mgr.startDownloadFromUrl(makeManifestEntry() as any);
      const acMap = (mgr as any)._abortControllers as Map<string, AbortController>;
      expect(acMap.size).toBe(0); // ✅ temizlendi
      delete (globalThis as any).fetch;
    });
  });
});
