/**
 * ai/LlamaCppWasm.ts — BACKWARD COMPAT STUB
 *
 * REFACTOR: llama.rn → @react-native-ai/mlc (Callstack, v0.12.0)
 *
 * Bu dosya sadece re-export wrapper'dır.
 * Tüm gerçek implementasyon → MlcLlmBinding.ts
 *
 * TS FIX: MlcBridgeAdapter de export edildi (tsc hatası giderildi).
 *
 * Orijinal llama.rn kodu: git show HEAD:src/ai/LlamaCppWasm.ts
 */

export {
  MlcLlmLoader,
  MlcBridgeAdapter,                         // ← TS FIX: önceden eksikti
  MlcDownloadHelper,
  MlcLlmLoader      as ExpoLlamaCppLoader,  // eski adla import edenler için
  MlcBridgeAdapter  as LlamaRnBridgeAdapter,
  WasmBootstrap,
  MockLlamaCppLoader,
  parsePromptToMessages,
} from "./MlcLlmBinding";

export type {
  MLCModel,
  MLCModelHandle,
  MLCProvider,
  MLCModule,
  VercelLanguageModel,
  StreamTextFn,
  LlamaRnContext,
} from "./MlcLlmBinding";
