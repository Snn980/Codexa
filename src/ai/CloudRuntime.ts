/**
 * ai/CloudRuntime.ts — Anthropic ve OpenAI non-streaming adapter
 *
 * EXPO GO UYUMU (Nisan 2026):
 *   Android Expo Go'da response.body (ReadableStream) güvenilir değil.
 *   Her iki provider için stream:false kullanılır.
 *   RUNTIME_STREAM_PARSE_ERROR / "Response body null" hataları ortadan kalkar.
 *
 * Model API ID'leri:
 *   Anthropic : claude-haiku-4-5-20251001, claude-sonnet-4-6, claude-opus-4-6
 *   OpenAI    : gpt-4.1-mini, o4-mini
 */

import { ok, err } from "../core/Result";
import type { Result } from "../core/Result";
import type {
  IAIWorkerRuntime,
  RuntimeChatRequest,
  StreamResult,
} from "./IAIWorkerRuntime";
import { RuntimeErrorCode } from "./IAIWorkerRuntime";
import type { AIModelId } from "./AIModels";
import { AI_MODELS, AIProvider } from "./AIModels";

const FETCH_TIMEOUT_MS = 30_000;

export interface IAPIKeyStore {
  getKey(provider: "anthropic" | "openai"): Promise<string | null>;
}

export class CloudRuntime implements IAIWorkerRuntime {
  private readonly _keyStore: IAPIKeyStore;
  private _disposed = false;

  constructor(keyStore: IAPIKeyStore) {
    this._keyStore = keyStore;
  }

  isReady(_modelId: AIModelId): boolean {
    return !this._disposed;
  }

  async *streamChat(
    request: RuntimeChatRequest,
  ): AsyncGenerator<string, Result<StreamResult>, unknown> {
    if (this._disposed) {
      return err(RuntimeErrorCode.UNKNOWN, "CloudRuntime disposed");
    }

    const model = AI_MODELS.find((m) => m.id === request.modelId);
    if (!model) {
      return err(RuntimeErrorCode.MODEL_NOT_LOADED, `Unknown model: ${request.modelId}`);
    }

    if (model.provider === AIProvider.ANTHROPIC) {
      return yield* this._callAnthropic(request);
    }
    if (model.provider === AIProvider.OPENAI) {
      return yield* this._callOpenAI(request);
    }
    return err(RuntimeErrorCode.UNKNOWN, `Unsupported provider: ${model.provider}`);
  }

  // ─── Timeout signal ───────────────────────────────────────────────────────

  private _makeSignal(userSignal: AbortSignal, timeoutMs: number): AbortSignal {
    const ts = typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : null;
    if (!ts) return userSignal;
    return typeof AbortSignal.any === "function"
      ? AbortSignal.any([userSignal, ts])
      : userSignal;
  }

  // ─── Anthropic (non-streaming) ────────────────────────────────────────────

  private async *_callAnthropic(
    request: RuntimeChatRequest,
  ): AsyncGenerator<string, Result<StreamResult>, unknown> {
    const apiKey = await this._keyStore.getKey("anthropic");
    if (!apiKey) return err(RuntimeErrorCode.API_AUTH_FAILED, "Anthropic API key not found");

    const systemMsg = request.messages.find((m) => m.role === "system");
    const chatMsgs  = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model:      request.apiModelId,
          max_tokens: request.maxTokens,
          stream:     false,
          ...(systemMsg ? { system: systemMsg.content } : {}),
          messages: chatMsgs,
        }),
        signal: this._makeSignal(request.signal, FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const s = response.status;
        let errBody = "";
        try { errBody = await response.text(); } catch {}
        if (__DEV__) console.error("[CloudRuntime] Anthropic error", s, errBody.slice(0, 300));
        if (s === 401) return err(RuntimeErrorCode.API_AUTH_FAILED, "Anthropic 401: Geçersiz API anahtarı");
        if (s === 429) return err(RuntimeErrorCode.API_RATE_LIMITED, "Anthropic 429: İstek limiti aşıldı");
        try {
          const parsed = JSON.parse(errBody) as Record<string, unknown>;
          const msg = (parsed["error"] as Record<string, string>)?.["message"] ?? errBody;
          return err(RuntimeErrorCode.API_NETWORK_ERROR, msg.slice(0, 200));
        } catch {
          return err(RuntimeErrorCode.API_NETWORK_ERROR, `Anthropic HTTP ${s}`);
        }
      }

      const json    = await response.json() as Record<string, unknown>;
      const content = json["content"] as Array<Record<string, unknown>> | undefined;
      const text    = content
        ?.filter((b) => b["type"] === "text")
        .map((b) => b["text"] as string)
        .join("") ?? "";

      const usage       = (json["usage"] ?? {}) as Record<string, number>;
      const totalTokens = (usage["input_tokens"] ?? 0) + (usage["output_tokens"] ?? 0);

      if (text) yield text;
      return ok({ totalTokens });
    } catch (e) {
      if (request.signal.aborted) return err(RuntimeErrorCode.REQUEST_ABORTED, "Aborted");
      return err(RuntimeErrorCode.API_NETWORK_ERROR, String(e));
    }
  }

  // ─── OpenAI (non-streaming) ───────────────────────────────────────────────

  private async *_callOpenAI(
    request: RuntimeChatRequest,
  ): AsyncGenerator<string, Result<StreamResult>, unknown> {
    const apiKey = await this._keyStore.getKey("openai");
    if (!apiKey) return err(RuntimeErrorCode.API_AUTH_FAILED, "OpenAI API key not found");

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model:                 request.apiModelId,
          max_completion_tokens: request.maxTokens,
          stream:                false,
          messages:              request.messages.map((m) => ({ role: m.role, content: m.content })),
        }),
        signal: this._makeSignal(request.signal, FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const s = response.status;
        let errBody = "";
        try { errBody = await response.text(); } catch {}
        if (__DEV__) console.error("[CloudRuntime] OpenAI error", s, errBody.slice(0, 300));
        if (s === 401) return err(RuntimeErrorCode.API_AUTH_FAILED, "OpenAI 401: Geçersiz API anahtarı");
        if (s === 429) return err(RuntimeErrorCode.API_RATE_LIMITED, "OpenAI 429: İstek limiti aşıldı");
        try {
          const parsed = JSON.parse(errBody) as Record<string, unknown>;
          const msg = (parsed["error"] as Record<string, string>)?.["message"] ?? errBody;
          return err(RuntimeErrorCode.API_NETWORK_ERROR, msg.slice(0, 200));
        } catch {
          return err(RuntimeErrorCode.API_NETWORK_ERROR, `OpenAI HTTP ${s}`);
        }
      }

      const json    = await response.json() as Record<string, unknown>;
      const choices = json["choices"] as Array<Record<string, unknown>> | undefined;
      const text    = ((choices?.[0]?.["message"] as Record<string, unknown> | undefined)?.["content"] as string) ?? "";
      const usage   = (json["usage"] ?? {}) as Record<string, number>;
      const totalTokens = (usage["prompt_tokens"] ?? 0) + (usage["completion_tokens"] ?? 0);

      if (text) yield text;
      return ok({ totalTokens });
    } catch (e) {
      if (request.signal.aborted) return err(RuntimeErrorCode.REQUEST_ABORTED, "Aborted");
      return err(RuntimeErrorCode.API_NETWORK_ERROR, String(e));
    }
  }

  dispose(): void {
    this._disposed = true;
  }
}
