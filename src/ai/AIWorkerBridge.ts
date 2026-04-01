/**
 * ai/AIWorkerBridge.ts — Main thread Worker yöneticisi
 *
 * T-P9-1 KAPANDI
 *
 * DÜZELTME #2 — Error listener dispose edilemiyor, sonsuz restart riski:
 *   ❌ worker.addEventListener("error", () => { ...restart... })
 *      Anonim fonksiyon → referansı yok → removeEventListener bulamaz.
 *      dispose() sonrası da error gelirse restart tetiklenir → sonsuz döngü.
 *
 *   ✅ _offlineErrorHandler / _cloudErrorHandler instance alanı olarak saklanır.
 *      dispose() → removeEventListener(handler) → restart engellenir.
 *      Restart sınırı: MAX_RESTARTS (3) → sonrasında error log, artık restart yok.
 *
 * § 5  : Model variant → worker routing
 */

import type { IWorkerPort }          from "./AIWorkerClient";
import type { IAIWorkerRuntime }     from "./IAIWorkerRuntime";
import type { AIModelId }            from "./AIModels";
import { AI_MODELS, AIModelVariant } from "./AIModels";

// ─── WorkerLike ───────────────────────────────────────────────────────────────

export interface WorkerLike {
  postMessage(msg: unknown): void;
  addEventListener(type: "message" | "error", handler: (e: Event) => void): void;
  removeEventListener(type: "message" | "error", handler: (e: Event) => void): void;
  terminate(): void;
}

export interface IWorkerFactory {
  createOfflineWorker(): WorkerLike;
  createCloudWorker():   WorkerLike;
}

// ─── Mock factory ─────────────────────────────────────────────────────────────

export function createMockWorkerFactory(
  offlineRuntime: IAIWorkerRuntime,
  cloudRuntime:   IAIWorkerRuntime,
): IWorkerFactory {
   
  const { AIWorker } = require("./AIWorker") as typeof import("./AIWorker");

  function makeInProcess(runtime: IAIWorkerRuntime): WorkerLike {
    const msgListeners: Array<(e: Event) => void> = [];
    const errListeners: Array<(e: Event) => void> = [];

    const worker = new AIWorker(runtime, (msg: unknown) => {
      const snap = [...msgListeners];
      for (const l of snap) try { l({ data: msg } as unknown as Event); } catch { /* ignore */ }
    });

    return {
      postMessage(msg)          { worker.onMessage({ data: msg } as MessageEvent); },
      addEventListener(type, h) { (type === "message" ? msgListeners : errListeners).push(h); },
      removeEventListener(type, h) {
        const list = type === "message" ? msgListeners : errListeners;
        const i = list.indexOf(h); if (i >= 0) list.splice(i, 1);
      },
      terminate() { worker.dispose(); },
    };
  }

  return {
    createOfflineWorker: () => makeInProcess(offlineRuntime),
    createCloudWorker:   () => makeInProcess(cloudRuntime),
  };
}

// ─── NativeWorkerFactory (T-P9-1) ────────────────────────────────────────────

export class NativeWorkerFactory implements IWorkerFactory {
  createOfflineWorker(): WorkerLike { return this._create("offline"); }
  createCloudWorker():   WorkerLike { return this._create("cloud"); }

  private _create(kind: "offline" | "cloud"): WorkerLike {
    if (typeof window !== "undefined" && typeof Worker !== "undefined")
      return this._createWeb(kind);
    if (this._hasExpoWorker())
      return this._createExpo(kind);
    throw new Error(`Worker API mevcut değil. kind=${kind}`);
  }

  private _createWeb(kind: "offline" | "cloud"): WorkerLike {
    const url = kind === "offline"
      ? new URL("../workers/ai.offline.worker", import.meta.url)
      : new URL("../workers/ai.cloud.worker",   import.meta.url);
    const w = new Worker(url, { type: "module" });
    return {
      postMessage: (m) => w.postMessage(m),
      addEventListener:    (t, h) => w.addEventListener(t, h as EventListener),
      removeEventListener: (t, h) => w.removeEventListener(t, h as EventListener),
      terminate: () => w.terminate(),
    };
  }

