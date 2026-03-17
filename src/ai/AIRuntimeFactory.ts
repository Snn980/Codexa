/**
 * ai/AIRuntimeFactory.ts — AppContainer AI runtime fabrikası
 *
 * § 4  : AppContainer DI pattern
 * § 1  : Result<T>
 *
 * Platform'a ve permission seviyesine göre doğru runtime'ları oluşturur:
 *
 *   createOfflineRuntime(modelId)
 *     └─ ExpoLlamaCppLoader (T-NEW-1) + ChatTemplate (T-NEW-2)
 *          └─ OfflineRuntime → AIWorker (offline worker thread)
 *
 *   createCloudRuntime(keyStore)
 *     └─ APIKeyStore (Keychain)
 *          └─ CloudRuntime → AIWorker (cloud worker thread)
 *
 *   createAIWorkerBridge(offlineRuntime, cloudRuntime)
 *     └─ AIWorkerBridge (IWorkerPort)
 *          └─ AIWorkerClient (useAIChat)
 *
 * Lifecycle:
 *   AppContainer.init() → AIRuntimeFactory.create() → bridge singleton
 *   AppContainer.dispose() → bridge.dispose() → worker.dispose() → runtime.dispose()
 */

import type { IAIWorkerRuntime }    from "./IAIWorkerRuntime";
import type { ILlamaCppLoader }     from "./OfflineRuntime";
import { OfflineRuntime }           from "./OfflineRuntime";
import { CloudRuntime }             from "./CloudRuntime";
import { AIWorkerBridge, createMockWorkerFactory } from "./AIWorkerBridge";
import type { AIModelId }           from "./AIModels";
import type { IAPIKeyStoreExtended } from "../security/APIKeyStore";
import type { Result }              from "../core/Result";
import { ok, err }                  from "../core/Result";

// ─── WASM asset URI ───────────────────────────────────────────────────────────

/**
 * llama.wasm asset'inin Metro URI'si.
 * Uygulama bundle'ında `assets/llama.wasm` olarak yer alır.
 * llama.rn native — WASM asset kopyalama gerekmez.
 * Model dosyaları (GGUF) expo-file-system ile indirilir/yönetilir.
 */
const LLAMA_WASM_ASSET_URI = "../../assets/llama.wasm";

// ─── Fabrika fonksiyonları ────────────────────────────────────────────────────

/**
 * Offline runtime oluştur.
 * modelId: hangi GGUF modeli için loader hazırlanacak.
 */
export async function createOfflineRuntime(
  modelId: AIModelId,
): Promise<Result<IAIWorkerRuntime>> {
  try {
    let loader: ILlamaCppLoader;

    if (isNativeOrWeb()) {
      // Gerçek WASM loader (T-NEW-1)
      const { ExpoLlamaCppLoader } = await import("./LlamaCppWasm");
      loader = new ExpoLlamaCppLoader(LLAMA_WASM_ASSET_URI, modelId);
    } else {
      // Test ortamı
      const { MockLlamaCppLoader } = await import("./OfflineRuntime");
      loader = new MockLlamaCppLoader();
    }

    return ok(new OfflineRuntime(loader));
  } catch (e) {
    return err("RUNTIME_WASM_INIT_FAILED", String(e));
  }
}

/**
 * Cloud runtime oluştur.
 */
export function createCloudRuntime(keyStore: IAPIKeyStoreExtended): IAIWorkerRuntime {
  return new CloudRuntime(keyStore);
}

/**
 * AIWorkerBridge oluştur — her iki runtime inject edilir.
 * AppContainer bunu singleton olarak tutar.
 */
export async function createAIWorkerBridge(opts: {
  offlineModelId: AIModelId;
  keyStore: IAPIKeyStoreExtended;
  useMock?: boolean;
}): Promise<Result<AIWorkerBridge>> {
  const { offlineModelId, keyStore, useMock = false } = opts;

  const offlineResult = await createOfflineRuntime(offlineModelId);
  if (!offlineResult.ok) return offlineResult as unknown as Result<AIWorkerBridge>;

  const cloudRuntime = createCloudRuntime(keyStore);

  if (useMock) {
    // Test: in-process factory
    const factory = createMockWorkerFactory(offlineResult.data, cloudRuntime);
    return ok(new AIWorkerBridge(factory));
  }

  // Production: gerçek Worker thread factory
  const factory = createNativeWorkerFactory(offlineResult.data, cloudRuntime);
  return ok(new AIWorkerBridge(factory));
}

// ─── Native Worker factory ────────────────────────────────────────────────────

/**
 * Gerçek Worker thread'leri oluşturur.
 * Expo: `new Worker(new URL("./ai.offline.worker", import.meta.url))`
 *
 * Her worker thread kendi runtime instance'ına sahiptir.
 * Bridge, main thread'de çalışır ve mesajları yönlendirir.
 *
 * NOT: Worker thread dosyaları (`ai.offline.worker.ts`, `ai.cloud.worker.ts`)
 * ayrı bundle entry point olarak Metro'ya tanıtılmalı.
 * Şimdilik in-process mock kullanılıyor; gerçek thread Phase 9'da.
 */
function createNativeWorkerFactory(
  offlineRuntime: IAIWorkerRuntime,
  cloudRuntime: IAIWorkerRuntime,
) {
  // Gerçek Worker thread desteği Phase 9 — şimdilik mock factory
  // Ancak runtime'lar gerçek (WASM / cloud API); sadece thread isolation eksik
  return createMockWorkerFactory(offlineRuntime, cloudRuntime);
}

// ─── Platform detect ──────────────────────────────────────────────────────────

function isNativeOrWeb(): boolean {
  // Jest ortamında false döner → MockLlamaCppLoader kullanılır
  return typeof __DEV__ !== "undefined" || typeof navigator !== "undefined";
}

// ─── AIRuntimeManager (AppContainer için) ────────────────────────────────────

/**
 * AppContainer'ın tuttuğu runtime manager.
 * Tek seferlik init, lifecycle yönetimi.
 */
export class AIRuntimeManager {
  private _bridge: AIWorkerBridge | null = null;
  private _keyStore: IAPIKeyStoreExtended | null = null;
  private _disposed = false;

  async init(opts: {
    offlineModelId: AIModelId;
    keyStore: IAPIKeyStoreExtended;
    useMock?: boolean;
  }): Promise<Result<void>> {
    if (this._disposed) return err("RUNTIME_UNKNOWN", "Disposed");
    if (this._bridge)   return ok(undefined); // zaten başlatıldı

    this._keyStore = opts.keyStore;
    const result = await createAIWorkerBridge(opts);
    if (!result.ok) return result as unknown as Result<void>;

    this._bridge = result.data;
    return ok(undefined);
  }

  get bridge(): AIWorkerBridge | null { return this._bridge; }
  get keyStore(): IAPIKeyStoreExtended | null { return this._keyStore; }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    try { this._bridge?.dispose(); } catch { /* ignore */ }
    try { this._keyStore?.dispose(); } catch { /* ignore */ }
    this._bridge   = null;
    this._keyStore = null;
  }
}
