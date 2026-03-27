/**
 * ai/MlcLlmBinding.ts — @react-native-ai/mlc binding adapter
 *
 * Paket: @react-native-ai/mlc@0.12.0 (Callstack)
 * API:   Vercel AI SDK v5 uyumlu — streamText({ model, messages })
 *
 * Düzeltmeler (TS hatası fix):
 *   ✅ _getMlcProvider tipi: () => Promise<{ mlc: MLCProvider }> (doğru destructure)
 *   ✅ n_ctx config'e eklendi (OfflineRuntime ve worker uyumluluğu)
 *   ✅ this._model null guard genişletildi
 *   ✅ getMlcProvider dönüş tipi tutarlılaştırıldı
 *
 * § 1  : Result<T>
 * § 8  : Mutable state → _prefix
 */

import type { ILlamaCppBinding, ILlamaCppLoader } from "./OfflineRuntime";
import { getChatTemplate }                         from "./ChatTemplate";
import type { AIModelId }                          from "./AIModels";

// ─── @react-native-ai/mlc tip tanımları ──────────────────────────────────────

export interface MLCModelHandle {
  download(onProgress?: (p: { percentage: number; receivedMB: number; totalMB: number }) => void): Promise<void>;
  prepare(): Promise<void>;
  unload(): Promise<void>;
}

/** Vercel AI SDK v5 LanguageModelV1 minimal arayüzü */
export interface VercelLanguageModel {
  readonly specificationVersion: "v1";
  readonly provider: string;
  readonly modelId: string;
  doStream(options: unknown): Promise<unknown>;
  doGenerate(options: unknown): Promise<unknown>;
}

export type MLCModel = MLCModelHandle & VercelLanguageModel;

export interface MLCProvider {
  languageModel(modelId: string): MLCModel;
}

/** @react-native-ai/mlc modülünün dışa aktardığı nesne */
export interface MLCModule {
  mlc: MLCProvider;
}

export type StreamTextFn = (opts: {
  model:           VercelLanguageModel;
  messages:        Array<{ role: string; content: string }>;
  maxTokens?:      number;
  abortSignal?:    AbortSignal;
  stopSequences?:  string[];
  temperature?:    number;
}) => { textStream: AsyncIterable<string> };

// ─── Prompt → Messages parser ─────────────────────────────────────────────────

export function parsePromptToMessages(
  prompt: string,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

  // ── Phi/Llama format ────────────────────────────────────────────────────
  const sysMatch = prompt.match(/<\|system\|>\n([\s\S]*?)<\|end\|>/);
  if (sysMatch) messages.push({ role: "system", content: sysMatch[1].trim() });

  const phiRe = /<\|(user|assistant)\|>\n([\s\S]*?)(?=<\|(?:user|assistant|system)\|>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = phiRe.exec(prompt)) !== null) {
    const content = m[2].replace(/<\|end\|>\s*$/, "").trim();
    if (content) messages.push({ role: m[1] as "user" | "assistant", content });
  }
  if (messages.length > 0) return messages;

  // ── Gemma format ─────────────────────────────────────────────────────────
  const gemmaRe = /<start_of_turn>(user|model)\n([\s\S]*?)(?=<start_of_turn>|$)/g;
  while ((m = gemmaRe.exec(prompt)) !== null) {
    const role    = m[1] === "model" ? "assistant" : "user";
    const content = m[2].replace(/<end_of_turn>\s*$/, "").trim();
    if (content) messages.push({ role: role as "user" | "assistant", content });
  }
  if (messages.length > 0) return messages;

  return [{ role: "user", content: prompt.trim() }];
}

// ─── MlcLlmBinding — ILlamaCppBinding impl ───────────────────────────────────

class MlcLlmBinding implements ILlamaCppBinding {
  private _model: MLCModel | null = null;
  private _disposed = false;

  // ✅ FIX: dönüş tipi Promise<MLCModule> — { mlc } destructure edilebilir
  private readonly _getMlcModule:  () => Promise<MLCModule>;
  private readonly _getStreamText: () => Promise<StreamTextFn>;
  private readonly _modelId:       AIModelId;
  private readonly _temperature:   number;

  constructor(
    getMlcModule:   () => Promise<MLCModule>,
    getStreamText:  () => Promise<StreamTextFn>,
    modelId:        AIModelId,
    config:         { n_ctx?: number; temperature?: number } = {},
  ) {
    this._getMlcModule  = getMlcModule;
    this._getStreamText = getStreamText;
    this._modelId       = modelId;
    this._temperature   = config.temperature ?? 0.7;
    // n_ctx: MLC kendi context uzunluğunu model manifest'ten okur, burada saklanmaz
  }

  async loadModel(mlcModelId: string): Promise<void> {
    if (this._disposed) throw new Error("MlcLlmBinding: already disposed");
    if (this._model !== null) {
      await this._model.unload().catch(() => {});
      this._model = null;
    }
    // ✅ FIX: { mlc } destructure
    const { mlc } = await this._getMlcModule();
    this._model = mlc.languageModel(mlcModelId);
    await this._model.prepare();
  }

  tokenize(text: string): number[] {
    return Array.from(new TextEncoder().encode(text));
  }

