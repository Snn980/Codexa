/**
 * workers/ai.offline.worker.ts — Offline AI Worker thread entry
 *
 * REFACTOR: llama-cpp-wasm → llama.rn native binding
 *
 * Değişiklikler:
 *   ❌ require("../../assets/llama.wasm")   — WASM asset artık yok
 *   ❌ ExpoLlamaCppLoader(WASM_ASSET_URI)   — eski WASM imzası
 *   ✅ ExpoLlamaCppLoader(modelId, config)  — llama.rn native imzası
 *   ✅ Varsayılan model: OFFLINE_GEMMA3_1B  — runtime'da setModelPath() ile override edilir
 *
 * Mimari:
 *   Worker thread
 *     └─ OfflineRuntime(ExpoLlamaCppLoader)
 *          └─ LlamaCppWasm.ExpoLlamaCppLoader → initLlama() (llama.rn)
 *               └─ LlamaRnContext (Metal / OpenCL)
 *
 * Gereksinim: Expo Dev Client — Expo Go bu worker'ı yükleyemez.
 *
 * § 5  : REQUEST / STREAM / RESPONSE / CANCEL protokolü
 */

import { bootstrapWorker }      from "../ai/AIWorker";
import { OfflineRuntime,
         MockLlamaCppLoader }   from "../ai/OfflineRuntime";
import { ExpoLlamaCppLoader }   from "../ai/LlamaCppWasm";
import { AIModelId }            from "../ai/AIModels";

declare const self: DedicatedWorkerGlobalScope;

// ─── Runtime ─────────────────────────────────────────────────────────────────

function createRuntime(): OfflineRuntime {
  // Jest / CI: __DEV__ tanımsız → mock runtime
  const isNative = (() => { try { return typeof __DEV__ !== "undefined"; } catch { return false; } })();

  if (!isNative) {
    return new OfflineRuntime(new MockLlamaCppLoader());
  }

  // llama.rn native loader
  // Varsayılan model: GEMMA3_1B — modelPath worker başladıktan sonra
  // AIWorkerBridge üzerinden gelen LOAD mesajıyla set edilir.
  const loader = new ExpoLlamaCppLoader(AIModelId.OFFLINE_GEMMA3_1B, {
    n_ctx:        4096,
    n_threads:    4,
    n_gpu_layers: 1,  // Metal (iOS) / OpenCL (Android) — CPU-only için 0 yap
    use_mlock:    false,
  });

  return new OfflineRuntime(loader);
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const runtime = createRuntime();
const worker  = bootstrapWorker(runtime, self);

self.addEventListener("close", () => { worker.dispose(); });
