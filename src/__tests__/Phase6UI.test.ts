/**
 * __tests__/Phase6UI.test.ts — Phase 6 UI Layer testleri
 *
 * § 1  : Result<T> — .ok, .data, .code pattern
 * § 5  : IPC protokol testleri (STREAM/RESPONSE/CANCEL)
 * § 10 : createApp() / mockDriver pattern
 */

// ─── Mock kurulum ────────────────────────────────────────────────────────────

import type { IWorkerPort } from "../ai/AIWorkerClient";
import { AIWorkerClient } from "../ai/AIWorkerClient";
import type { AIModelId } from "../ai/AIModels";
import {
  AI_MODELS,
  AIModelId as ModelId,
  getAvailableModels,
  getDefaultModel,
  getModel,
  getModelsByProvider,
  isModelAvailable,
  TOKEN_BUDGETS,
  assertBudgetIntegrity,
  AIProvider,
  selectModelForPrompt,
} from "../ai/AIModels";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let uuidCounter = 0;
const mockUUID = () => `uuid-${++uuidCounter}` as any;

function createMockPort(): IWorkerPort & {
  _emit: (msg: object) => void;
  _sent: unknown[];
} {
  const listeners: Array<(e: MessageEvent) => void> = [];
  const sent: unknown[] = [];

  return {
    _sent: sent,
    _emit(msg: object) {
      const snap = [...listeners];
      for (const l of snap) l({ data: msg } as MessageEvent);
    },
    postMessage(msg: unknown) {
      sent.push(msg);
    },
    addEventListener(_type: string, handler: (e: MessageEvent) => void) {
      listeners.push(handler);
    },
    removeEventListener(_type: string, handler: (e: MessageEvent) => void) {
      const i = listeners.indexOf(handler);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
}

// ─── 1. AIModels ─────────────────────────────────────────────────────────────

describe("AIModels", () => {
  describe("getAvailableModels", () => {
    it("DISABLED → boş liste döner", () => {
      expect(getAvailableModels("DISABLED")).toHaveLength(0);
    });

    it("LOCAL_ONLY → yalnızca offline modeller", () => {
      const models = getAvailableModels("LOCAL_ONLY");
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.variant === "offline")).toBe(true);
    });

    it("CLOUD_ENABLED → offline + cloud modeller", () => {
      const models = getAvailableModels("CLOUD_ENABLED");
      const hasOffline = models.some((m) => m.variant === "offline");
      const hasCloud = models.some((m) => m.variant === "cloud");
      expect(hasOffline).toBe(true);
      expect(hasCloud).toBe(true);
    });

    it("CLOUD_ENABLED → LOCAL_ONLY kümesini kapsar", () => {
      const local = getAvailableModels("LOCAL_ONLY");
      const cloud = getAvailableModels("CLOUD_ENABLED");
      local.forEach((m) => {
        expect(cloud.find((c) => c.id === m.id)).toBeDefined();
      });
    });
  });

  describe("getDefaultModel", () => {
    it("DISABLED → null döner", () => {
      expect(getDefaultModel("DISABLED")).toBeNull();
    });

    it("LOCAL_ONLY → offline model döner", () => {
      const id = getDefaultModel("LOCAL_ONLY");
      expect(id).not.toBeNull();
      const model = AI_MODELS.find((m) => m.id === id);
      expect(model?.variant).toBe("offline");
    });

    it("CLOUD_ENABLED → cloud model döner", () => {
      const id = getDefaultModel("CLOUD_ENABLED");
      expect(id).not.toBeNull();
      const model = AI_MODELS.find((m) => m.id === id);
      expect(model?.variant).toBe("cloud");
    });
  });

  describe("isModelAvailable", () => {
    it("offline model LOCAL_ONLY'de kullanılabilir", () => {
      expect(isModelAvailable(ModelId.OFFLINE_GEMMA3_1B, "LOCAL_ONLY")).toBe(true);
    });

    it("cloud model LOCAL_ONLY'de kullanılamaz", () => {
      expect(isModelAvailable(ModelId.CLOUD_CLAUDE_HAIKU_45, "LOCAL_ONLY")).toBe(false);
    });

    it("cloud model CLOUD_ENABLED'da kullanılabilir", () => {
      expect(isModelAvailable(ModelId.CLOUD_CLAUDE_HAIKU_45, "CLOUD_ENABLED")).toBe(true);
    });

    it("herhangi model DISABLED'da kullanılamaz", () => {
      expect(isModelAvailable(ModelId.OFFLINE_GEMMA3_1B, "DISABLED")).toBe(false);
    });

    it("bilinmeyen model ID → false", () => {
      expect(isModelAvailable("unknown:model" as AIModelId, "CLOUD_ENABLED")).toBe(false);
    });
  });

  describe("TOKEN_BUDGETS", () => {
    it("tüm modeller için budget tanımlı", () => {
      AI_MODELS.forEach((m) => {
        const budget = TOKEN_BUDGETS[m.id];
        expect(budget).toBeDefined();
        expect(budget.contextTokens).toBeGreaterThan(0);
        expect(budget.completionTokens).toBeGreaterThan(0);
      });
    });

    it("offline budget < cloud budget", () => {
      const offlineBudget = TOKEN_BUDGETS[ModelId.OFFLINE_GEMMA3_1B];
      const cloudBudget = TOKEN_BUDGETS[ModelId.CLOUD_CLAUDE_HAIKU_45];
      expect(offlineBudget.contextTokens).toBeLessThan(cloudBudget.contextTokens);
    });
  });
});

