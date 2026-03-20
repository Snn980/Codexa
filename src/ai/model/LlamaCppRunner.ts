/**
 * ai/model/LlamaCppRunner.ts
 *
 * llama.cpp React Native bridge üzerinden offline inference.
 * Phase 5.1 — Model Loader (rev 2)
 *
 * Düzeltmeler (rev 2):
 *  • _activeRuns: Map<RunId, AbortController>  — branded RunId, çoklu run hazır
 *  • Prompt büyüklüğü kontrolü: estimateTokens() ≥ contextWindow → CONTEXT_TOO_LARGE
 *  • fullText çakışması: callback'te biriken text kullanılır, completion.text EZİLMEZ
 *    (llama.rn completion.text = bridge'in döndürdüğü tam metin; streaming sırasında
 *     callback chunk'ları ile biriktirilir — bridge davranışı tutarsız olduğundan
 *     callback verisi canonical kabul edilir, bridge sonucu sadece token sayıları için)
 *  • maxConcurrentRuns = 1 (offline)
 *  • cancel(RunId) implementasyonu
 *  • ModelMeta.modelPath — config map kaldırıldı, meta'dan alınır
 *
 * Kural referansları:
 *  § 1  Result<T> / ok() / err() / tryResultAsync()
 *  § 5  IPC: runner worker'a taşındığında (T-12) bu interface değişmez
 *  § 8  Mutable state → sınıf field'larında _prefix
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
  CHARS_PER_TOKEN,
  estimateMessageTokens,
  modelKey,
  runId,
} from "./IModelRunner";
import type { Result } from "../../core/Result";
import { ok, err, tryResultAsync } from "../../core/Result";

// ─── Bridge interface (DI — test isolation) ────────────────────────────────

export interface ILlamaCompletionToken {
  text: string;
  done: boolean;
}

export interface ILlamaContextHandle {
  completion(
    params: LlamaCompletionParams,
    onToken: (token: ILlamaCompletionToken) => void,
  ): Promise<LlamaCompletionResult>;
  stopCompletion(): Promise<void>;
  release(): Promise<void>;
}

export interface LlamaCompletionParams {
  prompt: string;
  n_predict: number;
  temperature: number;
  stop?: string[];
}

export interface LlamaCompletionResult {
  /** Bridge'in döndürdüğü tam metin — token sayıları için kullanılır, text için DEĞİL */
  text: string;
  timings: {
    prompt_n: number;
    predicted_n: number;
    prompt_ms: number;
    predicted_ms: number;
  };
}

export interface ILlamaBridge {
  loadModel(
    modelPath: string,
    params: { n_ctx: number; n_threads: number; use_mlock: boolean },
  ): Promise<ILlamaContextHandle>;

  getModelInfo(modelPath: string): Promise<{ contextLength: number; description: string }>;
}

// ─── Config ────────────────────────────────────────────────────────────────

export interface LlamaCppRunnerConfig {
  /** Thread sayısı — CPU core sayısının yarısı önerilir */
  numThreads?: number;
  /** KV-cache için context penceresi (token) */
  contextSize?: number;
  /** Inference timeout ms (default 60_000) */
  defaultTimeoutMs?: number;
  /** mlock: model bellekten swap edilmesin (low-RAM cihazlarda false) */
  useMlock?: boolean;
}

// ─── Supported models ──────────────────────────────────────────────────────
// ModelMeta.modelPath alanı config'den değil meta'dan gelir.

const OFFLINE_MODELS: ReadonlyArray<ModelMeta> = [
  {
    key: modelKey("codegemma-2b-q4km"),
    displayName: "CodeGemma 2B (Q4_K_M)",
    variant: RunnerVariant.OFFLINE,
    contextWindow: 8192,
    diskSizeBytes: 1_468_006_400, // ~1.4 GB
    quantization: "Q4_K_M",
    modelPath: null, // Runtime'da setModelPath() ile doldurulur
  },
  {
    key: modelKey("phi3-mini-q4"),
    displayName: "Phi-3 Mini (Q4)",
    variant: RunnerVariant.OFFLINE,
    contextWindow: 4096,
    diskSizeBytes: 2_202_009_600, // ~2.1 GB
    quantization: "Q4",
    modelPath: null,
  },
];