  private _createExpo(kind: "offline" | "cloud"): WorkerLike {
  // ✅ Dynamic require - bundler static analysis bypassed
  let createWorker: any;
  
  try {
    const workerModule = require("expo-modules-core" + "/workers"); // ✅ Concat bundler'ı aldatmak için
    createWorker = workerModule.createWorker;
  } catch (err) {
    throw new Error(`Failed to load expo-modules-core/workers: ${err}`);
  }
  
  const entry = kind === "offline"
    ? require("../workers/ai.offline.worker")
    : require("../workers/ai.cloud.worker");
  
  const w = createWorker(entry);
  const msgL: Array<(e: Event) => void> = [];
  const errL: Array<(e: Event) => void> = [];
  w.onmessage = (e: MessageEvent) => { const s = [...msgL]; for (const l of s) try { l(e as unknown as Event); } catch { /* ok */ } };
  w.onerror   = (e: ErrorEvent)   => { const s = [...errL]; for (const l of s) try { l(e as unknown as Event); } catch { /* ok */ } };
  
  return {
    postMessage: (m) => w.postMessage(m),
    addEventListener(t, h)    { (t === "message" ? msgL : errL).push(h); },
    removeEventListener(t, h) { const l = t === "message" ? msgL : errL; const i = l.indexOf(h); if (i >= 0) l.splice(i, 1); },
    terminate: () => w.terminate(),
  };
}
 

  private _hasExpoWorker(): boolean {
  // Termux/Bare RN worker desteklenmiyor
  return false;
  }
}

export function createWorkerFactory(
  useMock: boolean,
  offlineRuntime?: IAIWorkerRuntime,
  cloudRuntime?: IAIWorkerRuntime,
): IWorkerFactory {
  if (useMock) {
    if (!offlineRuntime || !cloudRuntime) throw new Error("Mock factory requires runtime instances");
    return createMockWorkerFactory(offlineRuntime, cloudRuntime);
  }
  return new NativeWorkerFactory();
}

// ─── Model variant cache ──────────────────────────────────────────────────────

class ModelVariantCache {
  private readonly _cache = new Map<AIModelId, "offline" | "cloud">();
  isOffline(modelId: AIModelId): boolean {
    let v = this._cache.get(modelId);
    if (v === undefined) {
      v = AI_MODELS.find((m) => m.id === modelId)?.variant === AIModelVariant.OFFLINE
        ? "offline" : "cloud";
      this._cache.set(modelId, v);
    }
    return v === "offline";
  }
}

// ─── AIWorkerBridge ───────────────────────────────────────────────────────────

/** ✅ DÜZELTME #2: Restart sınırı — sonsuz döngü önlenir */
const MAX_RESTARTS = 3;

export class AIWorkerBridge implements IWorkerPort {
  private readonly _factory: IWorkerFactory;
  private _offlineWorker: WorkerLike;
  private _cloudWorker:   WorkerLike;
  private readonly _variantCache = new ModelVariantCache();
  private readonly _listeners:    Array<(e: MessageEvent) => void> = [];
  private readonly _offlineRelay: (e: Event) => void;
  private readonly _cloudRelay:   (e: Event) => void;

  // ✅ DÜZELTME #2: Error handler ref'leri saklanır → dispose'da remove edilebilir
  private _offlineErrorHandler: (e: Event) => void;
  private _cloudErrorHandler:   (e: Event) => void;

  // ✅ DÜZELTME #2: Restart sayacı — MAX_RESTARTS aşılırsa restart durur
  private _offlineRestarts = 0;
  private _cloudRestarts   = 0;

  private _disposed = false;

  constructor(factory: IWorkerFactory) {
    this._factory = factory;

    this._offlineWorker = factory.createOfflineWorker();
    this._cloudWorker   = factory.createCloudWorker();

    this._offlineRelay = (e) => this._relay(e as MessageEvent);
    this._cloudRelay   = (e) => this._relay(e as MessageEvent);

    // ✅ DÜZELTME #2: Named handler — dispose'da removeEventListener çağrılabilir
    this._offlineErrorHandler = () => this._handleWorkerError("offline");
    this._cloudErrorHandler   = () => this._handleWorkerError("cloud");

    this._attachWorker(this._offlineWorker, "offline");
    this._attachWorker(this._cloudWorker,   "cloud");
  }

