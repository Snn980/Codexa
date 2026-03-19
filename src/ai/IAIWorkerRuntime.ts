/**
 * ai/IAIWorkerRuntime.ts
 *
 * AI Worker runtime arayüzü ve ortak tip tanımları.
 * OfflineRuntime ve CloudRuntime bu arayüzü implemente eder.
 */

import type { AIModelId } from "./AIModels";
import type { Result }    from "../core/Result";

// ─── Hata kodları ─────────────────────────────────────────────────────────────

export const RuntimeErrorCode = {
  UNKNOWN:            "RUNTIME_UNKNOWN",
  WASM_INIT_FAILED:   "RUNTIME_WASM_INIT_FAILED",
  MODEL_NOT_LOADED:   "RUNTIME_MODEL_NOT_LOADED",
  REQUEST_ABORTED:    "RUNTIME_REQUEST_ABORTED",
  STREAM_PARSE_ERROR: "RUNTIME_STREAM_PARSE_ERROR",
  API_AUTH_FAILED:    "RUNTIME_API_AUTH_FAILED",
  API_RATE_LIMITED:   "RUNTIME_API_RATE_LIMITED",
  API_NETWORK_ERROR:  "RUNTIME_API_NETWORK_ERROR",
} as const;

export type RuntimeErrorCode = (typeof RuntimeErrorCode)[keyof typeof RuntimeErrorCode];

// ─── Mesaj tipi ───────────────────────────────────────────────────────────────

export interface RuntimeMessage {
  role:    "system" | "user" | "assistant";
  content: string;
}

// ─── İstek / Sonuç tipleri ───────────────────────────────────────────────────

export interface RuntimeChatRequest {
  modelId:    AIModelId;
  apiModelId: string;
  messages:   RuntimeMessage[];
  maxTokens:  number;
  signal:     AbortSignal;
}

export interface StreamResult {
  totalTokens: number;
}

// ─── Runtime arayüzü ─────────────────────────────────────────────────────────

export interface IAIWorkerRuntime {
  isReady(modelId: AIModelId): boolean;
  streamChat(
    request: RuntimeChatRequest,
  ): AsyncGenerator<string, Result<StreamResult>, unknown>;
  dispose(): void;
}
