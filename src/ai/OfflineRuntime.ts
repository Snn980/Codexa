/**
 * ai/OfflineRuntime.ts — llama.cpp WASM adapter
 *
 * § 1  : Result<T>
 * § 11 : Expo asset WASM load
 *
 * DÜZELTME #4 — getChatTemplate gereksiz çift çağrı:
 *   ❌ const template = getChatTemplate(request.modelId);   // çağrı 1
 *      const prompt   = this._buildPrompt(messages, modelId); // _buildPrompt içinde çağrı 2
 *      → Her request için 2x Map lookup
 *
 *   ✅ _buildPrompt() kaldırıldı.
 *      streamChat içinde tek getChatTemplate() çağrısı:
 *        const template = getChatTemplate(request.modelId);
 *        const prompt   = template.buildPrompt(request.messages);
 *      template.stopTokens → binding.nextToken'a iletilir.
 *
 * T-P9-2 KAPANDI: model-specific template + injection guard + stop tokens.
 */

import { ok, err }          from "../core/Result";
import type { Result }      from "../core/Result";
import type {
  IAIWorkerRuntime,
  RuntimeChatRequest,
  StreamResult,
}                           from "./IAIWorkerRuntime";
import { RuntimeErrorCode } from "./IAIWorkerRuntime";
import type { AIModelId }   from "./AIModels";
import { getChatTemplate }  from "./ChatTemplate";

// ─── LRU-2 Tokenize Cache ─────────────────────────────────────────────────────

class TokenizeCache {
  private readonly _max: number;
  private readonly _map = new Map<string, number[]>();
  constructor(max = 2) { this._max = max; }
  get(key: string) { return this._map.get(key); }
  set(key: string, value: number[]) {
    if (this._map.has(key)) this._map.delete(key);
    if (this._map.size >= this._max) this._map.delete(this._map.keys().next().value!);
    this._map.set(key, value);
  }
  clear() { this._map.clear(); }
}

// ─── Binding arayüzü ─────────────────────────────────────────────────────────

export interface ILlamaCppBinding {
  loadModel(modelPath: string): Promise<void>;
  tokenize(text: string): number[];
  nextToken(
    contextTokens: number[],
    maxNewTokens:  number,
    signal:        AbortSignal,
    stopTokens?:   readonly string[],
  ): AsyncGenerator<string, void, unknown>;
  free(): void;
}

export interface ILlamaCppLoader {
  loadBinding(): Promise<ILlamaCppBinding>;
}

// ─── ExpoLlamaCppLoader ───────────────────────────────────────────────────────
// llama.rn native binding — WASM artık kullanılmıyor.
// Gerçek implementasyon LlamaCppWasm.ts'te; bu sınıf ona delege eder.

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
      /** 0 = CPU-only, 1+ = Metal (iOS) / OpenCL (Android) */
      n_gpu_layers?: number;
      use_mlock?: boolean;
    } = {},
  ) {
    this._modelId = modelId;
    this._config  = config;
  }

  async loadBinding(): Promise<ILlamaCppBinding> {
    // llama.rn — Expo Dev Client gerektirir (Expo Go desteklemez)
    const { ExpoLlamaCppLoader: LlamaRnLoader } = await import("./LlamaCppWasm");
    const inner = new LlamaRnLoader(this._modelId, this._config);
    return inner.loadBinding();
  }
}

// ─── MockLlamaCppLoader ───────────────────────────────────────────────────────

export class MockLlamaCppLoader implements ILlamaCppLoader {
  private readonly _tokens:  string[];
  private readonly _delayMs: number;
  constructor(tokens: string[] = ["Hello", " ", "world", "!"], delayMs = 0) {
    this._tokens  = tokens;
    this._delayMs = delayMs;
  }
  async loadBinding(): Promise<ILlamaCppBinding> {
    const tokens  = this._tokens;
    const delayMs = this._delayMs;
    return {
      async loadModel() { /* no-op */ },
      tokenize: (text) => text.split(" ").map((_, i) => i),
      async *nextToken(
        _ctx, maxNew, signal, stopTokens,
      ): AsyncGenerator<string, void, unknown> {
        const stopSet = new Set(stopTokens ?? []);
        let generated = "";
        const limit   = Math.min(tokens.length, maxNew);
        for (let i = 0; i < limit; i++) {
          if (signal.aborted) return;
          if (delayMs > 0) {
            await new Promise<void>((res) => {
              const t = setTimeout(res, delayMs);
              signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
            });
            if (signal.aborted) return;
          }
          const token = tokens[i];
          generated += token;
          let stopped = false;
          for (const stop of stopSet) {
            if (generated.endsWith(stop)) { stopped = true; break; }
          }
          if (stopped) return;
          yield token;
        }
      },
      free() { /* no-op */ },
    };
  }
}

