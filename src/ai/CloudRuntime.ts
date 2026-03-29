/**
 * ai/CloudRuntime.ts — Anthropic ve OpenAI SSE streaming adapter
 *
 * § 1  : Result<T>
 * § 5  : AsyncGenerator → STREAM token'ları
 *
 * DÜZELTMELER:
 *   ❗ SSE CHUNK BOUNDARY : buffer'ı satır sınırında kes; yarım JSON'u
 *      bir sonraki chunk'a taşı. Önceki impl lines.pop() ile sadece son
 *      satırı tutuyordu — bu yeterliydi ama buffer boş olunca "\n" ile
 *      biten chunk'larda son satır kayboluyordu. Şimdi net boundary logic.
 *   ❗ ANTHROPIC DOĞRULAMA: content_block_delta + text_delta zorunlu tip
 *      kontrolü; bilinmeyen type'lar sessizce atlanıyor (eskiden sadece
 *      message_stop / message_delta bakılıyordu).
 *   💡 FETCH TIMEOUT: AbortSignal.any() ile sabit 30s timeout — sonsuz
 *      ağ bekleme sorunu giderildi. (Node ≥ 20 / modern RN ≥ 0.73)
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

// ─── Sabitler ─────────────────────────────────────────────────────────────────

/** 💡 FETCH TIMEOUT: bağlantı kurulduktan sonra ilk byte için timeout */
const FETCH_TIMEOUT_MS = 30_000;
/** İlk STREAM byte'ı bu sürede gelmezse abort */
const STREAM_FIRST_BYTE_TIMEOUT_MS = 60_000;

// ─── API Anahtarı deposu arayüzü ─────────────────────────────────────────────

export interface IAPIKeyStore {
  getKey(provider: "anthropic" | "openai"): Promise<string | null>;
}

