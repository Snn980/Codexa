/**
 * workers/ai.offline.worker.ts — Offline AI Worker thread entry
 *
 * REFACTOR: llama.rn → @react-native-ai/mlc (Callstack, v0.12.0)
 *
 * TS FIX: n_ctx MlcLlmLoader config'inde artık tanımlı (v3 binding).
 *
 * Mimari:
 *   Worker thread
 *     └─ OfflineRuntime(MlcLlmLoader)
 *          └─ MlcLlmBinding → @react-native-ai/mlc
 *               └─ MLCModel (Metal / Vulkan / OpenCL)
 *
 * § 5  : REQUEST / STREAM / RESPONSE / CANCEL protokolü
 */

import { bootstrapWorker }    from "../ai/AIWorker";
import { OfflineRuntime,
         MockLlamaCppLoader } from "../ai/OfflineRuntime";
import { MlcLlmLoader }       from "../ai/MlcLlmBinding";
import { AIModelId }          from "../ai/AIModels";

declare const self: DedicatedWorkerGlobalScope;

function createRuntime(): OfflineRuntime {
  const isNative = (() => {
    try { return typeof __DEV__ !== "undefined"; } catch { return false; }
  })();

  if (!isNative) return new OfflineRuntime(new MockLlamaCppLoader());

  // TS FIX: n_ctx artık MlcLlmLoader config'inde tanımlı
  const loader = new MlcLlmLoader(AIModelId.OFFLINE_GEMMA3_1B, {
    n_ctx: 4096,
  });

  return new OfflineRuntime(loader);
}

const runtime = createRuntime();
const worker  = bootstrapWorker(runtime, self);

self.addEventListener("close", () => { worker.dispose(); });