// ─── Active run tracking ───────────────────────────────────────────────────

interface ActiveRun {
  readonly controller: AbortController;
  /** Run başlangıç zamanı — timeout hesabı için */
  readonly startedAt: number;
}

// ─── LlamaCppRunner ────────────────────────────────────────────────────────

export class LlamaCppRunner implements IModelRunner {
  readonly variant = RunnerVariant.OFFLINE;

  /**
   * Offline llama.cpp tek thread'li — aynı anda 1 inference.
   * maxConcurrentRuns = 1
   */
  readonly maxConcurrentRuns = 1;

  /** modelPath runtime'da inject edilebilir — meta immutable olduğundan Map tutulur */
  private readonly _modelPaths = new Map<ModelKey, string>();
  private readonly _supportedModels: ModelMeta[];

  private _loadState: LoadState = LoadState.UNLOADED;
  private _loadedKey: ModelKey | null = null;
  private _handle: ILlamaContextHandle | null = null;

  /** RunId → ActiveRun — maxConcurrentRuns=1 ama Map ile hazır */
  private readonly _activeRuns = new Map<RunId, ActiveRun>();

  private _disposed = false;

  private readonly _bridge: ILlamaBridge;
  private readonly _cfg: Required<LlamaCppRunnerConfig>;

  constructor(bridge: ILlamaBridge, config: LlamaCppRunnerConfig = {}) {
    this._bridge = bridge;
    this._cfg = {
      numThreads:       config.numThreads       ?? 4,
      contextSize:      config.contextSize       ?? 4096,
      defaultTimeoutMs: config.defaultTimeoutMs  ?? 60_000,
      useMlock:         config.useMlock          ?? false,
    };
    // Mutable kopyasını tut — setModelPath() ekleyebilsin
    this._supportedModels = OFFLINE_MODELS.map((m) => ({ ...m }));
  }

  // ─── supportedModels (güncel path'lerle) ───────────────────────────────

  get supportedModels(): ReadonlyArray<ModelMeta> {
    return this._supportedModels.map((m) => ({
      ...m,
      modelPath: this._modelPaths.get(m.key) ?? null,
    }));
  }

  // ─── Model path injection ──────────────────────────────────────────────

  /**
   * GGUF dosya path'ini runtime'da inject et.
   * AppContainer init sırasında veya kullanıcı model indirdikten sonra çağrılır.
   */
  setModelPath(key: ModelKey, path: string): Result<void> {
    const exists = this._supportedModels.some((m) => m.key === key);
    if (!exists) {
      return err(ModelErrorCode.INVALID_RUNNER_CONFIG, `Unknown model key: ${key}`);
    }
    this._modelPaths.set(key, path);
    return ok(undefined);
  }

  // ─── ILoadStateReader ──────────────────────────────────────────────────

  get loadState(): LoadState {
    return this._loadState;
  }

  // ─── activeRunIds ──────────────────────────────────────────────────────

  get activeRunIds(): ReadonlySet<RunId> {
    return new Set(this._activeRuns.keys());
  }

  // ─── estimateTokens ────────────────────────────────────────────────────

  estimateTokens(messages: ReadonlyArray<RunMessage>): number {
    return estimateMessageTokens(messages);
  }

  // ─── load ──────────────────────────────────────────────────────────────

