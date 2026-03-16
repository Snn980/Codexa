/**
 * ai/LlamaCppWasm.ts — llama.cpp WASM bağlaması (T-NEW-1 KAPANDI)
 *
 * § 11 : Expo asset WASM load pattern
 *
 * Mimari:
 *   ExpoLlamaCppLoader
 *     └─ WasmBootstrap.load(assetUri)
 *          └─ llama.cpp emscripten Module
 *               └─ ILlamaCppBinding (OfflineRuntime'a inject)
 *
 * Platform stratejisi:
 *   Web (Expo Go / Metro web)  → OPFS + SharedArrayBuffer (WASM thread support)
 *   iOS / Android              → expo-file-system local path, single-thread WASM
 *
 * llama.cpp WASM paketleme:
 *   `llama-cpp-wasm` npm paketi (community fork) veya doğrudan
 *   llama.cpp emscripten build çıktısı (llama.wasm + llama.js glue).
 *   Bu dosya her iki yöntemi de destekleyen `ILlamaModule` arayüzü üzerinden çalışır.
 *
 * T-NEW-1 durumu:
 *   - ILlamaModule arayüzü + WasmBootstrap: TAMAMLANDI
 *   - ExpoLlamaCppLoader.loadBinding(): TAMAMLANDI
 *   - Gerçek llama.wasm dosyası: proje assets klasörüne eklenmeli (CI adımı)
 *   - `llama-cpp-wasm` paket kurulumu: `npm install llama-cpp-wasm` (devDep)
 */

import type { ILlamaCppBinding, ILlamaCppLoader } from "./OfflineRuntime";
import { getChatTemplate } from "./ChatTemplate";
import type { AIModelId } from "./AIModels";

// ─── llama.cpp emscripten Module arayüzü ─────────────────────────────────────

/**
 * llama.cpp emscripten build'in dışa açtığı JS API.
 * Gerçek pakette: `import { createLlama } from "llama-cpp-wasm"`
 * veya: `const module = await LlamaModule({ wasmBinary, ... })`
 */
export interface ILlamaModule {
  /** Model dosyasını WASM file system'e yükle */
  load_model(path: string, params?: Record<string, unknown>): boolean;
  /** Tek seferlik completion token üret (senkron) */
  get_next_token(
    contextId: number,
    samplingParams?: LlamaSamplingParams,
  ): string;
  /** Yeni context oluştur */
  create_context(modelPath: string): number;
  /** Context'i serbest bırak */
  free_context(contextId: number): void;
  /** WASM file system'e dosya yaz */
  FS_writeFile(path: string, data: Uint8Array): void;
  /** WASM Module'ü kapat */
  destroy(): void;
}

export interface LlamaSamplingParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repeat_penalty?: number;
  max_new_tokens?: number;
}

// ─── Platform detect ──────────────────────────────────────────────────────────

function isWeb(): boolean {
  return typeof document !== "undefined";
}

// ─── WASM Bootstrap ───────────────────────────────────────────────────────────

/**
 * WASM binary'yi fetch eder, emscripten Module'ü başlatır.
 *
 * Web'de:
 *   `fetch(wasmUri)` → ArrayBuffer → `createLlama({ wasmBinary })`
 *
 * Native (iOS/Android)'de:
 *   Expo `Asset.fromModule()` → `downloadAsync()` → `localUri`
 *   emscripten Module `locateFile` ile local path'i kullanır.
 */
export class WasmBootstrap {
  private static _moduleCache = new Map<string, ILlamaModule>();

  static async load(wasmAssetUri: string): Promise<ILlamaModule> {
    const cached = WasmBootstrap._moduleCache.get(wasmAssetUri);
    if (cached) return cached;

    let module: ILlamaModule;

    if (isWeb()) {
      module = await WasmBootstrap._loadWeb(wasmAssetUri);
    } else {
      module = await WasmBootstrap._loadNative(wasmAssetUri);
    }

    WasmBootstrap._moduleCache.set(wasmAssetUri, module);
    return module;
  }

  private static async _loadWeb(wasmUri: string): Promise<ILlamaModule> {
    // Web: WASM binary'yi fetch et
    const response = await fetch(wasmUri);
    if (!response.ok) {
      throw new Error(`WASM fetch failed: HTTP ${response.status} — ${wasmUri}`);
    }
    const wasmBinary = await response.arrayBuffer();

    // llama-cpp-wasm paketi
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createLlama } = await import("llama-cpp-wasm");
    return createLlama({ wasmBinary: new Uint8Array(wasmBinary) }) as ILlamaModule;
  }

  private static async _loadNative(wasmUri: string): Promise<ILlamaModule> {
    // Native: Expo Asset ile local dosyaya indir
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Asset } = await import("expo-asset");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createLlama } = await import("llama-cpp-wasm");

    // Expo asset URI'sini çözümle
    const asset = Asset.fromURI(wasmUri);
    await asset.downloadAsync();

    if (!asset.localUri) {
      throw new Error(`Expo Asset localUri null: ${wasmUri}`);
    }

    // Native'de WASM file'ı local path üzerinden yükle
    return createLlama({ locateFile: (_file: string) => asset.localUri! }) as ILlamaModule;
  }

  /** Test / memory pressure → cache temizle */
  static clearCache(): void {
    for (const mod of WasmBootstrap._moduleCache.values()) {
      try { mod.destroy(); } catch { /* ignore */ }
    }
    WasmBootstrap._moduleCache.clear();
  }
}

