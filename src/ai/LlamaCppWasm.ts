/**
 * ai/LlamaCppWasm.ts — llama.rn native binding adapter
 *
 * REFACTOR: llama-cpp-wasm (WASM, npm'de yok) → llama.rn (Native C++ binding)
 *
 * Neden llama.rn?
 *   • llama-cpp-wasm npm'de mevcut değil / bulunamıyor
 *   • llama.rn: aynı llama.cpp C++ çekirdeği, native JSI bridge
 *   • GGUF model formatı korunur — model migration gerekmez
 *   • iOS: Metal GPU (Apple7+), Android: OpenCL (Adreno 700+) / HTP
 *   • Expo config plugin desteği (app.json entegrasyonu)
 *   • Aktif bakım: mybigday/llama.rn, npm 0.11.2
 *
 * Önceki WASM API → llama.rn API eşlemesi:
 *   load_model()      → initLlama({ model: path, ... })
 *   create_context()  → initLlama() döner (context = handle)
 *   get_next_token()  → context.completion({ prompt }, onToken)
 *   free_context()    → context.release()
 *   FS_writeFile()    → kullanılmıyor (native file system)
 *
 * § 1  Result<T>
 * § 11 Expo asset load — WASM değil GGUF file path
 */

import type { ILlamaCppBinding, ILlamaCppLoader } from "./OfflineRuntime";
import { getChatTemplate } from "./ChatTemplate";
import type { AIModelId } from "./AIModels";

// ─── llama.rn tip tanımları ───────────────────────────────────────────────────

export interface LlamaRnCompletionToken {
  token: string;
}

export interface LlamaRnTimings {
  prompt_n: number;
  predicted_n: number;
  prompt_ms: number;
  predicted_ms: number;
}

export interface LlamaRnCompletionResult {
  text: string;
  timings: LlamaRnTimings;
}

export interface LlamaRnContext {
  completion(
    params: {
      messages?: Array<{ role: string; content: string }>;
      prompt?: string;
      n_predict: number;
      temperature: number;
      stop?: string[];
    },
    onToken: (data: LlamaRnCompletionToken) => void,
  ): Promise<LlamaRnCompletionResult>;
  stopCompletion(): Promise<void>;
  release(): Promise<void>;
}

export interface LlamaRnInitParams {
  model: string;
  use_mlock?: boolean;
  n_ctx?: number;
  n_threads?: number;
  n_gpu_layers?: number;
}

export type InitLlamaFn = (params: LlamaRnInitParams) => Promise<LlamaRnContext>;

// ─── LlamaRnBinding — ILlamaCppBinding impl ───────────────────────────────────

class LlamaRnBinding implements ILlamaCppBinding {
  private readonly _initLlama: InitLlamaFn;
  private readonly _modelId: AIModelId;
  private readonly _cfg: {
    n_ctx: number;
    n_threads: number;
    n_gpu_layers: number;
    use_mlock: boolean;
  };
  private _context: LlamaRnContext | null = null;
  private _disposed = false;

  constructor(
    initLlama: InitLlamaFn,
    modelId: AIModelId,
    config: {
      n_ctx?: number;
      n_threads?: number;
      n_gpu_layers?: number;
      use_mlock?: boolean;
    } = {},
  ) {
    this._initLlama = initLlama;
    this._modelId   = modelId;
    this._cfg       = {
      n_ctx:        config.n_ctx        ?? 4096,
      n_threads:    config.n_threads    ?? 4,
      n_gpu_layers: config.n_gpu_layers ?? 1, // 1 = Metal/OpenCL açık
      use_mlock:    config.use_mlock    ?? false,
    };
  }

  async loadModel(modelPath: string): Promise<void> {
    if (this._disposed) throw new Error("LlamaRnBinding: already disposed");
    if (this._context !== null) {
      await this._context.release().catch(() => {});
      this._context = null;
    }
    this._context = await this._initLlama({
      model:        modelPath,
      n_ctx:        this._cfg.n_ctx,
      n_threads:    this._cfg.n_threads,
      n_gpu_layers: this._cfg.n_gpu_layers,
      use_mlock:    this._cfg.use_mlock,
    });
  }

  tokenize(text: string): number[] {
    // Byte-level proxy — gerçek token sayısı timings.prompt_n'den alınır
    return Array.from(new TextEncoder().encode(text));
  }

  async *nextToken(
    contextTokens: number[],
    maxNewTokens: number,
    signal: AbortSignal,
    stopTokens?: readonly string[],
  ): AsyncGenerator<string, void, unknown> {
    if (this._context === null) throw new Error("Model not loaded. Call loadModel() first.");
    if (this._disposed) return;

    const template   = getChatTemplate(this._modelId);
    const finalStops = [
      ...template.stopTokens,
      ...(stopTokens ?? []),
      "<|end|>", "<|im_end|>", "</s>", "<|EOT|>",
    ];

    const promptText = new TextDecoder().decode(new Uint8Array(contextTokens));

    const tokenQueue: string[] = [];
    let completionDone = false;
    let completionError: unknown = null;

    const completionPromise = this._context.completion(
      { prompt: promptText, n_predict: maxNewTokens, temperature: 0.7, stop: finalStops },
      (data) => {
        if (!signal.aborted && data.token) tokenQueue.push(data.token);
      },
    ).then(() => {
      completionDone = true;
    }).catch((e: unknown) => {
      completionError = e;
      completionDone  = true;
    });

    while (true) {
      if (signal.aborted) {
        await this._context.stopCompletion().catch(() => {});
        return;
      }
      while (tokenQueue.length > 0) {
        const token = tokenQueue.shift()!;
        if (token) yield token;
      }
      if (completionDone) break;
      await new Promise<void>((r) => setTimeout(r, 0));
    }

    await completionPromise;
    if (completionError) throw completionError;
  }