  async load(key: ModelKey): Promise<Result<void>> {
    if (this._disposed) {
      return err(ModelErrorCode.MODEL_LOAD_FAILED, "Runner disposed");
    }
    if (this._loadState === LoadState.READY && this._loadedKey === key) {
      return ok(undefined);
    }
    if (this._loadState === LoadState.LOADING || this._loadState === LoadState.UNLOADING) {
      return err(ModelErrorCode.RUNNER_BUSY, `Runner is ${this._loadState}`);
    }

    const modelPath = this._modelPaths.get(key);
    if (!modelPath) {
      return err(
        ModelErrorCode.MODEL_NOT_LOADED,
        `Model path not set for key: ${key}. Call setModelPath() first.`,
        { context: { key } },
      );
    }

    // Farklı model yüklüyse önce boşalt
    if (this._handle !== null) {
      const unloadResult = await this.unload(this._loadedKey!);
      if (!unloadResult.ok) return unloadResult;
    }

    this._loadState = LoadState.LOADING;

    const result = await tryResultAsync(
      async () => {
        const handle = await this._bridge.loadModel(modelPath, {
          n_ctx:      this._cfg.contextSize,
          n_threads:  this._cfg.numThreads,
          use_mlock:  this._cfg.useMlock,
        });
        this._handle     = handle;
        this._loadedKey  = key;
        this._loadState  = LoadState.READY;
      },
      ModelErrorCode.MODEL_LOAD_FAILED,
      `Failed to load model: ${key}`,
    );

    if (!result.ok) this._loadState = LoadState.ERROR;
    return result;
  }

  // ─── unload ────────────────────────────────────────────────────────────

  async unload(key: ModelKey): Promise<Result<void>> {
    if (this._disposed) return ok(undefined);
    if (this._loadedKey !== key || this._handle === null) return ok(undefined);
    if (this._loadState === LoadState.UNLOADING) {
      return err(ModelErrorCode.RUNNER_BUSY, "Already unloading");
    }

    this._loadState = LoadState.UNLOADING;

    const result = await tryResultAsync(
      async () => {
        await this._handle!.release();
        this._handle    = null;
        this._loadedKey = null;
        this._loadState = LoadState.UNLOADED;
      },
      ModelErrorCode.MODEL_UNLOAD_FAILED,
      `Failed to unload model: ${key}`,
    );

    if (!result.ok) this._loadState = LoadState.ERROR;
    return result;
  }

  // ─── run ───────────────────────────────────────────────────────────────

