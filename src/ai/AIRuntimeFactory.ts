/**
 * ai/AIRuntimeFactory.ts — AppContainer AI runtime fabrikası
 *
 * § 4  : AppContainer DI pattern
 * § 1  : Result<T>
 *
 * REFACTOR: llama.rn → @mlc-ai/react-native-mlc-llm
 *   createOfflineRuntime() artık MlcLlmLoader kullanır.
 *   Diğer fonksiyonlar değişmedi.
 *
 * Platform'a ve permission seviyesine göre doğru runtime'ları oluşturur:
 *
 *   createOfflineRuntime(modelId)
 *     └─ MlcLlmLoader (MlcLlmBinding.ts) + ChatTemplate
 *          └─ OfflineRuntime → AIWorker (offline worker thread)
 *
 *   createCloudRuntime(keyStore)
 *     └─ APIKeyStore (Keychain)
 *          └─ CloudRuntime → AIWorker (cloud worker thread)
 *
 *   createAIWorkerBridge(offlineRuntime, cloudRuntime)
 *     └─ AIWorkerBridge (IWorkerPort)
 *          └─ AIWorkerClient (useAIChat)
 */

import type { IAIWorkerRuntime }    from "./IAIWorkerRuntime";
import type { ILlamaCppLoader }     from "./OfflineRuntime";
import { OfflineRuntime,
         MockLlamaCppLoader }       from "./OfflineRuntime";   // static — dynamic import yok
import { CloudRuntime }             from "./CloudRuntime";
import { AIWorkerBridge, createMockWorkerFactory } from "./AIWorkerBridge";
import type { AIModelId }           from "./AIModels";
import type { IAPIKeyStoreExtended } from "../security/APIKeyStore";
import type { Result }              from "../core/Result";
import { ok, err }                  from "../core/Result";

// ─── Fabrika fonksiyonları ────────────────────────────────────────────────────

/**
 * Offline runtime oluştur.
 *
 * MLC LLM native binding — llama.rn kaldırıldı.
 * Model ID MlcLlmLoader üzerinden MLC engine'e iletilir.
 *
 * Gereksinim: Expo Dev Client (npx expo run:ios / run:android)
 *             Expo Go desteklemez — native modül.
 */
export async function createOfflineRuntime(
  modelId: AIModelId,
): Promise<Result<IAIWorkerRuntime>> {
  try {
    let loader: ILlamaCppLoader;

    if (isNativeEnv()) {
      // MLC LLM native loader — iOS Metal / Android Vulkan/OpenCL
      const { MlcLlmLoader } = await import("./MlcLlmBinding");
      loader = new MlcLlmLoader(modelId);
    } else {
      // Test / CI ortamı — native modül yok
      loader = new MockLlamaCppLoader();  // static import
    }

    return ok(new OfflineRuntime(loader));
  } catch (e) {
    return err("RUNTIME_LLAMA_INIT_FAILED", String(e));
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
    const factory = createMockWorkerFactory(offlineResult.data, cloudRuntime);
    return ok(new AIWorkerBridge(factory));
  }

  const factory = createNativeWorkerFactory(offlineResult.data, cloudRuntime);
  return ok(new AIWorkerBridge(factory));
}

// ─── Native Worker factory ────────────────────────────────────────────────────

function createNativeWorkerFactory(
  offlineRuntime: IAIWorkerRuntime,
  cloudRuntime: IAIWorkerRuntime,
) {
  // Gerçek Worker thread desteği Phase 9 — şimdilik mock factory
  return createMockWorkerFactory(offlineRuntime, cloudRuntime);
}

// ─── Platform detect ──────────────────────────────────────────────────────────

function isNativeEnv(): boolean {
  try {
    return typeof __DEV__ !== "undefined";
  } catch {
    return false;
  }
}

// ─── AIRuntimeManager ────────────────────────────────────────────────────────

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
    if (this._bridge)   return ok(undefined);

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