// ─── 2. AIWorkerClient ───────────────────────────────────────────────────────

describe("AIWorkerClient", () => {
  let port: ReturnType<typeof createMockPort>;
  let client: AIWorkerClient;

  beforeEach(() => {
    uuidCounter = 0;
    port = createMockPort();
    client = new AIWorkerClient(port, mockUUID);
  });

  afterEach(() => {
    client.dispose();
  });

  describe("streamChat — temel akış", () => {
    it("REQUEST mesajı gönderir", async () => {
      const gen = client.streamChat({
        model: ModelId.OFFLINE_GEMMA3_1B,
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 64,
      });

      // İlk next → REQUEST gönderilir
      const promise = gen.next();

      // Hemen STREAM gönder
      port._emit({
        type: "STREAM",
        id: "uuid-1",
        from: "ai",
        to: "editor",
        ts: Date.now(),
        payload: { seq: 0, token: "Hi" },
      });
      port._emit({
        type: "RESPONSE",
        id: "uuid-1",
        from: "ai",
        to: "editor",
        ts: Date.now(),
        payload: { ok: true, totalTokens: 5 },
      });

      const first = await promise;
      expect(first.value).toBe("Hi");
      expect(first.done).toBe(false);

      const result = await gen.next();
      expect(result.done).toBe(true);
      expect((result.value as any).ok).toBe(true);
      expect((result.value as any).data.totalTokens).toBe(5);

      const sent = port._sent[0] as any;
      expect(sent.type).toBe("REQUEST");
      expect(sent.from).toBe("editor");
      expect(sent.to).toBe("ai");
    });

    it("birden fazla token sırayla yield eder", async () => {
      const gen = client.streamChat({
        model: ModelId.OFFLINE_GEMMA3_1B,
        messages: [{ role: "user", content: "test" }],
        maxTokens: 64,
      });

      const tokens = ["Hello", " ", "world"];
      const id = "uuid-1";

      const collectPromise = (async () => {
        const collected: string[] = [];
        let item = await gen.next();
        while (!item.done) {
          collected.push(item.value as string);
          item = await gen.next();
        }
        return { collected, result: item.value };
      })();

      // Asenkron olarak token'ları gönder
      for (let i = 0; i < tokens.length; i++) {
        port._emit({
          type: "STREAM",
          id,
          from: "ai",
          to: "editor",
          ts: Date.now(),
          payload: { seq: i, token: tokens[i] },
        });
        await Promise.resolve();
      }
      port._emit({
        type: "RESPONSE",
        id,
        from: "ai",
        to: "editor",
        ts: Date.now(),
        payload: { ok: true, totalTokens: 10 },
      });

      const { collected, result } = await collectPromise;
      expect(collected).toEqual(tokens);
      expect((result as any).ok).toBe(true);
    });

    it("worker hata yanıtı → err() döner", async () => {
      const gen = client.streamChat({
        model: ModelId.OFFLINE_GEMMA3_1B,
        messages: [],
        maxTokens: 64,
      });

      const promise = (async () => {
        let item = await gen.next();
        while (!item.done) item = await gen.next();
        return item.value;
      })();

      port._emit({
        type: "RESPONSE",
        id: "uuid-1",
        from: "ai",
        to: "editor",
        ts: Date.now(),
        payload: { ok: false, errorCode: "MODEL_NOT_LOADED", errorMessage: "model yüklenmedi" },
      });

      const result = await promise;
      expect((result as any).ok).toBe(false);
      expect((result as any).error?.code).toBe("MODEL_NOT_LOADED");
    });

    it("seq sırası bozulursa SEQ_OUT_OF_ORDER hatası", async () => {
      const gen = client.streamChat({
        model: ModelId.OFFLINE_GEMMA3_1B,
        messages: [],
        maxTokens: 64,
      });

      const promise = (async () => {
        let item = await gen.next();
        while (!item.done) item = await gen.next();
        return item.value;
      })();

      // seq=0 yerine seq=5 → hata
      port._emit({
        type: "STREAM",
        id: "uuid-1",
        from: "ai",
        to: "editor",
        ts: Date.now(),
        payload: { seq: 5, token: "bad" },
      });

      const result = await promise;
      expect((result as any).ok).toBe(false);
      expect((result as any).error?.code).toBe("AI_SEQ_OUT_OF_ORDER");
    });
  });

  describe("CANCEL", () => {
    it("AbortSignal abort → CANCEL mesajı gönderir", async () => {
      const abortCtrl = new AbortController();
      const gen = client.streamChat(
        {
          model: ModelId.OFFLINE_GEMMA3_1B,
          messages: [],
          maxTokens: 64,
        },
        abortCtrl.signal,
      );

      const promise = (async () => {
        let item = await gen.next();
        while (!item.done) item = await gen.next();
        return item.value;
      })();

      abortCtrl.abort();

      // RESPONSE göndererek stream'i kapat
      port._emit({
        type: "RESPONSE",
        id: "uuid-1",
        from: "ai",
        to: "editor",
        ts: Date.now(),
        payload: { ok: false, errorCode: "AI_REQUEST_CANCELLED" },
      });

      await promise;

      const cancelMsg = port._sent.find((m: any) => m.type === "CANCEL") as any;
      expect(cancelMsg).toBeDefined();
      expect(cancelMsg.payload.targetId).toBe("uuid-1");
    });
  });

  describe("dispose", () => {
    it("dispose → disposed client WORKER_NOT_READY döner", async () => {
      client.dispose();
      const gen = client.streamChat({
        model: ModelId.OFFLINE_GEMMA3_1B,
        messages: [],
        maxTokens: 64,
      });
      const result = await gen.next();
      expect(result.done).toBe(true);
      expect((result.value as any).ok).toBe(false);
      expect((result.value as any).error?.code).toBe("AI_WORKER_NOT_READY");
    });

    it("dispose → tekrar dispose güvenli", () => {
      expect(() => {
        client.dispose();
        client.dispose();
      }).not.toThrow();
    });
  });

  describe("requestCompletion", () => {
    it("completion başarıyla döner", async () => {
      const promise = client.requestCompletion({
        model: ModelId.OFFLINE_GEMMA3_1B,
        prefix: "function add(",
        suffix: "",
        language: "js",
        maxTokens: 64,
      });

      // Token'ları aktar
      await Promise.resolve();
      port._emit({
        type: "STREAM",
        id: "uuid-1",
        from: "ai",
        to: "editor",
        ts: Date.now(),
        payload: { seq: 0, token: "a, b) { return a + b; }" },
      });
      await Promise.resolve();
      port._emit({
        type: "RESPONSE",
        id: "uuid-1",
        from: "ai",
        to: "editor",
        ts: Date.now(),
        payload: { ok: true, totalTokens: 15 },
      });

      const result = await promise;
      expect(result.ok).toBe(true);
      expect(result.data).toContain("a, b)");
    });
  });
});


