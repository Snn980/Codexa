/**
 * ai/model/ClaudeApiRunner.ts
 *
 * Anthropic API (Claude) üzerinden cloud inference.
 * Phase 5.1 — Model Loader (rev 2)
 *
 * Düzeltmeler (rev 2):
 *  • Streaming path HTTP status kontrolü:
 *      postStream() → IHttpStreamResponse döner (status + body başlığı)
 *      200 dışı → stream açılmadan hata fırlatılır
 *  • SSE event türleri tamamlandı:
 *      content_block_start   — index takibi
 *      content_block_delta   — text_delta | input_json_delta
 *      content_block_stop    — no-op
 *      message_stop          — stream sonu sinyali
 *      ping                  — no-op (heartbeat)
 *      error                 — API hata mesajı stream içinde
 *  • Large prompt guard:
 *      estimateTokens() ≥ model contextWindow → CONTEXT_TOO_LARGE (run başlamadan)
 *  • RunId branded type, cancel(RunId) implementasyonu
 *  • maxConcurrentRuns = 4 (cloud)
 *  • activeRunIds getter
 *
 * Kural referansları:
 *  § 1  Result<T> / ok() / err() / tryResultAsync()
 *  § 3  IEventBus — doğrudan emit etmez; callback kullanır
 *  § 14.6  PermissionGate — cloud variantı sadece CLOUD_ENABLED'da çağrılır
 */

import {
  IModelRunner,
  LoadState,
  ModelErrorCode,
  ModelKey,
  ModelMeta,
  RunId,
  RunMessage,
  RunOptions,
  RunRequest,
  RunResult,
  RunnerVariant,
  estimateMessageTokens,
  modelKey,
  runId,
} from "./IModelRunner";
import type { Result } from "../types";
import { ok, err, tryResultAsync } from "../result";

// ─── HTTP Client interface (DI) ────────────────────────────────────────────

/**
 * Gerçek ortamda fetch API. Test ortamında mock inject edilir.
 *
 * postStream: Bağlantı kurulduktan SONRA HTTP status döner.
 * Status 2xx değilse stream açılmadan throw edilir.
 */
export interface IHttpClient {
  post(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<IHttpResponse>;

  /**
   * SSE / streaming için satır satır okuma.
   * @returns HTTP status kodu — 2xx dışı → caller throw eder
   */
  postStream(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    onLine: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<IHttpStreamResponse>;
}

export interface IHttpResponse {
  status: number;
  body: unknown;
}

export interface IHttpStreamResponse {
  /** HTTP response status kodu */
  status: number;
  /**
   * 2xx dışı durumlarda hata detayı — SSE akışı açılmadan önce parse edilir.
   * 2xx durumda null.
   */
  errorBody: unknown | null;
}

// ─── Config ────────────────────────────────────────────────────────────────

export interface ClaudeApiRunnerConfig {
  /** Anthropic API anahtarı — OS Keychain'den alınır */
  apiKey: string;
  /** API base URL (default: https://api.anthropic.com) */
  baseUrl?: string;
  /** Anthropic API version header */
  apiVersion?: string;
  /** Timeout ms (default 30_000) */
  defaultTimeoutMs?: number;
  /**
   * Maksimum eş zamanlı inference (default 4).
   * Rate limit / maliyet kontrolü için azaltılabilir.
   */
  maxConcurrentRuns?: number;
}

// ─── Supported models ──────────────────────────────────────────────────────

const CLOUD_MODELS: ReadonlyArray<ModelMeta> = [
  {
    key:          modelKey("claude-haiku"),
    displayName:  "Claude Haiku",
    variant:      RunnerVariant.CLOUD,
    contextWindow: 200_000,
    diskSizeBytes: 0,
    quantization: "API",
    modelPath:    null,
  },
  {
    key:          modelKey("claude-sonnet"),
    displayName:  "Claude Sonnet",
    variant:      RunnerVariant.CLOUD,
    contextWindow: 200_000,
    diskSizeBytes: 0,
    quantization: "API",
    modelPath:    null,
  },
];

/** ModelKey → Anthropic model string */
const MODEL_ID_MAP: ReadonlyMap<ModelKey, string> = new Map([
  [modelKey("claude-haiku"),  "claude-haiku-4-5-20251001"],
  [modelKey("claude-sonnet"), "claude-sonnet-4-6"],
]);

const ANTHROPIC_API_VERSION = "2023-06-01";

// ─── SSE event types ───────────────────────────────────────────────────────
// Anthropic streaming API'sinin tam event seti:
// https://docs.anthropic.com/en/api/messages-streaming

interface SseMessageStart {
  type: "message_start";
  message: { usage: { input_tokens: number } };
}

interface SseContentBlockStart {
  type: "content_block_start";
  index: number;
  content_block: { type: "text" | "tool_use"; text?: string };
}

interface SseContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta:
    | { type: "text_delta";       text: string }
    | { type: "input_json_delta"; partial_json: string };
}

interface SseContentBlockStop {
  type: "content_block_stop";
  index: number;
}

interface SseMessageDelta {
  type: "message_delta";
  delta: { stop_reason: string | null; stop_sequence: string | null };
  usage: { output_tokens: number };
}

interface SseMessageStop {
  type: "message_stop";
}

interface SsePing {
  type: "ping";
}

interface SseError {
  type: "error";
  error: { type: string; message: string };
}

type SseEvent =
  | SseMessageStart
  | SseContentBlockStart
  | SseContentBlockDelta
  | SseContentBlockStop
  | SseMessageDelta
  | SseMessageStop
  | SsePing
  | SseError
  | { type: string };

function parseSseLine(line: string): SseEvent | null {
  if (!line.startsWith("data: ")) return null;
  const json = line.slice(6).trim();
  if (json === "[DONE]") return null;
  try {
    return JSON.parse(json) as SseEvent;
  } catch {
    return null;
  }
}

// ─── Active run tracking ───────────────────────────────────────────────────

interface ActiveRun {
  readonly controller: AbortController;
  readonly startedAt: number;
}

// ─── ClaudeApiRunner ───────────────────────────────────────────────────────

export class ClaudeApiRunner implements IModelRunner {
  readonly variant = RunnerVariant.CLOUD;
  readonly supportedModels: ReadonlyArray<ModelMeta> = CLOUD_MODELS;

