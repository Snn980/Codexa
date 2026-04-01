/**
 * ai/AIRuntimeFactory.ts — Cloud-only AI runtime fabrikası.
 * Offline runtime kaldırıldı — sadece CloudRuntime kullanılır.
 */

import type { IAIWorkerRuntime }    from "./IAIWorkerRuntime";
import { CloudRuntime }             from "./CloudRuntime";
import { AIWorkerBridge, createMockWorkerFactory } from "./AIWorkerBridge";
import type { IAPIKeyStoreExtended } from "../security/APIKeyStore";
import type { Result }              from "../core/Result";
import { ok, err }                  from "../core/Result";

export function createCloudRuntime(keyStore: IAPIKeyStoreExtended): IAIWorkerRuntime {
  return new CloudRuntime(keyStore);
}

export async function createAIWorkerBridge(opts: {
  keyStore:  IAPIKeyStoreExtended;
  useMock?:  boolean;
}): Promise<Result<AIWorkerBridge>> {
  const { keyStore, useMock = false } = opts;
  const cloudRuntime = createCloudRuntime(keyStore);
  const factory = createMockWorkerFactory(cloudRuntime, cloudRuntime);
  return ok(new AIWorkerBridge(factory));
}

export class AIRuntimeManager {
  private _bridge:    AIWorkerBridge      | null = null;
  private _keyStore:  IAPIKeyStoreExtended | null = null;
  private _disposed = false;

  async init(opts: {
    keyStore:  IAPIKeyStoreExtended;
    useMock?:  boolean;
    offlineModelId?: unknown; // legacy — ignored
  }): Promise<Result<void>> {
    if (this._disposed) return err("RUNTIME_UNKNOWN", "Disposed");
    if (this._bridge)   return ok(undefined);

    this._keyStore = opts.keyStore;
    const result = await createAIWorkerBridge({
      keyStore: opts.keyStore,
      useMock:  opts.useMock,
    });
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