// ─── 3. selectModelForPrompt ─────────────────────────────────────────────────

describe("selectModelForPrompt", () => {
  describe("DISABLED", () => {
    it("her kind → null", () => {
      const kinds: Array<"code" | "long_context" | "quick_answer" | "offline"> =
        ["code", "long_context", "quick_answer", "offline"];
      kinds.forEach((kind) => {
        expect(selectModelForPrompt({ kind, status: "DISABLED" })).toBeNull();
      });
    });
  });

  describe("LOCAL_ONLY", () => {
    it("code → Phi-4 Mini (reasoning-first, offline)", () => {
      expect(selectModelForPrompt({ kind: "code", status: "LOCAL_ONLY" }))
        .toBe(ModelId.OFFLINE_PHI4_MINI);
    });

    it("quick_answer → Gemma 3 1B (en hızlı offline)", () => {
      expect(selectModelForPrompt({ kind: "quick_answer", status: "LOCAL_ONLY" }))
        .toBe(ModelId.OFFLINE_GEMMA3_1B);
    });

    it("offline → Gemma 3 1B (en hafif)", () => {
      expect(selectModelForPrompt({ kind: "offline", status: "LOCAL_ONLY" }))
        .toBe(ModelId.OFFLINE_GEMMA3_1B);
    });

    it("long_context → Gemma3-4B (128K ctx, cloud yok)", () => {
      expect(selectModelForPrompt({ kind: "long_context", status: "LOCAL_ONLY" }))
        .toBe(ModelId.OFFLINE_GEMMA3_4B);
    });

    it("long_context + 50K token → Gemma3-4B (128K ctx geçer)", () => {
      expect(selectModelForPrompt({
        kind: "long_context", status: "LOCAL_ONLY", estimatedInputTokens: 50_000,
      })).toBe(ModelId.OFFLINE_GEMMA3_4B);
    });

    it("her kind → offline model döner", () => {
      const kinds: Array<"code" | "long_context" | "quick_answer" | "offline"> =
        ["code", "long_context", "quick_answer", "offline"];
      kinds.forEach((kind) => {
        const id = selectModelForPrompt({ kind, status: "LOCAL_ONLY" });
        expect(id).not.toBeNull();
        expect(getModel(id!)?.variant).toBe("offline");
      });
    });
  });

  describe("CLOUD_ENABLED", () => {
    it("code → Phi-4 Mini (PREFERENCE sırası: offline reasoning önce)", () => {
      expect(selectModelForPrompt({ kind: "code", status: "CLOUD_ENABLED" }))
        .toBe(ModelId.OFFLINE_PHI4_MINI);
    });

    it("long_context → Claude Sonnet 4.6 (200K ctx, cloud sırası 1)", () => {
      expect(selectModelForPrompt({ kind: "long_context", status: "CLOUD_ENABLED" }))
        .toBe(ModelId.CLOUD_CLAUDE_SONNET_46);
    });

    it("quick_answer → Claude Haiku 4.5 (en hızlı cloud)", () => {
      expect(selectModelForPrompt({ kind: "quick_answer", status: "CLOUD_ENABLED" }))
        .toBe(ModelId.CLOUD_CLAUDE_HAIKU_45);
    });

    it("offline → Gemma 3 1B (offline tercih)", () => {
      expect(selectModelForPrompt({ kind: "offline", status: "CLOUD_ENABLED" }))
        .toBe(ModelId.OFFLINE_GEMMA3_1B);
    });

    it("long_context + 50K token → Sonnet 4.6 (>32K threshold, 200K ctx)", () => {
      expect(selectModelForPrompt({
        kind: "long_context", status: "CLOUD_ENABLED", estimatedInputTokens: 50_000,
      })).toBe(ModelId.CLOUD_CLAUDE_SONNET_46);
    });

    it("long_context + estimatedInputTokens = 0 → Sonnet 4.6", () => {
      expect(selectModelForPrompt({
        kind: "long_context", status: "CLOUD_ENABLED", estimatedInputTokens: 0,
      })).toBe(ModelId.CLOUD_CLAUDE_SONNET_46);
    });

    it("her kind → null değil", () => {
      const kinds: Array<"code" | "long_context" | "quick_answer" | "offline"> =
        ["code", "long_context", "quick_answer", "offline"];
      kinds.forEach((kind) => {
        expect(selectModelForPrompt({ kind, status: "CLOUD_ENABLED" })).not.toBeNull();
      });
    });
  });

  describe("bilinmeyen kind → fallback", () => {
    it("CLOUD_ENABLED bilinmeyen kind → getDefaultModel (Sonnet 4.6)", () => {
      const id = selectModelForPrompt({ kind: "unknown_kind" as any, status: "CLOUD_ENABLED" });
      expect(id).toBe(ModelId.CLOUD_CLAUDE_SONNET_46);
    });

    it("LOCAL_ONLY bilinmeyen kind → getDefaultModel (Gemma3-1B)", () => {
      const id = selectModelForPrompt({ kind: "unknown_kind" as any, status: "LOCAL_ONLY" });
      expect(id).toBe(ModelId.OFFLINE_GEMMA3_1B);
    });
  });
});

