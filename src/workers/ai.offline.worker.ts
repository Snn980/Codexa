/**
 * workers/ai.offline.worker.ts — Offline AI Worker thread entry
 *
 * DÜZELTME #1a — Yanlış import:
 *   ❌ from "../ai/LlamaCppWasm"  → 2-param constructor, T-P9-2 sonrası modelId gereksiz
 *   ✅ from "../ai/OfflineRuntime" → 1-param, OfflineRuntime'ın kendi loader stub'ı
 *
 * DÜZELTME #1b — 2. parametre hatalı:
 *   ❌ new ExpoLlamaCppLoader(WASM_ASSET_URI, AIModelId.OFFLINE_GEMMA3_1B)
 *      OfflineRuntime multi-model; loader'a modelId bağlamak Gemma3-4B/Phi-4'ü kırar.
 *   ✅ new ExpoLlamaCppLoader(WASM_ASSET_URI)
 *
 * § 5  : REQUEST / STREAM / RESPONSE / CANCEL protokolü
 * § 11 : Expo WASM load
 */

// ✅ Doğru import — OfflineRuntime kendi ExpoLlamaCppLoader ve MockLlamaCppLoader'ı export eder
import { bootstrapWorker }                          from "../ai/AIWorker";
import { OfflineRuntime, ExpoLlamaCppLoader,
         MockLlamaCppLoader }                       from "../ai/OfflineRuntime";
// ❌ KALDIRILDI: import { AIModelId } from "../ai/AIModels"  (artık gerekmez)
// ❌ KALDIRILDI: import { ExpoLlamaCppLoader } from "../ai/LlamaCppWasm"

declare const self: DedicatedWorkerGlobalScope;

// ─── WASM asset URI ───────────────────────────────────────────────────────────

const WASM_ASSET_URI: string = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("../../assets/llama.wasm");
  } catch {
    return "__mock__";
  }
})();

// ─── Runtime ─────────────────────────────────────────────────────────────────

function createRuntime(): OfflineRuntime {
  if (WASM_ASSET_URI === "__mock__") {
    return new OfflineRuntime(new MockLlamaCppLoader());
  }
  // ✅ Tek parametre — modelId OfflineRuntime._ensureLoaded(modelId, apiModelId)'de
  return new OfflineRuntime(new ExpoLlamaCppLoader(WASM_ASSET_URI));
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const runtime = createRuntime();
const worker  = bootstrapWorker(runtime, self);

self.addEventListener("close", () => { worker.dispose(); });