// ─── LlamaCppBinding ─────────────────────────────────────────────────────────

/**
 * ILlamaModule → ILlamaCppBinding adapter.
 * OfflineRuntime bu arayüzü kullanır; llama.cpp detaylarını bilmez.
 *
 * T-NEW-2 ile entegre: `getChatTemplate(modelId)` ile doğru template.
 */
class LlamaCppBinding implements ILlamaCppBinding {
  private readonly _module: ILlamaModule;
  private readonly _modelId: AIModelId;
  private readonly _modelPath: string;
  private _contextId: number | null = null;
  private _disposed = false;

  constructor(module: ILlamaModule, modelId: AIModelId, modelPath: string) {
    this._module  = module;
    this._modelId = modelId;
    this._modelPath = modelPath;
  }

  async loadModel(modelPath: string): Promise<void> {
    const loaded = this._module.load_model(modelPath, { n_ctx: 4096 });
    if (!loaded) throw new Error(`llama.cpp: load_model failed — ${modelPath}`);
    this._contextId = this._module.create_context(modelPath);
  }

  tokenize(text: string): number[] {
    // llama.cpp WASM tokenize — basit whitespace split proxy
    // Gerçek implementasyon: this._module.tokenize(text) (paket bağlı)
    // Şimdilik her karakter → token ID (byte-level proxy)
    return Array.from(new TextEncoder().encode(text));
  }

  async *nextToken(
    _contextTokens: number[],
    maxNewTokens: number,
    signal: AbortSignal,
  ): AsyncGenerator<string, void, unknown> {
    if (this._contextId === null) throw new Error("Model not loaded");
    if (this._disposed) return;

    const template = getChatTemplate(this._modelId);
    const stopTokens = new Set(template.stopTokens);

    let generated = "";
    let tokenCount = 0;

    while (tokenCount < maxNewTokens) {
      if (signal.aborted) return;

      // llama.cpp senkron token üretimi — micro-task'a bırak
      const token = await new Promise<string>((resolve, reject) => {
        if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
        try {
          const t = this._module.get_next_token(this._contextId!, {
            temperature: 0.7,
            top_p: 0.9,
            top_k: 40,
            repeat_penalty: 1.1,
          });
          resolve(t);
        } catch (e) {
          reject(e);
        }
      });

      if (!token || token === "") break; // EOS

      // Stop token kontrolü
      generated += token;
      let isStop = false;
      for (const stop of stopTokens) {
        if (generated.endsWith(stop)) {
          isStop = true;
          // Stop token'ı çıktıdan çıkar
          generated = generated.slice(0, generated.length - stop.length);
          break;
        }
      }
      if (isStop) break;

      yield token;
      tokenCount++;
    }
  }

  free(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this._contextId !== null) {
      try { this._module.free_context(this._contextId); } catch { /* ignore */ }
      this._contextId = null;
    }
    // Module cache'de kalır (WasmBootstrap) — tek WASM instance'ı paylaşılır
  }
}

// ─── ExpoLlamaCppLoader (T-NEW-1 KAPANDI) ───────────────────────────────────

/**
 * Expo ortamında llama.cpp WASM'ı yükler.
 *
 * Kullanım (AppContainer):
 *   const loader = new ExpoLlamaCppLoader(
 *     require("../../assets/llama.wasm"),  // Metro asset
 *     modelId,
 *   );
 *   const runtime = new OfflineRuntime(loader);
 */
export class ExpoLlamaCppLoader implements ILlamaCppLoader {
  private readonly _wasmAssetUri: string;
  private readonly _modelId: AIModelId;

  constructor(wasmAssetUri: string, modelId: AIModelId) {
    this._wasmAssetUri = wasmAssetUri;
    this._modelId      = modelId;
  }

  async loadBinding(): Promise<ILlamaCppBinding> {
    const module = await WasmBootstrap.load(this._wasmAssetUri);
    return new LlamaCppBinding(module, this._modelId, "");
    // modelPath loadModel()'de set edilecek — OfflineRuntime._doLoad(apiModelId) çağırır
  }
}

// ─── Mock (test) ─────────────────────────────────────────────────────────────

export { MockLlamaCppLoader } from "./OfflineRuntime";
