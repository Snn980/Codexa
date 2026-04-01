/**
 * @file  core/ai/AIContainer.ts
 *
 * AI katmanı — runtime, bridge, orchestrator, lifecycle.
 * Framework bağımsız: sadece AI servislerini başlatır ve yönetir.
 */

import { AIRuntimeManager }          from "@/ai/AIRuntimeFactory";
import { AIWorkerBridge }            from "@/ai/AIWorkerBridge";
import { AIOrchestrator }            from "@/ai/orchestration/AIOrchestrator";
import { AIWorkerClient }            from "@/ai/AIWorkerClient";
import { AppStateManager }           from "@/lifecycle/AppStateManager";
import { AIModelId }                 from "@/ai/AIModels";
import { generateId }                from "@/utils/uuid";
import type { UUID }                 from "@/types/core";
import type { IAPIKeyStoreExtended } from "@/security/APIKeyStore";

export interface AIContainerOptions {
  keyStore:        IAPIKeyStoreExtended;
  useMockWorkers?: boolean;
}

export class AIContainer {
  private _runtimeMgr:   AIRuntimeManager | null = null;
  private _bridge:       AIWorkerBridge   | null = null;
  private _appStateMgr:  AppStateManager  | null = null;
  private _orchestrator: AIOrchestrator   | null = null;

  get bridge():      AIWorkerBridge  { return this._require(this._bridge,      "bridge"); }
  get appStateMgr(): AppStateManager { return this._require(this._appStateMgr, "appStateMgr"); }

  /** Lazy — bridge hazır olduktan sonra ilk erişimde oluşur. */
  get orchestrator(): AIOrchestrator {
    if (!this._orchestrator) {
      const client = new AIWorkerClient(this.bridge, generateId as () => UUID);
      this._orchestrator = new AIOrchestrator(client);
    }
    return this._orchestrator;
  }

  async init(opts: AIContainerOptions): Promise<void> {
    const { keyStore, useMockWorkers = false } = opts;

    this._runtimeMgr = new AIRuntimeManager();
    const result = await this._runtimeMgr.init({
      offlineModelId: AIModelId.OFFLINE_GEMMA3_1B,
      keyStore,
      useMock: useMockWorkers,
    });

    if (!result.ok) {
      throw new Error(
        `AIRuntimeManager init failed: ${(result as any).error?.message ?? "Unknown error"}`,
      );
    }

    this._bridge      = this._runtimeMgr.bridge;
    this._appStateMgr = new AppStateManager({ keyStore, bridge: this._bridge });
    this._appStateMgr.start();
  }

  dispose(): void {
    this._appStateMgr?.dispose();
    this._runtimeMgr?.dispose();

    this._orchestrator = null;
    this._appStateMgr  = null;
    this._bridge       = null;
    this._runtimeMgr   = null;
  }

  private _require<T>(value: T | null, name: string): T {
    if (value === null) throw new Error(`AIContainer: '${name}' henüz hazır değil.`);
    return value;
  }
}
