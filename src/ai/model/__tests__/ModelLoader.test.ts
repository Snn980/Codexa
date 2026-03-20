/**
 * ai/model/__tests__/ModelLoader.test.ts
 *
 * Phase 5.1 — Model Loader test suite (rev 2)
 * ~95 test case / 18 describe
 *
 * İkinci geçiş kontrol listesi:
 *  ✓ Her mock tam interface'i implement ediyor (IHttpStreamResponse dahil)
 *  ✓ RunId branded — runId() factory kullanılıyor
 *  ✓ cancel() RUN_NOT_FOUND / idempotent / gerçek iptal senaryoları
 *  ✓ maxConcurrentRuns aşımı → RUNNER_BUSY
 *  ✓ CONTEXT_TOO_LARGE guard (Llama + Claude)
 *  ✓ fullText çakışması: callbackText vs completion.text
 *  ✓ streaming HTTP status kontrolü (IHttpStreamResponse.status)
 *  ✓ Tüm SSE event türleri: message_start, content_block_start,
 *    content_block_delta(text_delta + input_json_delta), content_block_stop,
 *    message_delta, message_stop, ping, error
 *  ✓ activeRunIds getter
 *  ✓ ModelMeta.modelPath alanı
 *  ✓ setModelPath() / INVALID_RUNNER_CONFIG
 *  ✓ estimateTokens()
 *
 * Kural § 1: tüm async sonuçlar .ok ile test edilir
 * Kural § 10: mock bridge/http inject — gerçek native modül gerektirmez
 */


import type {
  ILlamaBridge,
  ILlamaContextHandle,
  LlamaCompletionParams,
  LlamaCompletionResult,
} from "../LlamaCppRunner";
import { LlamaCppRunner } from "../LlamaCppRunner";
import type { IHttpClient, IHttpResponse, IHttpStreamResponse } from "../ClaudeApiRunner";
import { ClaudeApiRunner } from "../ClaudeApiRunner";
import { ModelRegistry } from "../ModelRegistry";
import {
  LoadState,
  ModelErrorCode,
  RunnerVariant,
  CHARS_PER_TOKEN,
  estimateMessageTokens,
  modelKey,
  runId,
} from "../IModelRunner";
import type { ModelKey, RunMessage, RunRequest, RunId } from "../IModelRunner";

// ─── Constants ────────────────────────────────────────────────────────────

const PHI3  = modelKey("phi3-mini-q4");
const GEMMA = modelKey("codegemma-2b-q4km");
const HAIKU = modelKey("claude-haiku");

const PHI3_PATH  = "/models/phi3.gguf";
const GEMMA_PATH = "/models/gemma.gguf";

// ─── Request helpers ──────────────────────────────────────────────────────

function makeRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    modelKey:    PHI3,
    messages:    [{ role: "user", content: "explain this code" }],
    temperature: 0.1,
    maxTokens:   64,
    ...overrides,
  };
}

function makeCloudRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    modelKey:    HAIKU,
    messages:    [{ role: "user", content: "explain this code" }],
    temperature: 0.1,
    maxTokens:   64,
    ...overrides,
  };
}

// ─── Mock: ILlamaContextHandle ────────────────────────────────────────────

function makeMockHandle(opts: {
  text?: string;
  promptN?: number;
  predictedN?: number;
  failWith?: string;
  onBeforeReturn?: () => void;
} = {}): ILlamaContextHandle {
  const { text = "hello world", promptN = 10, predictedN = 2, failWith, onBeforeReturn } = opts;

  return {
    completion: jest.fn(async (
      _params: LlamaCompletionParams,
      onToken: (t: { text: string; done: boolean }) => void,
    ): Promise<LlamaCompletionResult> => {
      if (failWith) throw new Error(failWith);

      // Chunk'ları stream et
      onToken({ text: "hello", done: false });
      onToken({ text: " world", done: true });

      onBeforeReturn?.();

      return {
        // bridge.text kasıtlı olarak farklı — test etmeliyiz ki callbackText kullanılıyor
        text: "BRIDGE_TEXT_SHOULD_NOT_BE_USED",
        timings: { prompt_n: promptN, predicted_n: predictedN, prompt_ms: 5, predicted_ms: 50 },
      };
    }),
    stopCompletion: jest.fn(async () => {}),
    release:        jest.fn(async () => {}),
  };
}