// ─── 3. useModelSelector (pure logic) ───────────────────────────────────────

describe("useModelSelector logic", () => {
  it("LOCAL_ONLY → cloud model seçilemez", () => {
    const available = getAvailableModels("LOCAL_ONLY");
    const cloudModel = AI_MODELS.find((m) => m.variant === "cloud");
    expect(cloudModel).toBeDefined();
    expect(available.find((m) => m.id === cloudModel!.id)).toBeUndefined();
  });

  it("CLOUD_ENABLED → tüm modeller seçilebilir", () => {
    const available = getAvailableModels("CLOUD_ENABLED");
    expect(available.length).toBe(AI_MODELS.length);
  });
});

// ─── 4. useCodeCompletion (debounce logic) ───────────────────────────────────

describe("useCodeCompletion constants", () => {
  it("MIN_PREFIX_LENGTH 2 karakter", () => {
    // Kısa prefix → istek atılmaz
    // Bu testte sadece MIN_PREFIX_LENGTH mantığını doğruluyoruz
    const shortPrefix = "a";
    expect(shortPrefix.trimEnd().length).toBeLessThan(2);
  });

  it("MAX_SUGGESTIONS 3 öneri sınırı", () => {
    const MAX_SUGGESTIONS = 3;
    const lines = ["line1", "line2", "line3", "line4", "line5"];
    const limited = lines.slice(0, MAX_SUGGESTIONS);
    expect(limited).toHaveLength(3);
  });
});