  private _attachWorker(worker: WorkerLike, kind: "offline" | "cloud"): void {
    const relay   = kind === "offline" ? this._offlineRelay   : this._cloudRelay;
    const errHdlr = kind === "offline" ? this._offlineErrorHandler : this._cloudErrorHandler;
    worker.addEventListener("message", relay);
    // ✅ DÜZELTME #2: named ref ile kayıt
    worker.addEventListener("error",   errHdlr);
  }

  /** ✅ DÜZELTME #2: Restart mantığı — disposed kontrolü + MAX_RESTARTS limiti */
  private _handleWorkerError(kind: "offline" | "cloud"): void {
    if (this._disposed) return; // dispose sonrası restart yok

    const restarts = kind === "offline" ? ++this._offlineRestarts : ++this._cloudRestarts;
    if (restarts > MAX_RESTARTS) {
      console.error(`[AIWorkerBridge] ${kind} worker MAX_RESTARTS (${MAX_RESTARTS}) aşıldı — restart durduruldu.`);
      return;
    }

    const oldWorker = kind === "offline" ? this._offlineWorker : this._cloudWorker;
    const relay     = kind === "offline" ? this._offlineRelay   : this._cloudRelay;
    const errHdlr   = kind === "offline" ? this._offlineErrorHandler : this._cloudErrorHandler;

    // Eski worker'ı temizle
    try { oldWorker.removeEventListener("message", relay);   } catch { /* ignore */ }
    try { oldWorker.removeEventListener("error",   errHdlr); } catch { /* ignore */ }
    try { oldWorker.terminate(); }                             catch { /* ignore */ }

    // Yeni worker oluştur
    const fresh = kind === "offline"
      ? this._factory.createOfflineWorker()
      : this._factory.createCloudWorker();
    this._attachWorker(fresh, kind);

    if (kind === "offline") this._offlineWorker = fresh;
    else                    this._cloudWorker   = fresh;
  }

  private _relay(e: MessageEvent): void {
    if (this._disposed) return;
    const snap = [...this._listeners];
    for (const l of snap) try { l(e); } catch { /* ignore */ }
  }

  postMessage(msg: unknown): void {
    if (this._disposed) return;
    const any = msg as { type?: string; payload?: { model?: AIModelId } };
    if (any.type === "CANCEL") {
      try { this._offlineWorker.postMessage(msg); } catch { /* ignore */ }
      try { this._cloudWorker.postMessage(msg);   } catch { /* ignore */ }
      return;
    }
    if (any.type === "REQUEST") {
      const modelId   = any.payload?.model;
      const isOffline = modelId !== null && modelId !== undefined && this._variantCache.isOffline(modelId);
      try { (isOffline ? this._offlineWorker : this._cloudWorker).postMessage(msg); }
      catch { /* ignore */ }
      return;
    }
    try { this._offlineWorker.postMessage(msg); } catch { /* ignore */ }
    try { this._cloudWorker.postMessage(msg);   } catch { /* ignore */ }
  }

  addEventListener(_type: "message", handler: (e: MessageEvent) => void): void {
    this._listeners.push(handler);
  }

  removeEventListener(_type: "message", handler: (e: MessageEvent) => void): void {
    const i = this._listeners.indexOf(handler);
    if (i >= 0) this._listeners.splice(i, 1);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    // ✅ DÜZELTME #2: Tüm listener'lar (message + error) kaldırılır
    try { this._offlineWorker.removeEventListener("message", this._offlineRelay);        } catch { /* ignore */ }
    try { this._offlineWorker.removeEventListener("error",   this._offlineErrorHandler); } catch { /* ignore */ }
    try { this._cloudWorker.removeEventListener("message",   this._cloudRelay);          } catch { /* ignore */ }
    try { this._cloudWorker.removeEventListener("error",     this._cloudErrorHandler);   } catch { /* ignore */ }
    try { this._offlineWorker.terminate(); } catch { /* ignore */ }
    try { this._cloudWorker.terminate();   } catch { /* ignore */ }

    this._listeners.length = 0;
  }
}