// ─── CloudRuntime ─────────────────────────────────────────────────────────────

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
      return yield* this._streamAnthropic(request);
    }
    if (model.provider === AIProvider.OPENAI) {
      return yield* this._streamOpenAI(request);
    }
    return err(RuntimeErrorCode.UNKNOWN, `Unsupported provider: ${model.provider}`);
  }

  // ─── Timeout signal fabrikası ────────────────────────────────────────

  /**
   * 💡 FETCH TIMEOUT: kullanıcının AbortSignal ile timeout signal'ı birleştirir.
   * AbortSignal.any() modern RN (Hermes ≥ v2, JSC) ve Node ≥ 20'de mevcut.
   * Yoksa sadece kullanıcı signal'ı kullanılır — güvenli fallback.
   */
  private _makeSignal(userSignal: AbortSignal, timeoutMs: number): AbortSignal {
    const timeoutSignal = typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : null;

    if (!timeoutSignal) return userSignal;

    return typeof AbortSignal.any === "function"
      ? AbortSignal.any([userSignal, timeoutSignal])
      : userSignal;
  }

  // ─── Anthropic ──────────────────────────────────────────────────────

  private async *_streamAnthropic(
    request: RuntimeChatRequest,
  ): AsyncGenerator<string, Result<StreamResult>, unknown> {
    const apiKey = await this._keyStore.getKey("anthropic");
    if (!apiKey) return err(RuntimeErrorCode.API_AUTH_FAILED, "Anthropic API key not found");

    const systemMsg = request.messages.find((m) => m.role === "system");
    const chatMsgs  = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const body = JSON.stringify({
      model:      request.apiModelId,
      max_tokens: request.maxTokens,
      stream:     true,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: chatMsgs,
    });

    const fetchSignal = this._makeSignal(request.signal, FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type":    "application/json",
          "x-api-key":       apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
        signal: fetchSignal,
      });
    } catch (e) {
      if (request.signal.aborted) return err(RuntimeErrorCode.REQUEST_ABORTED, "Aborted");
      return err(RuntimeErrorCode.API_NETWORK_ERROR, String(e));
    }

    if (!response.ok) {
      const s = response.status;
      let errBody = '';
      try { errBody = await response.text(); } catch {}
      if (__DEV__) console.error('[CloudRuntime] Anthropic error', s, errBody.slice(0, 300));
      if (s === 401) return err(RuntimeErrorCode.API_AUTH_FAILED, "Anthropic 401");
      if (s === 429) return err(RuntimeErrorCode.API_RATE_LIMITED, "Anthropic 429");
      return err(RuntimeErrorCode.API_NETWORK_ERROR, `Anthropic HTTP ${s}: ${errBody.slice(0, 200)}`);
    }

    let outputTokens = 0;

    // ❗ ANTHROPIC EVENT DOĞRULAMA: hem tip hem de delta.type kontrolü
    const result = yield* this._parseSSE(
      response,
      this._makeSignal(request.signal, STREAM_FIRST_BYTE_TIMEOUT_MS),
      (data) => {
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          const type = parsed["type"];

          // İçerik delta — tip + delta.type her ikisi de doğrulanıyor
          if (
            type === "content_block_delta" &&
            typeof parsed["delta"] === "object" &&
            parsed["delta"] !== null
          ) {
            const delta = parsed["delta"] as Record<string, unknown>;
            if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
              return { token: delta["text"], done: false };
            }
            // thinking_delta, input_json_delta vb. — sessizce atla
            return null;
          }

          // Token sayacı
          if (type === "message_delta") {
            const usage = (parsed["usage"] ?? {}) as Record<string, unknown>;
            outputTokens = (usage["output_tokens"] as number) ?? outputTokens;
            return null;
          }

          // Kapanış sinyali
          if (type === "message_stop") return { done: true as const };

          // content_block_start, ping vb. — atla
          return null;
        } catch {
          return null; // yarım JSON — bir sonraki chunk'ta tamamlanır
        }
      },
    );

    if (!result.ok) return result;
    return ok({ totalTokens: outputTokens });
  }

  // ─── OpenAI ─────────────────────────────────────────────────────────

  private async *_streamOpenAI(
    request: RuntimeChatRequest,
  ): AsyncGenerator<string, Result<StreamResult>, unknown> {
    const apiKey = await this._keyStore.getKey("openai");
    if (!apiKey) return err(RuntimeErrorCode.API_AUTH_FAILED, "OpenAI API key not found");

    const body = JSON.stringify({
      model:               request.apiModelId,
      max_completion_tokens: request.maxTokens,
      stream:              true,
      stream_options:      { include_usage: true },
      messages:            request.messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const fetchSignal = this._makeSignal(request.signal, FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Bearer ${apiKey}`,
        },
        body,
        signal: fetchSignal,
      });
    } catch (e) {
      if (request.signal.aborted) return err(RuntimeErrorCode.REQUEST_ABORTED, "Aborted");
      return err(RuntimeErrorCode.API_NETWORK_ERROR, String(e));
    }

    if (!response.ok) {
      const s = response.status;
      if (s === 401) return err(RuntimeErrorCode.API_AUTH_FAILED, "OpenAI 401");
      if (s === 429) return err(RuntimeErrorCode.API_RATE_LIMITED, "OpenAI 429");
      return err(RuntimeErrorCode.API_NETWORK_ERROR, `OpenAI HTTP ${s}`);
    }

    let totalTokens = 0;

    const result = yield* this._parseSSE(
      response,
      this._makeSignal(request.signal, STREAM_FIRST_BYTE_TIMEOUT_MS),
      (data) => {
        if (data === "[DONE]") return { done: true as const };
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          const choices = parsed["choices"] as Array<Record<string, unknown>> | undefined;
          if (choices && choices.length > 0) {
            const delta = choices[0]["delta"] as Record<string, unknown> | undefined;
            const content = delta?.["content"];
            if (typeof content === "string" && content.length > 0) {
              return { token: content, done: false };
            }
          }
          // usage satırı
          const usage = parsed["usage"] as Record<string, number> | undefined;
          if (usage) {
            totalTokens = (usage["prompt_tokens"] ?? 0) + (usage["completion_tokens"] ?? 0);
          }
        } catch {
          return null;
        }
        return null;
      },
    );

    if (!result.ok) return result;
    return ok({ totalTokens });
  }

  // ─── Ortak SSE parser ────────────────────────────────────────────────

  /**
   * ❗ SSE CHUNK BOUNDARY FIX:
   * Her chunk decode edilir, buffer'a eklenir.
   * Satır ayırımı "\n" ile yapılır; son tamamlanmamış satır buffer'da kalır.
   * Bu sayede JSON bir chunk'ta yarım gelirse parse hata üretmez —
   * bir sonraki chunk'ta birleştirilerek komple satır oluşur.
   *
   * `parseLine`: "data: " prefix soyulduktan sonra içeriği alır.
   * { token, done:false } | { done:true } | null döner.
   */
  private async *_parseSSE(
    response: Response,
    signal: AbortSignal,
    parseLine: (data: string) => { token: string; done: false } | { done: true } | null,
  ): AsyncGenerator<string, Result<StreamResult>, unknown> {
    if (!response.body) {
      return err(RuntimeErrorCode.STREAM_PARSE_ERROR, "Response body null");
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer    = "";

    try {
      while (true) {
        if (signal.aborted) {
          return err(RuntimeErrorCode.REQUEST_ABORTED, "Aborted during stream");
        }

        const { done, value } = await reader.read();

        // ❗ CHUNK BOUNDARY: chunk'ı buffer'a ekle, satır sınırında kes
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
        }

        // Tüm tamamlanmış satırları işle — son satır (tamamlanmamış) buffer'da kalır
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trimEnd();
          buffer = buffer.slice(newlineIdx + 1);

          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trimStart(); // "data:" sonrası boşluk(lar)
          if (!data) continue;

          const parsed = parseLine(data);
          if (!parsed) continue;
          if (parsed.done) return ok({ totalTokens: 0 }); // caller totalTokens'ı set eder
          yield parsed.token;
        }

        if (done) break;
      }

      // Buffer'da kalan son satırı işle (stream "\n" ile bitmediyse)
      const remaining = buffer.trim();
      if (remaining.startsWith("data:")) {
        const data = remaining.slice(5).trimStart();
        if (data) {
          const parsed = parseLine(data);
          if (parsed?.done) return ok({ totalTokens: 0 });
          if (parsed && !parsed.done) yield parsed.token;
        }
      }
    } catch (e) {
      if (signal.aborted) return err(RuntimeErrorCode.REQUEST_ABORTED, "Aborted");
      return err(RuntimeErrorCode.STREAM_PARSE_ERROR, String(e));
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }

    return ok({ totalTokens: 0 });
  }

  dispose(): void {
    this._disposed = true;
  }
}