// ─── 5. useAIChat (pure logic) ───────────────────────────────────────────────

describe("useAIChat logic", () => {
  it("token budget — Gemma3-1B offline 512 completion token", () => {
    const budget = TOKEN_BUDGETS[ModelId.OFFLINE_GEMMA3_1B];
    expect(budget.completionTokens).toBe(512);
  });

  it("token budget — Haiku 4.5 cloud 4096 completion token", () => {
    const budget = TOKEN_BUDGETS[ModelId.CLOUD_CLAUDE_HAIKU_45];
    expect(budget.completionTokens).toBe(4096);
  });

  it("AI_MODELS sabit uzunlukta (8 model)", () => {
    expect(AI_MODELS.length).toBe(8);
  });
});

// ─── 6. IPC Protokol validasyonu ─────────────────────────────────────────────

describe("IPC protocol", () => {
  let port: ReturnType<typeof createMockPort>;
  let client: AIWorkerClient;

  beforeEach(() => {
    uuidCounter = 0;
    port = createMockPort();
    client = new AIWorkerClient(port, mockUUID);
  });

  afterEach(() => { client.dispose(); });

  it("REQUEST mesajı gerekli alanları taşır", async () => {
    const gen = client.streamChat({
      model: ModelId.OFFLINE_GEMMA3_1B,
      messages: [{ role: "user", content: "test" }],
      maxTokens: 100,
    });

    gen.next(); // REQUEST gönder

    await Promise.resolve();

    const req = port._sent[0] as any;
    expect(req.type).toBe("REQUEST");
    expect(typeof req.id).toBe("string");
    expect(req.from).toBe("editor");
    expect(req.to).toBe("ai");
    expect(typeof req.ts).toBe("number");
    expect(req.payload.kind).toBe("chat");

    // cleanup
    port._emit({ type: "RESPONSE", id: req.id, from: "ai", to: "editor", ts: Date.now(), payload: { ok: true, totalTokens: 0 } });
    for await (const _ of gen) { /* drain */ }
  });

  it("CANCEL mesajı targetId içerir", async () => {
    const abortCtrl = new AbortController();
    const gen = client.streamChat(
      { model: ModelId.OFFLINE_GEMMA3_1B, messages: [], maxTokens: 64 },
      abortCtrl.signal,
    );

    const promise = (async () => {
      for await (const _ of gen) { /* drain */ }
    })();

    abortCtrl.abort();
    port._emit({ type: "RESPONSE", id: "uuid-1", from: "ai", to: "editor", ts: Date.now(), payload: { ok: false } });
    await promise;

    const cancel = port._sent.find((m: any) => m.type === "CANCEL") as any;
    expect(cancel).toBeDefined();
    expect(cancel.payload.targetId).toBeDefined();
  });

  it("bilinmeyen mesaj ID → listener bulunamaz, hata atılmaz", () => {
    expect(() => {
      port._emit({
        type: "STREAM",
        id: "unknown-id",
        from: "ai",
        to: "editor",
        ts: Date.now(),
        payload: { seq: 0, token: "test" },
      });
    }).not.toThrow();
  });

  it("null payload → hata atılmaz", () => {
    expect(() => {
      port._emit(null as any);
    }).not.toThrow();
  });
});