  readonly maxConcurrentRuns: number;

  private _loadState: LoadState = LoadState.READY;
  private _disposed = false;

  private readonly _activeRuns = new Map<RunId, ActiveRun>();
  private readonly _http: IHttpClient;
  private readonly _cfg: Required<Omit<ClaudeApiRunnerConfig, "maxConcurrentRuns">>;

  constructor(http: IHttpClient, config: ClaudeApiRunnerConfig) {
    this._http = http;
    this._cfg = {
      apiKey:           config.apiKey,
      baseUrl:          config.baseUrl          ?? "https://api.anthropic.com",
      apiVersion:       config.apiVersion       ?? ANTHROPIC_API_VERSION,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 30_000,
    };
    this.maxConcurrentRuns = config.maxConcurrentRuns ?? 4;
  }

  get loadState(): LoadState {
    return this._loadState;
  }

  get activeRunIds(): ReadonlySet<RunId> {
    return new Set(this._activeRuns.keys());
  }

  // ─── load / unload (no-op for cloud) ────────────────────────────────

  async load(_key: ModelKey): Promise<Result<void>> {
    return ok(undefined);
  }

  async unload(_key: ModelKey): Promise<Result<void>> {
    return ok(undefined);
  }

  // ─── estimateTokens ──────────────────────────────────────────────────

  estimateTokens(messages: ReadonlyArray<RunMessage>): number {
    return estimateMessageTokens(messages);
  }

  // ─── run ─────────────────────────────────────────────────────────────