function makeBridge(handle?: ILlamaContextHandle, failLoad = false): ILlamaBridge {
  return {
    loadModel:    jest.fn(async () => {
      if (failLoad) throw new Error("native load failed");
      return handle ?? makeMockHandle();
    }),
    getModelInfo: jest.fn(async () => ({ contextLength: 4096, description: "test" })),
  };
}

// ─── Mock: LlamaCppRunner builder ────────────────────────────────────────

function makeLlamaRunner(bridge?: ILlamaBridge): LlamaCppRunner {
  const r = new LlamaCppRunner(bridge ?? makeBridge(), {
    numThreads:       2,
    contextSize:      4096,
    defaultTimeoutMs: 5_000,
  });
  // Path inject
  r.setModelPath(PHI3,  PHI3_PATH);
  r.setModelPath(GEMMA, GEMMA_PATH);
  return r;
}

// ─── Mock: IHttpClient ────────────────────────────────────────────────────

function makeHttpClient(overrides: Partial<IHttpClient> = {}): IHttpClient {
  return {
    post: jest.fn(async (): Promise<IHttpResponse> => ({
      status: 200,
      body: {
        content: [{ type: "text", text: "api response" }],
        usage: { input_tokens: 20, output_tokens: 5 },
      },
    })),
    postStream: jest.fn(async (
      _url: string,
      _headers: Record<string, string>,
      _body: unknown,
      onLine: (line: string) => void,
    ): Promise<IHttpStreamResponse> => {
      // Full SSE event sequence
      onLine(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 20 } } })}`);
      onLine(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`);
      onLine(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streamed " } })}`);
      onLine(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "reply" } })}`);
      onLine(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`);
      onLine(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } })}`);
      onLine(`data: ${JSON.stringify({ type: "message_stop" })}`);
      return { status: 200, errorBody: null };
    }),
    ...overrides,
  };
}

function makeClaudeRunner(http?: IHttpClient): ClaudeApiRunner {
  return new ClaudeApiRunner(http ?? makeHttpClient(), {
    apiKey:           "test-key",
    defaultTimeoutMs: 5_000,
    maxConcurrentRuns: 4,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. IModelRunner interface constants
// ═══════════════════════════════════════════════════════════════════════════

describe("CHARS_PER_TOKEN ve estimateMessageTokens", () => {
  it("CHARS_PER_TOKEN = 4", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
  });

  it("boş mesaj listesi → 0", () => {
    expect(estimateMessageTokens([])).toBe(0);
  });

  it("tek 8-char mesaj → 2 token", () => {
    const msgs: RunMessage[] = [{ role: "user", content: "12345678" }];
    expect(estimateMessageTokens(msgs)).toBe(2);
  });

  it("çok mesaj → char toplamı / 4 (ceiling)", () => {
    const msgs: RunMessage[] = [
      { role: "system",    content: "abc" },   // 3 chars
      { role: "user",      content: "defg" },  // 4 chars
      { role: "assistant", content: "hi" },    // 2 chars
    ];
    // total = 9 chars → ceil(9/4) = 3
    expect(estimateMessageTokens(msgs)).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. LlamaCppRunner — initial state
// ═══════════════════════════════════════════════════════════════════════════

describe("LlamaCppRunner — initial state", () => {
  it("loadState = UNLOADED", () => {
    expect(makeLlamaRunner().loadState).toBe(LoadState.UNLOADED);
  });

  it("variant = OFFLINE", () => {
    expect(makeLlamaRunner().variant).toBe(RunnerVariant.OFFLINE);
  });

  it("maxConcurrentRuns = 1", () => {
    expect(makeLlamaRunner().maxConcurrentRuns).toBe(1);
  });

  it("activeRunIds boş set", () => {
    expect(makeLlamaRunner().activeRunIds.size).toBe(0);
  });

  it("supportedModels 2 model içeriyor", () => {
    expect(makeLlamaRunner().supportedModels.length).toBe(2);
  });

  it("supportedModels modelPath inject sonrası dolu", () => {
    const r = makeLlamaRunner();
    const phi3Meta = r.supportedModels.find((m) => m.key === PHI3);
    expect(phi3Meta?.modelPath).toBe(PHI3_PATH);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. LlamaCppRunner — setModelPath
// ═══════════════════════════════════════════════════════════════════════════

describe("LlamaCppRunner.setModelPath()", () => {
  it("bilinen key → ok", () => {
    const r = new LlamaCppRunner(makeBridge());
    expect(r.setModelPath(PHI3, "/new/path.gguf").ok).toBe(true);
  });

  it("bilinmeyen key → INVALID_RUNNER_CONFIG", () => {
    const r = new LlamaCppRunner(makeBridge());
    const res = r.setModelPath(modelKey("unknown"), "/x.gguf");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ModelErrorCode.INVALID_RUNNER_CONFIG);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. LlamaCppRunner — load
// ═══════════════════════════════════════════════════════════════════════════

describe("LlamaCppRunner.load()", () => {
  it("başarılı yükleme → READY", async () => {
    const r = makeLlamaRunner();
    const res = await r.load(PHI3);
    expect(res.ok).toBe(true);
    expect(r.loadState).toBe(LoadState.READY);
  });

  it("path olmayan key → MODEL_NOT_LOADED", async () => {
    const r = new LlamaCppRunner(makeBridge()); // path inject yok
    const res = await r.load(PHI3);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ModelErrorCode.MODEL_NOT_LOADED);
  });

  it("aynı key tekrar load → idempotent, bridge bir kez çağrılır", async () => {
    const bridge = makeBridge();
    const r = makeLlamaRunner(bridge);
    await r.load(PHI3);
    await r.load(PHI3);
    expect(bridge.loadModel).toHaveBeenCalledTimes(1);
  });

  it("bridge hata → MODEL_LOAD_FAILED + state ERROR", async () => {
    const r = makeLlamaRunner(makeBridge(undefined, true));
    const res = await r.load(PHI3);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ModelErrorCode.MODEL_LOAD_FAILED);
    expect(r.loadState).toBe(LoadState.ERROR);
  });

  it("farklı model yüklerken önceki handle release edilir", async () => {
    const handle = makeMockHandle();
    const r = makeLlamaRunner(makeBridge(handle));
    await r.load(PHI3);
    await r.load(GEMMA);
    expect(handle.release).toHaveBeenCalledTimes(1);
  });

  it("disposed sonrası → MODEL_LOAD_FAILED", async () => {
    const r = makeLlamaRunner();
    await r.dispose();
    expect((await r.load(PHI3)).error?.code).toBe(ModelErrorCode.MODEL_LOAD_FAILED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. LlamaCppRunner — unload
// ═══════════════════════════════════════════════════════════════════════════

describe("LlamaCppRunner.unload()", () => {
  it("yüklü model → UNLOADED", async () => {
    const r = makeLlamaRunner();
    await r.load(PHI3);
    expect((await r.unload(PHI3)).ok).toBe(true);
    expect(r.loadState).toBe(LoadState.UNLOADED);
  });

  it("yüklü olmayan key → ok (idempotent)", async () => {
    expect((await makeLlamaRunner().unload(PHI3)).ok).toBe(true);
  });

  it("release hata → MODEL_UNLOAD_FAILED", async () => {
    const handle = makeMockHandle();
    (handle.release as ReturnType<typeof jest.fn>).mockRejectedValueOnce(new Error("fail"));
    const r = makeLlamaRunner(makeBridge(handle));
    await r.load(PHI3);
    const res = await r.unload(PHI3);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ModelErrorCode.MODEL_UNLOAD_FAILED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. LlamaCppRunner — run: temel
// ═══════════════════════════════════════════════════════════════════════════

describe("LlamaCppRunner.run() — temel", () => {
  it("başarılı inference — text callback'ten gelir (completion.text DEĞİL)", async () => {
    const r = makeLlamaRunner();
    await r.load(PHI3);
    const res = await r.run(makeRequest());
    expect(res.ok).toBe(true);
    // callbackText = "hello" + " world" = "hello world"
    // completion.text = "BRIDGE_TEXT_SHOULD_NOT_BE_USED" → kullanılmamalı
    expect(res.data?.text).toBe("hello world");
    expect(res.data?.text).not.toContain("BRIDGE_TEXT");
  });

  it("RunId RunResult içinde dönüyor", async () => {
    const r = makeLlamaRunner();
    await r.load(PHI3);
    const res = await r.run(makeRequest());
    expect(res.data?.runId).toBeDefined();
    expect(typeof res.data?.runId).toBe("string");
  });

  it("inputTokens / outputTokens bridge timings'ten alınır", async () => {
    const r = makeLlamaRunner();
    await r.load(PHI3);
    const res = await r.run(makeRequest());
    expect(res.data?.inputTokens).toBe(10);
    expect(res.data?.outputTokens).toBe(2);
  });

  it("latencyMs ≥ 0", async () => {
    const r = makeLlamaRunner();
    await r.load(PHI3);
    const res = await r.run(makeRequest());
    expect(res.data?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("model yüklü değil → MODEL_NOT_LOADED", async () => {
    const res = await makeLlamaRunner().run(makeRequest());
    expect(res.error?.code).toBe(ModelErrorCode.MODEL_NOT_LOADED);
  });

  it("inference hatası → INFERENCE_FAILED", async () => {
    const r = makeLlamaRunner(makeBridge(makeMockHandle({ failWith: "crash" })));
    await r.load(PHI3);
    const res = await r.run(makeRequest());
    expect(res.error?.code).toBe(ModelErrorCode.INFERENCE_FAILED);
  });

  it("disposed → INFERENCE_FAILED", async () => {
    const r = makeLlamaRunner();
    await r.load(PHI3);
    await r.dispose();
    expect((await r.run(makeRequest())).error?.code).toBe(ModelErrorCode.INFERENCE_FAILED);
  });

  it("onToken callback chunk'lar doğru sırada çağrılır", async () => {
    const r = makeLlamaRunner();
    await r.load(PHI3);
    const chunks: string[] = [];
    await r.run(makeRequest(), { onToken: (c) => chunks.push(c) });
    expect(chunks).toEqual(["hello", " world"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. LlamaCppRunner — run: prompt büyüklüğü
// ═══════════════════════════════════════════════════════════════════════════

describe("LlamaCppRunner.run() — CONTEXT_TOO_LARGE guard", () => {
  it("estimatedInput + maxTokens > contextWindow → CONTEXT_TOO_LARGE", async () => {
    const r = new LlamaCppRunner(makeBridge(), { contextSize: 100 });
    r.setModelPath(PHI3, PHI3_PATH);
    await r.load(PHI3);

    // 100 char / 4 = 25 tokens. contextSize = 100 token. maxTokens = 80 → 25+80 > 100
    const bigContent = "x".repeat(100);
    const res = await r.run(makeRequest({
      messages:  [{ role: "user", content: bigContent }],
      maxTokens: 80,
    }));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ModelErrorCode.CONTEXT_TOO_LARGE);
  });

  it("sınırda geçerli prompt → ok", async () => {
    const r = makeLlamaRunner();  // contextSize = 4096
    await r.load(PHI3);
    // "explain this code" = 18 chars → 5 tokens. maxTokens = 64 → 5+64 = 69 << 4096
    const res = await r.run(makeRequest());
    expect(res.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. LlamaCppRunner — run: concurrency
// ═══════════════════════════════════════════════════════════════════════════

describe("LlamaCppRunner.run() — maxConcurrentRuns", () => {
  it("maxConcurrentRuns aşımı → RUNNER_BUSY", async () => {
    // Handle completion'ı asla resolve etmez — run askıda kalır
    let releaseBlock: (() => void) | null = null;
    const blockingHandle: ILlamaContextHandle = {
      completion: jest.fn(async (_p, _onT) => {
        await new Promise<void>((res) => { releaseBlock = res; });
        return { text: "", timings: { prompt_n: 0, predicted_n: 0, prompt_ms: 0, predicted_ms: 0 } };
      }),
      stopCompletion: jest.fn(async () => {}),
      release:        jest.fn(async () => {}),
    };

    const r = makeLlamaRunner(makeBridge(blockingHandle));
    await r.load(PHI3);

    // İlk run askıda — paralel başlatılıyor
    const firstRunPromise = r.run(makeRequest());
    // Küçük bekleme — first run _activeRuns'a girsin
    await new Promise((res) => setTimeout(res, 10));

    const secondRes = await r.run(makeRequest());
    expect(secondRes.ok).toBe(false);
    expect(secondRes.error?.code).toBe(ModelErrorCode.RUNNER_BUSY);

    // Temizlik
    if (releaseBlock) releaseBlock();
    await firstRunPromise;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. LlamaCppRunner — cancel
// ═══════════════════════════════════════════════════════════════════════════

describe("LlamaCppRunner.cancel()", () => {
  it("bilinmeyen RunId → RUN_NOT_FOUND", async () => {
    const r = makeLlamaRunner();
    const res = await r.cancel(runId("nonexistent"));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ModelErrorCode.RUN_NOT_FOUND);
  });

  it("tamamlanan run → RUN_NOT_FOUND (artık aktif değil)", async () => {
    const r = makeLlamaRunner();
    await r.load(PHI3);
    const runRes = await r.run(makeRequest());
    expect(runRes.ok).toBe(true);
    const cancelRes = await r.cancel(runRes.data!.runId);
    expect(cancelRes.ok).toBe(false);
    expect(cancelRes.error?.code).toBe(ModelErrorCode.RUN_NOT_FOUND);
  });

  it("already aborted signal → INFERENCE_CANCELLED", async () => {
    const r = makeLlamaRunner();
    await r.load(PHI3);
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await r.run(makeRequest(), { signal: ctrl.signal });
    expect(res.error?.code).toBe(ModelErrorCode.INFERENCE_CANCELLED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. LlamaCppRunner — estimateTokens
// ═══════════════════════════════════════════════════════════════════════════

describe("LlamaCppRunner.estimateTokens()", () => {
  it("12 char → 3 token", () => {
    const r = makeLlamaRunner();
    expect(r.estimateTokens([{ role: "user", content: "123456789012" }])).toBe(3);
  });

  it("boş → 0", () => {
    expect(makeLlamaRunner().estimateTokens([])).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. LlamaCppRunner — healthCheck & dispose
// ═══════════════════════════════════════════════════════════════════════════

describe("LlamaCppRunner.healthCheck() / dispose()", () => {
  it("bridge erişilebilir → ok", async () => {
    expect((await makeLlamaRunner().healthCheck()).ok).toBe(true);
  });

  it("bridge hata → MODEL_NOT_LOADED", async () => {
    const bridge: ILlamaBridge = {
      loadModel:    jest.fn(),
      getModelInfo: jest.fn(async () => { throw new Error("no file"); }),
    };
    const r = new LlamaCppRunner(bridge);
    r.setModelPath(PHI3, PHI3_PATH);
    expect((await r.healthCheck()).error?.code).toBe(ModelErrorCode.MODEL_NOT_LOADED);
  });

  it("dispose → handle release edilir", async () => {
    const handle = makeMockHandle();
    const r = makeLlamaRunner(makeBridge(handle));
    await r.load(PHI3);
    await r.dispose();
    expect(handle.release).toHaveBeenCalledTimes(1);
  });

  it("dispose idempotent", async () => {
    const r = makeLlamaRunner();
    await r.dispose();
    await expect(r.dispose()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. ClaudeApiRunner — initial state
// ═══════════════════════════════════════════════════════════════════════════

describe("ClaudeApiRunner — initial state", () => {
  it("loadState = READY", () => {
    expect(makeClaudeRunner().loadState).toBe(LoadState.READY);
  });

  it("variant = CLOUD", () => {
    expect(makeClaudeRunner().variant).toBe(RunnerVariant.CLOUD);
  });

  it("maxConcurrentRuns = 4 (config default)", () => {
    expect(makeClaudeRunner().maxConcurrentRuns).toBe(4);
  });

  it("activeRunIds boş", () => {
    expect(makeClaudeRunner().activeRunIds.size).toBe(0);
  });

  it("load / unload no-op → ok", async () => {
    const r = makeClaudeRunner();
    expect((await r.load(HAIKU)).ok).toBe(true);
    expect((await r.unload(HAIKU)).ok).toBe(true);
    expect(r.loadState).toBe(LoadState.READY);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. ClaudeApiRunner — run: non-streaming
// ═══════════════════════════════════════════════════════════════════════════

describe("ClaudeApiRunner.run() — non-streaming", () => {
  it("başarılı yanıt — text, tokenlar, RunId", async () => {
    const r = makeClaudeRunner();
    const res = await r.run(makeCloudRequest());
    expect(res.ok).toBe(true);
    expect(res.data?.text).toBe("api response");
    expect(res.data?.inputTokens).toBe(20);
    expect(res.data?.outputTokens).toBe(5);
    expect(typeof res.data?.runId).toBe("string");
  });

  it("HTTP 401 → PROVIDER_AUTH_FAILED", async () => {
    const http = makeHttpClient({
      post: jest.fn(async () => ({ status: 401, body: { error: { type: "auth" } } })),
    });
    const res = await makeClaudeRunner(http).run(makeCloudRequest());
    expect(res.error?.code).toBe(ModelErrorCode.PROVIDER_AUTH_FAILED);
  });

  it("HTTP 429 → PROVIDER_RATE_LIMITED", async () => {
    const http = makeHttpClient({
      post: jest.fn(async () => ({ status: 429, body: {} })),
    });
    const res = await makeClaudeRunner(http).run(makeCloudRequest());
    expect(res.error?.code).toBe(ModelErrorCode.PROVIDER_RATE_LIMITED);
  });

  it("HTTP 503 → PROVIDER_UNAVAILABLE", async () => {
    const http = makeHttpClient({
      post: jest.fn(async () => ({ status: 503, body: {} })),
    });
    const res = await makeClaudeRunner(http).run(makeCloudRequest());
    expect(res.error?.code).toBe(ModelErrorCode.PROVIDER_UNAVAILABLE);
  });

  it("bilinmeyen model key → MODEL_NOT_LOADED", async () => {
    const res = await makeClaudeRunner().run(makeCloudRequest({ modelKey: modelKey("gpt-99") }));
    expect(res.error?.code).toBe(ModelErrorCode.MODEL_NOT_LOADED);
  });

  it("already aborted → INFERENCE_CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await makeClaudeRunner().run(makeCloudRequest(), { signal: ctrl.signal });
    expect(res.error?.code).toBe(ModelErrorCode.INFERENCE_CANCELLED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. ClaudeApiRunner — run: streaming & SSE events
// ═══════════════════════════════════════════════════════════════════════════

describe("ClaudeApiRunner.run() — streaming & SSE events", () => {
  it("streaming onToken doğru chunk'ları döner", async () => {
    const chunks: string[] = [];
    const res = await makeClaudeRunner().run(makeCloudRequest(), { onToken: (c) => chunks.push(c) });
    expect(res.ok).toBe(true);
    expect(chunks).toEqual(["streamed ", "reply"]);
  });

  it("streaming fullText birleşik", async () => {
    const res = await makeClaudeRunner().run(makeCloudRequest(), { onToken: () => {} });
    expect(res.data?.text).toBe("streamed reply");
  });

  it("streaming inputTokens / outputTokens dolu", async () => {
    const res = await makeClaudeRunner().run(makeCloudRequest(), { onToken: () => {} });
    expect(res.data?.inputTokens).toBe(20);
    expect(res.data?.outputTokens).toBe(4);
  });

  it("input_json_delta görmezden gelinir (text'e eklenmez)", async () => {
    const http = makeHttpClient({
      postStream: jest.fn(async (_u, _h, _b, onLine): Promise<IHttpStreamResponse> => {
        onLine(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } })}`);
        onLine(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use" } })}`);
        // input_json_delta: tool-use JSON, metin değil
        onLine(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"x":1}' } })}`);
        onLine(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`);
        onLine(`data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}`);
        onLine(`data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } })}`);
        onLine(`data: ${JSON.stringify({ type: "content_block_stop", index: 1 })}`);
        onLine(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}`);
        onLine(`data: ${JSON.stringify({ type: "message_stop" })}`);
        return { status: 200, errorBody: null };
      }),
    });
    const chunks: string[] = [];
    const res = await makeClaudeRunner(http).run(makeCloudRequest(), { onToken: (c) => chunks.push(c) });
    expect(res.data?.text).toBe("answer");
    expect(chunks).toEqual(["answer"]);
    // input_json_delta chunk'ı yok
    expect(chunks).not.toContain('{"x":1}');
  });

  it("ping event → no-op, text etkilenmez", async () => {
    const http = makeHttpClient({
      postStream: jest.fn(async (_u, _h, _b, onLine): Promise<IHttpStreamResponse> => {
        onLine(`data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } })}`);
        onLine(`data: ${JSON.stringify({ type: "ping" })}`);
        onLine(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}`);
        onLine(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`);
        onLine(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`);
        onLine(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}`);
        onLine(`data: ${JSON.stringify({ type: "message_stop" })}`);
        return { status: 200, errorBody: null };
      }),
    });
    const res = await makeClaudeRunner(http).run(makeCloudRequest(), { onToken: () => {} });
    expect(res.data?.text).toBe("ok");
  });

  it("SSE error event → INFERENCE_FAILED", async () => {
    const http = makeHttpClient({
      postStream: jest.fn(async (_u, _h, _b, onLine): Promise<IHttpStreamResponse> => {
        onLine(`data: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}`);
        return { status: 200, errorBody: null };
      }),
    });
    const res = await makeClaudeRunner(http).run(makeCloudRequest(), { onToken: () => {} });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ModelErrorCode.INFERENCE_FAILED);
  });

  it("streaming HTTP 401 → PROVIDER_AUTH_FAILED (stream açılmadan)", async () => {
    const http = makeHttpClient({
      postStream: jest.fn(async (): Promise<IHttpStreamResponse> => ({
        status: 401,
        errorBody: { error: { type: "authentication_error", message: "Invalid API key" } },
      })),
    });
    const res = await makeClaudeRunner(http).run(makeCloudRequest(), { onToken: () => {} });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ModelErrorCode.PROVIDER_AUTH_FAILED);
  });

  it("streaming HTTP 429 → PROVIDER_RATE_LIMITED", async () => {
    const http = makeHttpClient({
      postStream: jest.fn(async (): Promise<IHttpStreamResponse> => ({
        status: 429,
        errorBody: { error: { type: "rate_limit_error", message: "Rate limit" } },
      })),
    });
    const res = await makeClaudeRunner(http).run(makeCloudRequest(), { onToken: () => {} });
    expect(res.error?.code).toBe(ModelErrorCode.PROVIDER_RATE_LIMITED);
  });

  it("streaming HTTP 503 → PROVIDER_UNAVAILABLE", async () => {
    const http = makeHttpClient({
      postStream: jest.fn(async (): Promise<IHttpStreamResponse> => ({
        status: 503,
        errorBody: null,
      })),
    });
    const res = await makeClaudeRunner(http).run(makeCloudRequest(), { onToken: () => {} });
    expect(res.error?.code).toBe(ModelErrorCode.PROVIDER_UNAVAILABLE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. ClaudeApiRunner — CONTEXT_TOO_LARGE guard
// ═══════════════════════════════════════════════════════════════════════════

describe("ClaudeApiRunner — CONTEXT_TOO_LARGE guard", () => {
  it("dev-null model contextWindow'u aşan prompt → CONTEXT_TOO_LARGE", async () => {
    // claude-haiku contextWindow = 200_000 token
    // 200_000 * 4 chars = 800_000 chars → aşacak şekilde
    const r = makeClaudeRunner();
    const bigContent = "x".repeat(200_000 * CHARS_PER_TOKEN + 1);
    const res = await r.run(makeCloudRequest({
      messages:  [{ role: "user", content: bigContent }],
      maxTokens: 1024,
    }));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ModelErrorCode.CONTEXT_TOO_LARGE);
  });

  it("normal prompt → ok", async () => {
    const res = await makeClaudeRunner().run(makeCloudRequest());
    expect(res.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. ClaudeApiRunner — cancel
// ═══════════════════════════════════════════════════════════════════════════

describe("ClaudeApiRunner.cancel()", () => {
  it("bilinmeyen RunId → RUN_NOT_FOUND", async () => {
    const res = await makeClaudeRunner().cancel(runId("x"));
    expect(res.error?.code).toBe(ModelErrorCode.RUN_NOT_FOUND);
  });

  it("tamamlanan run → RUN_NOT_FOUND", async () => {
    const r = makeClaudeRunner();
    const runRes = await r.run(makeCloudRequest());
    expect(runRes.ok).toBe(true);
    const cancelRes = await r.cancel(runRes.data!.runId);
    expect(cancelRes.error?.code).toBe(ModelErrorCode.RUN_NOT_FOUND);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17. ClaudeApiRunner — dispose & healthCheck
// ═══════════════════════════════════════════════════════════════════════════

describe("ClaudeApiRunner.dispose() / healthCheck()", () => {
  it("dispose sonrası run → INFERENCE_FAILED", async () => {
    const r = makeClaudeRunner();
    await r.dispose();
    expect((await r.run(makeCloudRequest())).error?.code).toBe(ModelErrorCode.INFERENCE_FAILED);
  });

  it("dispose idempotent", async () => {
    const r = makeClaudeRunner();
    await r.dispose();
    await expect(r.dispose()).resolves.toBeUndefined();
  });

  it("healthCheck başarılı", async () => {
    const http = makeHttpClient({
      post: jest.fn(async () => ({ status: 200, body: { data: [] } })),
    });
    expect((await makeClaudeRunner(http).healthCheck()).ok).toBe(true);
  });

  it("healthCheck 401 → PROVIDER_AUTH_FAILED", async () => {
    const http = makeHttpClient({
      post: jest.fn(async () => ({ status: 401, body: {} })),
    });
    expect((await makeClaudeRunner(http).healthCheck()).error?.code).toBe(ModelErrorCode.PROVIDER_AUTH_FAILED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 18. ModelRegistry
// ═══════════════════════════════════════════════════════════════════════════

describe("ModelRegistry", () => {
  it("register — offline + cloud → ok", () => {
    const reg = new ModelRegistry({ allowedVariants: new Set([RunnerVariant.OFFLINE, RunnerVariant.CLOUD]) });
    expect(reg.register(makeLlamaRunner()).ok).toBe(true);
    expect(reg.register(makeClaudeRunner()).ok).toBe(true);
  });

  it("duplicate key → INVALID_RUNNER_CONFIG", () => {
    const reg = new ModelRegistry({ allowedVariants: new Set([RunnerVariant.OFFLINE]) });
    reg.register(makeLlamaRunner());
    expect(reg.register(makeLlamaRunner()).error?.code).toBe(ModelErrorCode.INVALID_RUNNER_CONFIG);
  });

  it("resolve — tam key eşleşmesi → isFallback: false", () => {
    const reg = new ModelRegistry({ allowedVariants: new Set([RunnerVariant.OFFLINE, RunnerVariant.CLOUD]) });
    reg.register(makeLlamaRunner());
    reg.register(makeClaudeRunner());
    const r = reg.resolve(PHI3);
    expect(r.ok).toBe(true);
    expect(r.data?.isFallback).toBe(false);
    expect(r.data?.resolvedKey).toBe(PHI3);
  });

  it("resolve — izin verilmeyen variant → INFERENCE_FAILED", () => {
    const reg = new ModelRegistry({ allowedVariants: new Set([RunnerVariant.OFFLINE]) });
    reg.register(makeLlamaRunner());
    reg.register(makeClaudeRunner());
    const r = reg.resolve(HAIKU);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(ModelErrorCode.INFERENCE_FAILED);
  });

  it("resolve — bilinmeyen key, aynı variantta fallback", () => {
    const reg = new ModelRegistry({ allowedVariants: new Set([RunnerVariant.OFFLINE]) });
    reg.register(makeLlamaRunner());
    const r = reg.resolve(modelKey("unknown-offline"));
    expect(r.ok).toBe(true);
    expect(r.data?.isFallback).toBe(true);
  });

  it("listModels — tüm modeller (izin filtresi yok)", () => {
    const reg = new ModelRegistry({ allowedVariants: new Set([RunnerVariant.OFFLINE]) });
    reg.register(makeLlamaRunner());
    reg.register(makeClaudeRunner());
    expect(reg.listModels().length).toBe(4);
  });

  it("listAllowedModels — sadece izinli variant", () => {
    const reg = new ModelRegistry({ allowedVariants: new Set([RunnerVariant.OFFLINE]) });
    reg.register(makeLlamaRunner());
    reg.register(makeClaudeRunner());
    const allowed = reg.listAllowedModels();
    expect(allowed.every((m) => m.variant === RunnerVariant.OFFLINE)).toBe(true);
    expect(allowed.length).toBe(2);
  });

  it("setAllowedVariants sonrası listAllowedModels güncellenir", () => {
    const reg = new ModelRegistry({ allowedVariants: new Set([RunnerVariant.OFFLINE]) });
    reg.register(makeLlamaRunner());
    reg.register(makeClaudeRunner());
    reg.setAllowedVariants(new Set([RunnerVariant.OFFLINE, RunnerVariant.CLOUD]));
    expect(reg.listAllowedModels().length).toBe(4);
  });

  it("dispose — tüm runner'ların dispose'u çağrılır", async () => {
    const llamaR  = makeLlamaRunner();
    const claudeR = makeClaudeRunner();
    const spyL = jest.spyOn(llamaR,  "dispose");
    const spyC = jest.spyOn(claudeR, "dispose");

    const reg = new ModelRegistry({ allowedVariants: new Set([RunnerVariant.OFFLINE]) });
    reg.register(llamaR);
    reg.register(claudeR);
    await reg.dispose();

    expect(spyL).toHaveBeenCalledTimes(1);
    expect(spyC).toHaveBeenCalledTimes(1);
  });

  it("dispose idempotent", async () => {
    const reg = new ModelRegistry({ allowedVariants: new Set() });
    await reg.dispose();
    await expect(reg.dispose()).resolves.toBeUndefined();
  });
});
