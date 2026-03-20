/**
 * ai/model/IModelRunner.ts
 *
 * Offline + cloud runner'larının ortak arayüzü.
 * Phase 5.1 — Model Loader (rev 2)
 *
 * Değişiklikler (rev 2):
 *  • run()             → Promise<Result<RunResult>>  — RunResult.runId içerir
 *  • cancel(runId)     → Promise<Result<void>>        — id ile iptal
 *  • maxConcurrentRuns readonly getter                — runner kapasitesi
 *  • activeRunIds      → ReadonlySet<RunId>           — anlık çalışan run'lar
 *  • estimateTokens()  → number                       — prompt bütçe tahmini
 *  • ModelMeta.modelPath → string | null              — offline GGUF path
 *
 * Kural referansları:
 *  § 1  Result<T> / ok() / err() / tryResultAsync()
 *  § 3  IEventBus — emit() asla throw etmez
 *  § 5  IPC şeması — REQUEST/RESPONSE/STREAM/CANCEL
 */

import type { Result } from "../../core/Result";

// ─── Branded types ────────────────────────────────────────────────────────────

export type ModelKey = string & { _brand: "ModelKey" };
export type RunId   = string & { _brand: "RunId" };

export function modelKey(s: string): ModelKey {
  return s as ModelKey;
}
export function runId(s: string): RunId {
  return s as RunId;
}

// ─── Variant ──────────────────────────────────────────────────────────────────

export const RunnerVariant = {
  OFFLINE: "offline",
  CLOUD:   "cloud",
} as const;
export type RunnerVariant = (typeof RunnerVariant)[keyof typeof RunnerVariant];

// ─── Error codes ──────────────────────────────────────────────────────────────

export const ModelErrorCode = {
  MODEL_NOT_LOADED:        "MODEL_NOT_LOADED",
  MODEL_LOAD_FAILED:       "MODEL_LOAD_FAILED",
  MODEL_UNLOAD_FAILED:     "MODEL_UNLOAD_FAILED",
  INFERENCE_FAILED:        "INFERENCE_FAILED",
  INFERENCE_CANCELLED:     "INFERENCE_CANCELLED",
  INFERENCE_TIMEOUT:       "INFERENCE_TIMEOUT",
  CONTEXT_TOO_LARGE:       "CONTEXT_TOO_LARGE",
  STREAM_EMIT_FAILED:      "STREAM_EMIT_FAILED",
  PROVIDER_AUTH_FAILED:    "PROVIDER_AUTH_FAILED",
  PROVIDER_RATE_LIMITED:   "PROVIDER_RATE_LIMITED",
  PROVIDER_UNAVAILABLE:    "PROVIDER_UNAVAILABLE",
  INVALID_RUNNER_CONFIG:   "INVALID_RUNNER_CONFIG",
  RUNNER_BUSY:             "RUNNER_BUSY",
  RUN_NOT_FOUND:           "RUN_NOT_FOUND",
} as const;
export type ModelErrorCode = (typeof ModelErrorCode)[keyof typeof ModelErrorCode];

// ─── Model meta ───────────────────────────────────────────────────────────────

export interface ModelMeta {
  /** Unique model identifier — "phi3-mini-q4", "claude-haiku", vb. */
  readonly key: ModelKey;
  /** İnsan-okunur görünen ad */
  readonly displayName: string;
  /** offline | cloud */
  readonly variant: RunnerVariant;
  /** Maksimum context token sayısı */
  readonly contextWindow: number;
  /** GGUF dosyasının disk boyutu (offline) veya 0 (cloud) */
  readonly diskSizeBytes: number;
  /** Quant türü — "Q4_K_M", "F16", "API" */
  readonly quantization: string;
  /**
   * Offline: GGUF dosyasının mutlak path'i — LlamaCppRunner.load() tarafından kullanılır.
   * Cloud: null.
   * Config'den ayrı tutulur; runner konfigürasyonu değişmeden model taşınabilir.
   */
  readonly modelPath: string | null;
}

// ─── Message type (shared) ────────────────────────────────────────────────────

export type RunMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// ─── Run options ──────────────────────────────────────────────────────────────

export interface RunOptions {
  /**
   * Akıllı iptal tokeni — abort() çağrısı aktif inference'ı durdurur.
   * `cancel(runId)` ile eşdeğerdir; ikisi birlikte kullanılabilir.
   */
  signal?: AbortSignal;
  /**
   * Kısmi token streami için callback.
   * Hata durumunda çağrılmaz; `run()` Result<RunResult> döner.
   */
  onToken?: (chunk: string) => void;
  /** ms cinsinden inference timeout — yoksa runner default'u kullanır */
  timeoutMs?: number;
}

// ─── Run request / response ───────────────────────────────────────────────────

export interface RunRequest {
  /**
   * `PromptBuilder.build()` çıktısından gelen mesajlar.
   * Offline: tek user mesajı. Cloud: system + history + user.
   */
  messages: ReadonlyArray<RunMessage>;
  /** İstenen model */
  modelKey: ModelKey;
  /** 0–1 arası yaratıcılık seviyesi */
  temperature?: number;
  /** Maksimum üretilecek token sayısı */
  maxTokens?: number;
}