  async run(request: RunRequest, options: RunOptions = {}): Promise<Result<RunResult>> {
    if (this._disposed) {
      return err(ModelErrorCode.INFERENCE_FAILED, "Runner disposed");
    }

    const { signal, onToken, timeoutMs = this._cfg.defaultTimeoutMs } = options;

    if (signal?.aborted) {
      return err(ModelErrorCode.INFERENCE_CANCELLED, "Cancelled before start");
    }

    if (this._activeRuns.size >= this.maxConcurrentRuns) {
      return err(
        ModelErrorCode.RUNNER_BUSY,
        `Max concurrent runs (${this.maxConcurrentRuns}) reached`,
      );
    }

    const modelId = MODEL_ID_MAP.get(request.modelKey);
    if (!modelId) {
      return err(
        ModelErrorCode.MODEL_NOT_LOADED,
        `Unsupported model key: ${request.modelKey}`,
        { context: { key: request.modelKey } },
      );
    }

    // ── Large prompt guard ─────────────────────────────────────────────
    const estimatedInputTokens = this.estimateTokens(request.messages);
    const modelMeta = this.supportedModels.find((m) => m.key === request.modelKey);
    const contextWindow = modelMeta?.contextWindow ?? 200_000;
    const maxOutputTokens = request.maxTokens ?? 1024;

    if (estimatedInputTokens + maxOutputTokens > contextWindow) {
      return err(
        ModelErrorCode.CONTEXT_TOO_LARGE,
        `Estimated prompt (${estimatedInputTokens} tokens) + maxTokens (${maxOutputTokens}) exceeds context window (${contextWindow})`,
        { context: { estimatedInputTokens, maxOutputTokens, contextWindow } },
      );
    }

    // ── Run ID & abort controller ──────────────────────────────────────
    const id = runId(`run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);
    const runController = new AbortController();

    this._activeRuns.set(id, { controller: runController, startedAt: Date.now() });

    const onExternalAbort = () => runController.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        runController.abort();
      }, timeoutMs);
    }

    const combinedSignal = signal
      ? this._mergeSignals(signal, runController.signal)
      : runController.signal;

    const startMs = Date.now();

    let inputTokens:  number | null = null;
    let outputTokens: number | null = null;
    let fullText = "";

    const { systemPrompt, chatMessages } = this._splitMessages(request);
    const isStreaming = onToken !== undefined;

    const body = {
      model:       modelId,
      max_tokens:  maxOutputTokens,
      temperature: request.temperature ?? 0.2,
      system:      systemPrompt,
      messages:    chatMessages,
      stream:      isStreaming,
    };

    const headers: Record<string, string> = {
      "Content-Type":     "application/json",
      "x-api-key":        this._cfg.apiKey,
      "anthropic-version": this._cfg.apiVersion,
    };

    const result = await tryResultAsync(
      async () => {
        if (isStreaming && onToken) {
          // ── Streaming path ─────────────────────────────────────────
          const streamResp = await this._http.postStream(
            `${this._cfg.baseUrl}/v1/messages`,
            headers,
            body,
            (line) => {
              const event = parseSseLine(line);
              if (!event) return;

              switch (event.type) {
                case "message_start": {
                  inputTokens = (event as SseMessageStart).message.usage.input_tokens;
                  break;
                }
                case "content_block_start": {
                  // Tool-use block başlangıcı — text dışı bloklar için index takibi
                  // (şu an sadece text blokları işleniyor)
                  break;
                }
                case "content_block_delta": {
                  const e = event as SseContentBlockDelta;
                  if (e.delta.type === "text_delta") {
                    fullText += e.delta.text;
                    onToken(e.delta.text);
                  }
                  // input_json_delta: tool-use, şu an işlenmiyor
                  break;
                }
                case "content_block_stop": {
                  // Block kapandı — no-op
                  break;
                }
                case "message_delta": {
                  outputTokens = (event as SseMessageDelta).usage.output_tokens;
                  break;
                }
                case "message_stop": {
                  // Stream tamamlandı — postStream zaten resolve edecek
                  break;
                }
                case "ping": {
                  // Heartbeat — no-op
                  break;
                }
                case "error": {
                  const e = event as SseError;
                  throw new Error(`SSE error: ${e.error.type} — ${e.error.message}`);
                }
              }
            },
            combinedSignal,
          );

          // ── Streaming HTTP status kontrolü ─────────────────────────
          // postStream bağlantı kurulduktan sonra status döner.
          // 2xx dışı durum → stream açılmadan önce caller'a hata.
          this._assertStreamStatus(streamResp.status, streamResp.errorBody);

        } else {
          // ── Non-streaming path ─────────────────────────────────────
          const resp = await this._http.post(
            `${this._cfg.baseUrl}/v1/messages`,
            headers,
            body,
            combinedSignal,
          );

          this._assertSuccessStatus(resp.status, resp.body);

          const parsed = resp.body as {
            content: Array<{ type: string; text?: string }>;
            usage: { input_tokens: number; output_tokens: number };
          };

          fullText = parsed.content
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("");

          inputTokens  = parsed.usage.input_tokens;
          outputTokens = parsed.usage.output_tokens;
        }
      },
      ModelErrorCode.INFERENCE_FAILED,
      "Cloud inference failed",
    );

    // ── Cleanup ────────────────────────────────────────────────────────
    signal?.removeEventListener("abort", onExternalAbort);
    if (timeoutId !== null) clearTimeout(timeoutId);
    this._activeRuns.delete(id);

    // ── Error classification ───────────────────────────────────────────
    if (!result.ok) {
      if (timedOut) {
        return err(ModelErrorCode.INFERENCE_TIMEOUT, `Request timed out after ${timeoutMs}ms`);
      }
      if (signal?.aborted || runController.signal.aborted) {
        return err(ModelErrorCode.INFERENCE_CANCELLED, "Request cancelled");
      }

      const msg = result.error?.message ?? "";
      if (msg.includes("401") || msg.toLowerCase().includes("auth")) {
        return err(ModelErrorCode.PROVIDER_AUTH_FAILED, "API authentication failed");
      }
      if (msg.includes("429")) {
        return err(ModelErrorCode.PROVIDER_RATE_LIMITED, "API rate limit exceeded");
      }
      if (msg.includes("529") || msg.includes("503")) {
        return err(ModelErrorCode.PROVIDER_UNAVAILABLE, "API temporarily unavailable");
      }

      return result;
    }

    return ok<RunResult>({
      runId:        id,
      text:         fullText,
      inputTokens,
      outputTokens,
      latencyMs:    Date.now() - startMs,
      usedModelKey: request.modelKey,
    });
  }

  // ─── cancel ──────────────────────────────────────────────────────────

  async cancel(id: RunId): Promise<Result<void>> {
    const activeRun = this._activeRuns.get(id);
    if (!activeRun) {
      return err(ModelErrorCode.RUN_NOT_FOUND, `Run not found: ${id}`, { context: { id } });
    }
    if (activeRun.controller.signal.aborted) {
      return ok(undefined); // idempotent
    }
    activeRun.controller.abort();
    return ok(undefined);
  }

  // ─── healthCheck ─────────────────────────────────────────────────────

  async healthCheck(): Promise<Result<void>> {
    if (this._disposed) return err(ModelErrorCode.INFERENCE_FAILED, "Runner disposed");

    const result = await tryResultAsync(
      async () => {
        const resp = await this._http.post(
          `${this._cfg.baseUrl}/v1/models`,
          { "x-api-key": this._cfg.apiKey, "anthropic-version": this._cfg.apiVersion },
          null,
          undefined,
        );
        this._assertSuccessStatus(resp.status, resp.body);
      },
      ModelErrorCode.PROVIDER_UNAVAILABLE,
      "API health check failed",
    );

    if (!result.ok) {
      const msg = result.error?.message ?? "";
      if (msg.includes("401")) {
        return err(ModelErrorCode.PROVIDER_AUTH_FAILED, "API key invalid");
      }
    }

    return result;
  }

  // ─── dispose ─────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;

    for (const [, run] of this._activeRuns) {
      run.controller.abort();
    }
    this._activeRuns.clear();
    this._loadState = LoadState.UNLOADED;
  }

  // ─── private ─────────────────────────────────────────────────────────

  private _splitMessages(request: RunRequest): {
    systemPrompt: string | undefined;
    chatMessages: Array<{ role: "user" | "assistant"; content: string }>;
  } {
    let systemPrompt: string | undefined;
    const chatMessages: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemPrompt = msg.content;
      } else {
        chatMessages.push({ role: msg.role, content: msg.content });
      }
    }

    return { systemPrompt, chatMessages };
  }

  private _assertSuccessStatus(status: number, body: unknown): void {
    if (status < 200 || status >= 300) {
      const detail =
        typeof body === "object" && body !== null && "error" in body
          ? JSON.stringify((body as { error: unknown }).error)
          : String(status);
      throw new Error(`HTTP ${status}: ${detail}`);
    }
  }

  /**
   * Streaming response status kontrolü.
   * postStream() bağlantı kurulduktan sonra status döndürür.
   * 2xx dışı → SSE satırları işlenmeden hata fırlatılır.
   */
  private _assertStreamStatus(status: number, errorBody: unknown): void {
    if (status < 200 || status >= 300) {
      const detail =
        typeof errorBody === "object" && errorBody !== null && "error" in errorBody
          ? JSON.stringify((errorBody as { error: unknown }).error)
          : String(status);
      throw new Error(`HTTP ${status}: ${detail}`);
    }
  }

  private _mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
    if (typeof AbortSignal.any === "function") {
      return AbortSignal.any([a, b]);
    }
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    a.addEventListener("abort", abort, { once: true });
    b.addEventListener("abort", abort, { once: true });
    return ctrl.signal;
  }
}