  async run(request: RunRequest, options: RunOptions = {}): Promise<Result<RunResult>> {
    if (this._disposed) {
      return err(ModelErrorCode.INFERENCE_FAILED, "Runner disposed");
    }
    if (this._loadState !== LoadState.READY || this._handle === null) {
      return err(
        ModelErrorCode.MODEL_NOT_LOADED,
        `Model not loaded. State: ${this._loadState}`,
      );
    }
    if (this._activeRuns.size >= this.maxConcurrentRuns) {
      return err(ModelErrorCode.RUNNER_BUSY, "Inference already in progress");
    }

    const { signal, onToken, timeoutMs = this._cfg.defaultTimeoutMs } = options;

    if (signal?.aborted) {
      return err(ModelErrorCode.INFERENCE_CANCELLED, "Cancelled before start");
    }

    // ── Prompt büyüklüğü kontrolü ──────────────────────────────────────
    const estimatedInputTokens = this.estimateTokens(request.messages);
    const modelMeta = this.supportedModels.find((m) => m.key === request.modelKey);
    const contextWindow = modelMeta?.contextWindow ?? this._cfg.contextSize;
    const maxOutputTokens = request.maxTokens ?? 512;

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

    // Dış signal → iç controller
    const onExternalAbort = () => runController.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });

    // Timeout
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        runController.abort();
      }, timeoutMs);
    }

    const startMs = Date.now();

    // ── Prompt ────────────────────────────────────────────────────────
    const prompt = this._buildPrompt(request);

    // ── fullText: SADECE callback chunk'larından birikir ───────────────
    // completion.text bridge'in kendi biriktirmesi — davranış tutarsız
    // olabilir (bazı llama.rn sürümleri son token'ı duplicate eder).
    // Canonical metin: callback'te el ile biriktirilen `callbackText`.
    let callbackText = "";
    let inputTokens:  number | null = null;
    let outputTokens: number | null = null;

    const result = await tryResultAsync(
      async () => {
        if (runController.signal.aborted) throw new _AbortError("Cancelled");

        const completion = await this._handle!.completion(
          {
            prompt,
            n_predict:   maxOutputTokens,
            temperature: request.temperature ?? 0.2,
            stop:        ["<|end|>", "<|im_end|>", "=== USER REQUEST ==="],
          },
          (token) => {
            if (runController.signal.aborted) return;
            // ↓ callbackText'e ekle — completion.text'i EZmiyoruz
            callbackText += token.text;
            onToken?.(token.text);
          },
        );

        // Token sayıları bridge'den, metin callback'ten
        inputTokens  = completion.timings.prompt_n;
        outputTokens = completion.timings.predicted_n;
        // completion.text'e DOKUNMUYORUZ — canonical = callbackText
      },
      ModelErrorCode.INFERENCE_FAILED,
      "Inference failed",
    );

    // ── Cleanup ────────────────────────────────────────────────────────
    signal?.removeEventListener("abort", onExternalAbort);
    if (timeoutId !== null) clearTimeout(timeoutId);
    this._activeRuns.delete(id);

    // Best-effort stop
    if (runController.signal.aborted && this._handle) {
      await this._handle.stopCompletion().catch(() => {});
    }

    // ── Error classification ───────────────────────────────────────────
    if (!result.ok) {
      if (timedOut) {
        return err(ModelErrorCode.INFERENCE_TIMEOUT, `Inference timed out after ${timeoutMs}ms`);
      }
      if (signal?.aborted || runController.signal.aborted) {
        return err(ModelErrorCode.INFERENCE_CANCELLED, "Inference cancelled");
      }
      return result;
    }

    return ok<RunResult>({
      runId:        id,
      text:         callbackText,   // ← callback'ten gelen canonical metin
      inputTokens,
      outputTokens,
      latencyMs:    Date.now() - startMs,
      usedModelKey: request.modelKey,
    });
  }

  // ─── cancel ────────────────────────────────────────────────────────────

  async cancel(id: RunId): Promise<Result<void>> {
    const activeRun = this._activeRuns.get(id);
    if (!activeRun) {
      return err(ModelErrorCode.RUN_NOT_FOUND, `Run not found: ${id}`, { context: { id } });
    }
    if (activeRun.controller.signal.aborted) {
      // Zaten iptal edilmiş — idempotent
      return ok(undefined);
    }
    activeRun.controller.abort();
    return ok(undefined);
  }

  // ─── estimateTokens ────────────────────────────────────────────────────
  // (yukarıda implement edildi)

  // ─── healthCheck ───────────────────────────────────────────────────────

  async healthCheck(): Promise<Result<void>> {
    if (this._disposed) return err(ModelErrorCode.INFERENCE_FAILED, "Runner disposed");

    const missing: ModelKey[] = [];

    for (const [key, path] of this._modelPaths) {
      const infoResult = await tryResultAsync(
        () => this._bridge.getModelInfo(path),
        ModelErrorCode.MODEL_NOT_LOADED,
        `Model file not accessible: ${key}`,
      );
      if (!infoResult.ok) missing.push(key);
    }

    if (missing.length > 0) {
      return err(
        ModelErrorCode.MODEL_NOT_LOADED,
        `Missing model files: ${missing.join(", ")}`,
        { context: { missing } },
      );
    }

    return ok(undefined);
  }

  // ─── dispose ───────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;

    // Aktif run'ları iptal et
    for (const [, run] of this._activeRuns) {
      run.controller.abort();
    }
    this._activeRuns.clear();

    if (this._handle !== null) {
      await this._handle.release().catch(() => {});
      this._handle = null;
    }

    this._loadState = LoadState.UNLOADED;
    this._loadedKey = null;
  }

  // ─── private ───────────────────────────────────────────────────────────

  /**
   * Mesaj listesini offline single-string prompt'a çevirir.
   * PromptBuilder offline varyantı zaten tek user mesajı üretir;
   * burada defensif olarak tüm roller işlenir.
   */
  private _buildPrompt(request: RunRequest): string {
    return request.messages
      .map((m) => {
        if (m.role === "system")    return `<|system|>\n${m.content}<|end|>`;
        if (m.role === "assistant") return `<|assistant|>\n${m.content}<|end|>`;
        return `<|user|>\n${m.content}<|end|>`;
      })
      .join("\n");
  }
}

// ─── Internal abort error marker ──────────────────────────────────────────

class _AbortError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AbortError";
  }
}