export interface RunResult {
  /** Tam yanıt metni (stream tamamlandıktan sonra) */
  readonly text: string;
  /**
   * Bu run'ın benzersiz kimliği.
   * Run tamamlandıktan sonra da saklanabilir; geçmişte cancel() artık no-op olur.
   */
  readonly runId: RunId;
  /** Kullanılan giriş token sayısı (best-effort — model sağlıyorsa) */
  readonly inputTokens: number | null;
  /** Üretilen çıkış token sayısı */
  readonly outputTokens: number | null;
  /** İnference süresi ms */
  readonly latencyMs: number;
  /** Kullanılan gerçek model anahtarı (fallback olabilir) */
  readonly usedModelKey: ModelKey;
}

// ─── Load / unload state ──────────────────────────────────────────────────────

export const LoadState = {
  UNLOADED:  "unloaded",
  LOADING:   "loading",
  READY:     "ready",
  UNLOADING: "unloading",
  ERROR:     "error",
} as const;
export type LoadState = (typeof LoadState)[keyof typeof LoadState];

export interface ILoadStateReader {
  readonly loadState: LoadState;
}

// ─── Token estimate helper ────────────────────────────────────────────────────

/**
 * Heuristik token tahmini — TokenLimiter (§ 14.4) ile aynı sabit.
 * Runner'lar `estimateTokens()` implementasyonunda bu fonksiyonu çağırır.
 */
export const CHARS_PER_TOKEN = 4;

export function estimateMessageTokens(messages: ReadonlyArray<RunMessage>): number {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

// ─── IModelRunner ─────────────────────────────────────────────────────────────

/**
 * Offline (llama.cpp) ve cloud (API) runner'larının ortak sözleşmesi.
 *
 * § 1: Tüm async çağrılar `Result<T>` döner.
 * § 3: `run()` stream sırasında EventBus emit etmez — callback kullanır.
 *
 * Concurrency:
 *   `maxConcurrentRuns` runner'ın paralel inference kapasitesini belirtir.
 *   Offline llama.cpp → 1. Cloud runner → N (config'e bağlı).
 *   Limit aşılırsa `run()` → `RUNNER_BUSY`.
 */
export interface IModelRunner extends ILoadStateReader {
  /** Bu runner'ın desteklediği model meta listesi */
  readonly supportedModels: ReadonlyArray<ModelMeta>;

  /** Runner'ın variant türü */
  readonly variant: RunnerVariant;

  /**
   * Maksimum eş zamanlı inference sayısı.
   * Offline: 1. Cloud: yapılandırmaya bağlı (default 4).
   */
  readonly maxConcurrentRuns: number;

  /** Şu anda çalışan run ID'lerinin anlık kümesi (snapshot) */
  readonly activeRunIds: ReadonlySet<RunId>;

  /**
   * Modeli belleğe yükle (offline: GGUF mmap; cloud: no-op).
   * Zaten READY ise `ok(void)` döner (idempotent).
   */
  load(key: ModelKey): Promise<Result<void>>;

  /**
   * Modeli bellekten boşalt (offline: weights serbest; cloud: no-op).
   * Aktif inference tamamlanana kadar bekler.
   */
  unload(key: ModelKey): Promise<Result<void>>;

  /**
   * Inference başlatır.
   * Dönen `RunResult.runId` ile çağrı tarafında iptal mümkündür:
   *   const res = await runner.run(req);
   *   if (res.ok) await runner.cancel(res.data.runId);
   *
   * `options.onToken` verilirse streaming; verilmezse tam yanıt beklenir.
   * `options.signal.abort()` veya `cancel(runId)` → INFERENCE_CANCELLED.
   */
  run(request: RunRequest, options?: RunOptions): Promise<Result<RunResult>>;

  /**
   * Belirtilen run'ı iptal eder.
   * Run aktif değilse (tamamlandı / hiç başlamadı) → `RUN_NOT_FOUND`.
   * İptal zaten tetiklendiyse → `ok(void)` (idempotent).
   */
  cancel(id: RunId): Promise<Result<void>>;

  /**
   * Mesaj listesinin tahmini token maliyetini döner.
   * `run()` öncesi bütçe kontrolü ve CONTEXT_TOO_LARGE guard için kullanılır.
   * Offline: CHARS_PER_TOKEN heuristiği. Cloud: aynı heuristik (API maliyet tahmini).
   */
  estimateTokens(messages: ReadonlyArray<RunMessage>): number;

  /**
   * Runner sağlıklı mı? (offline: model dosyası erişilebilir mi; cloud: API ping)
   * Periyodik health-check için kullanılır.
   */
  healthCheck(): Promise<Result<void>>;

  /**
   * Tüm kaynakları serbest bırak. Sonraki `run()` çağrısı hata döner.
   * AppContainer dispose zincirinde çağrılır.
   */
  dispose(): Promise<void>;
}