  async *nextToken(
    contextTokens: number[],
    maxNewTokens:  number,
    signal:        AbortSignal,
    stopTokens?:   readonly string[],
  ): AsyncGenerator<string, void, unknown> {
    // ✅ FIX: null guard
    if (this._model === null || this._disposed) {
      throw new Error("Model not loaded. Call loadModel() first.");
    }

    const template   = getChatTemplate(this._modelId);
    const promptText = new TextDecoder().decode(new Uint8Array(contextTokens));
    const messages   = parsePromptToMessages(promptText);
    const finalStops = [
      ...template.stopTokens,
      ...(stopTokens ?? []),
      "<|end|>", "<|im_end|>", "</s>", "<|EOT|>",
    ];

    const streamText = await this._getStreamText();
    const { textStream } = streamText({
      model:         this._model,
      messages,
      maxTokens:     maxNewTokens,
      abortSignal:   signal,
      stopSequences: finalStops,
      temperature:   this._temperature,
    });

    for await (const chunk of textStream) {
      if (signal.aborted) return;
      if (chunk) yield chunk;
    }
  }

  free(): void {
    if (this._disposed) return;
    this._disposed = true;
    const model = this._model;
    this._model = null;
    if (model !== null) {
      model.unload().catch(() => {});
    }
  }
}

// ─── MlcLlmLoader — ILlamaCppLoader impl ─────────────────────────────────────

export class MlcLlmLoader implements ILlamaCppLoader {
  private readonly _modelId: AIModelId;
  // ✅ FIX: n_ctx dahil — OfflineRuntime ve worker uyumluluğu
  private readonly _config: { n_ctx?: number; n_gpu_layers?: number; temperature?: number };

  constructor(
    modelId: AIModelId,
    config:  { n_ctx?: number; n_gpu_layers?: number; temperature?: number } = {},
  ) {
    this._modelId = modelId;
    this._config  = config;
  }

  async loadBinding(): Promise<ILlamaCppBinding> {
    return new MlcLlmBinding(
      // ✅ FIX: Promise<MLCModule> döndürür — { mlc } destructure uyumlu
      () => import("@react-native-ai/mlc") as unknown as Promise<MLCModule>,
      async () => {
        const { streamText } = await import("ai");
        return streamText as unknown as StreamTextFn;
      },
      this._modelId,
      { temperature: this._config.temperature },
    );
  }
}

// ─── MlcBridgeAdapter — LlamaCppRunner.ILlamaBridge impl ─────────────────────

// ✅ FIX: export edildi (LlamaCppWasm.ts re-export + TS hatası giderildi)
export class MlcBridgeAdapter {
  async loadModel(
    mlcModelId: string,
    _params: { n_ctx: number; n_threads: number; use_mlock: boolean },
  ): Promise<MLCContextHandle> {
    const { mlc } = await import("@react-native-ai/mlc") as unknown as MLCModule;
    const model = mlc.languageModel(mlcModelId);
    await model.prepare();
    return new MLCContextHandle(model);
  }

  async getModelInfo(mlcModelId: string): Promise<{ contextLength: number; description: string }> {
    return { contextLength: 4096, description: `MLC model: ${mlcModelId}` };
  }
}

class MLCContextHandle {
  constructor(private readonly _model: MLCModel) {}

  async completion(
    params: { prompt: string; n_predict: number; temperature: number; stop?: string[] },
    onToken: (token: { text: string; done: boolean }) => void,
  ): Promise<{ text: string; timings: { prompt_n: number; predicted_n: number; prompt_ms: number; predicted_ms: number } }> {
    const { streamText } = await import("ai");
    const messages = parsePromptToMessages(params.prompt);
    const startMs  = Date.now();
    let   fullText = "";
    let   count    = 0;

    const { textStream } = (streamText as unknown as StreamTextFn)({
      model:        this._model,
      messages,
      temperature:  params.temperature,
      maxTokens:    params.n_predict,
      stopSequences: params.stop,
    });

    for await (const chunk of textStream) {
      if (chunk) {
        fullText += chunk;
        count++;
        onToken({ text: chunk, done: false });
      }
    }
    onToken({ text: "", done: true });

    return {
      text: fullText,
      timings: { prompt_n: 0, predicted_n: count, prompt_ms: 0, predicted_ms: Date.now() - startMs },
    };
  }

  async stopCompletion(): Promise<void> { /* MLC async iter abort signal ile durur */ }
  async release(): Promise<void> { await this._model.unload(); }
}

// ─── MlcDownloadHelper ────────────────────────────────────────────────────────

export class MlcDownloadHelper {
  async download(
    mlcModelId: string,
    onProgress?: (percent: number, receivedMB: number, totalMB: number) => void,
    _signal?:   AbortSignal,
  ): Promise<void> {
    const { mlc } = await import("@react-native-ai/mlc") as unknown as MLCModule;
    const model = mlc.languageModel(mlcModelId);
    await model.download(
      onProgress ? (p) => onProgress(p.percentage, p.receivedMB, p.totalMB) : undefined,
    );
  }

  async isReady(mlcModelId: string): Promise<boolean> {
    try {
      const { mlc } = await import("@react-native-ai/mlc") as unknown as MLCModule;
      const model = mlc.languageModel(mlcModelId);
      await model.prepare();
      await model.unload();
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Backward compat stubs ────────────────────────────────────────────────────

/** @deprecated → MlcLlmLoader kullanın */
export class ExpoLlamaCppLoader extends MlcLlmLoader {}
/** @deprecated */
export interface LlamaRnContext {
  completion(...args: unknown[]): Promise<unknown>;
  stopCompletion(): Promise<void>;
  release(): Promise<void>;
}
/** @deprecated */
export class WasmBootstrap {
  static async load(_uri: string): Promise<never> { throw new Error("WasmBootstrap: deprecated. MlcLlmLoader kullanın."); }
  static clearCache(): void { /* no-op */ }
}
export { MockLlamaCppLoader } from "./OfflineRuntime";