// ─── Load state ───────────────────────────────────────────────────────────────

type LoadState =
  | { status: "idle" }
  | { status: "loading"; promise: Promise<Result<ILlamaCppBinding>> }
  | { status: "ready";   binding: ILlamaCppBinding; cache: TokenizeCache }
  | { status: "error";   code: string; message: string };

// ─── OfflineRuntime ───────────────────────────────────────────────────────────

export class OfflineRuntime implements IAIWorkerRuntime {
  private readonly _loader: ILlamaCppLoader;
  private readonly _states = new Map<AIModelId, LoadState>();
  private _disposed = false;

  constructor(loader: ILlamaCppLoader) { this._loader = loader; }

  isReady(modelId: AIModelId): boolean {
    return this._states.get(modelId)?.status === "ready";
  }

  async *streamChat(
    request: RuntimeChatRequest,
  ): AsyncGenerator<string, Result<StreamResult>, unknown> {
    if (this._disposed) return err(RuntimeErrorCode.UNKNOWN, "OfflineRuntime disposed");

    const bindingResult = await this._ensureLoaded(request.modelId, request.apiModelId);
    if (!bindingResult.ok) return bindingResult as unknown as Result<StreamResult>;

    const state = this._states.get(request.modelId);
    if (!state || state.status !== "ready")
      return err(RuntimeErrorCode.UNKNOWN, "State inconsistency");

    const { binding, cache } = state;
    if (request.signal.aborted)
      return err(RuntimeErrorCode.REQUEST_ABORTED, "Aborted before inference");

    // ✅ DÜZELTME #4: getChatTemplate tek kez çağrılır
    const template = getChatTemplate(request.modelId);
    const prompt   = template.buildPrompt(request.messages); // ❌ artık _buildPrompt() yok

    // LRU-2 tokenize cache
    let contextTokenIds = cache.get(prompt);
    if (!contextTokenIds) {
      contextTokenIds = binding.tokenize(prompt);
      cache.set(prompt, contextTokenIds);
    }

    let outputTokenCount = 0;
    try {
      for await (const token of binding.nextToken(
        contextTokenIds,
        request.maxTokens,
        request.signal,
        template.stopTokens, // stop token'lar binding'e iletilir
      )) {
        if (request.signal.aborted)
          return err(RuntimeErrorCode.REQUEST_ABORTED, "Aborted during inference");
        if (!token) break;
        outputTokenCount++;
        yield token;
      }
    } catch (e) {
      if (request.signal.aborted)
        return err(RuntimeErrorCode.REQUEST_ABORTED, "Aborted during inference");
      return err(RuntimeErrorCode.UNKNOWN, String(e));
    }

    return ok({ totalTokens: contextTokenIds.length + outputTokenCount });
  }

  // ✅ DÜZELTME #4: _buildPrompt() kaldırıldı — tek çağrı streamChat'te
  // private _buildPrompt(...) — REMOVED

  private async _ensureLoaded(
    modelId: AIModelId, apiModelId: string,
  ): Promise<Result<ILlamaCppBinding>> {
    const state = this._states.get(modelId);
    if (state?.status === "ready")   return ok(state.binding);
    if (state?.status === "error")   return err(state.code, state.message);
    if (state?.status === "loading") return state.promise;
    const promise = this._doLoad(modelId, apiModelId);
    this._states.set(modelId, { status: "loading", promise });
    return promise;
  }

  private async _doLoad(
    modelId: AIModelId, apiModelId: string,
  ): Promise<Result<ILlamaCppBinding>> {
    let binding: ILlamaCppBinding | undefined;
    try {
      binding = await this._loader.loadBinding();
      await binding.loadModel(apiModelId);
      if (this._disposed) { this._safeBindingFree(binding); return err(RuntimeErrorCode.UNKNOWN, "Disposed"); }
      this._states.set(modelId, { status: "ready", binding, cache: new TokenizeCache(2) });
      return ok(binding);
    } catch (e) {
      if (binding) this._safeBindingFree(binding);
      const code = RuntimeErrorCode.WASM_INIT_FAILED;
      const msg  = String(e);
      this._states.set(modelId, { status: "error", code, message: msg });
      return err(code, msg);
    }
  }

  private _safeBindingFree(b: ILlamaCppBinding): void {
    try { b.free(); } catch { /* ignore */ }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const state of this._states.values()) {
      if (state.status === "ready") {
        this._safeBindingFree(state.binding);
        state.cache.clear();
      }
    }
    this._states.clear();
  }
}