  free(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._context !== null) {
      this._context.release().catch(() => {});
      this._context = null;
    }
  }
}

// ─── ExpoLlamaCppLoader ───────────────────────────────────────────────────────

/**
 * llama.rn kullanarak ILlamaCppBinding üretir.
 *
 * Kullanım (AppContainer):
 *   const loader = new ExpoLlamaCppLoader(AIModelId.OFFLINE_GEMMA3_1B);
 *   const runtime = new OfflineRuntime(loader);
 *
 * Gereksinimler:
 *   • Expo Dev Client (npx expo run:ios / run:android)
 *   • app.json'da llama.rn config plugin (aşağıda)
 *   • iOS: iOS 15.1+, Metal-capable GPU (Apple7+)
 *   • Android: arm64-v8a, API 24+
 */
export class ExpoLlamaCppLoader implements ILlamaCppLoader {
  private readonly _modelId: AIModelId;
  private readonly _config: {
    n_ctx?: number;
    n_threads?: number;
    n_gpu_layers?: number;
    use_mlock?: boolean;
  };

  constructor(
    modelId: AIModelId,
    config: {
      n_ctx?: number;
      n_threads?: number;
      /** 0 = CPU-only, 1+ = Metal (iOS) veya OpenCL (Android) */
      n_gpu_layers?: number;
      use_mlock?: boolean;
    } = {},
  ) {
    this._modelId = modelId;
    this._config  = config;
  }

  async loadBinding(): Promise<ILlamaCppBinding> {
    // Expo Dev Client ile çalışır — Expo Go DESTEKLEMİYOR
    const { initLlama } = await import("llama.rn");
    return new LlamaRnBinding(initLlama as InitLlamaFn, this._modelId, this._config);
  }
}

// ─── LlamaRnBridgeAdapter — LlamaCppRunner.ILlamaBridge uyumluluğu ───────────

/**
 * LlamaCppRunner'ın ILlamaBridge interface'ini llama.rn ile implemente eder.
 *
 * Kullanım (AppContainer):
 *   const bridge = new LlamaRnBridgeAdapter();
 *   const runner = new LlamaCppRunner(bridge, config);
 *
 * Not: LlamaCppRunner zaten doğru ILlamaBridge interface kullanıyor.
 * Bu adapter sadece llama.rn → ILlamaBridge dönüşümü yapar.
 */
export class LlamaRnBridgeAdapter {
  private _initLlamaFn: InitLlamaFn | null = null;

  private async _getInitLlama(): Promise<InitLlamaFn> {
    if (!this._initLlamaFn) {
      const mod = await import("llama.rn");
      this._initLlamaFn = mod.initLlama as InitLlamaFn;
    }
    return this._initLlamaFn;
  }

  async loadModel(
    modelPath: string,
    params: { n_ctx: number; n_threads: number; use_mlock: boolean },
  ): Promise<LlamaRnContext> {
    const initLlama = await this._getInitLlama();
    return initLlama({
      model:        modelPath,
      n_ctx:        params.n_ctx,
      n_threads:    params.n_threads,
      n_gpu_layers: 1,
      use_mlock:    params.use_mlock,
    });
  }

  async getModelInfo(
    modelPath: string,
  ): Promise<{ contextLength: number; description: string }> {
    const { loadLlamaModelInfo } = await import("llama.rn");
    const info = await (
      loadLlamaModelInfo as (path: string) => Promise<Record<string, unknown>>
    )(modelPath);
    return {
      contextLength: (info?.n_ctx_train as number) ?? 4096,
      description:   (info?.desc as string)        ?? "llama.rn model",
    };
  }
}

// ─── WasmBootstrap stub — geriye dönük uyumluluk ─────────────────────────────

/**
 * @deprecated WASM artık kullanılmıyor. llama.rn native binding kullanın.
 * Bu sınıf sadece geriye dönük import uyumluluğu için bırakıldı.
 */
export class WasmBootstrap {
  /** @deprecated */
  static async load(_wasmAssetUri: string): Promise<never> {
    throw new Error(
      "WasmBootstrap.load() deprecated. llama.rn native binding kullanın: ExpoLlamaCppLoader",
    );
  }
  /** @deprecated */
  static clearCache(): void { /* no-op */ }
}

// ─── Mock (test) ──────────────────────────────────────────────────────────────

export { MockLlamaCppLoader } from "./OfflineRuntime";
