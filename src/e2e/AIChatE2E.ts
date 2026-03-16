/**
 * e2e/AIChatE2E.ts — T-P10-1: AIChatScreen tam E2E akışı
 *
 * DÜZELTME #1 — CloudRuntime fetch mock kaçıyor:
 *   ❌ Constructor sonrası globalThis.fetch restore ediliyordu.
 *      CloudRuntime.streamChat() çağrıldığında globalThis.fetch zaten orijinale
 *      dönmüştü → mock hiç çalışmıyordu.
 *   ❌ (cloudRuntime as any)._fetch = mock → CloudRuntime bu alanı kullanmıyor
 *      (doğrudan global fetch çağırıyor) → yine mock kaçıyor.
 *
 *   ✅ Çözüm: globalThis.fetch mock'u runChat() süresince aktif tutulur.
 *      Her runChat() çağrısında:
 *        1. globalThis.fetch = mockFetch
 *        2. request gönder, RESPONSE bekle
 *        3. finally: globalThis.fetch = originalFetch
 *      Böylece SSE streaming boyunca mock aktif, sonra temizlenir.
 *
 * DÜZELTME #2 — Event Listener Memory Leak:
 *   ❌ her runChat() çağrısı bridge'e bir message listener ekliyor,
 *      RESPONSE gelince listener kaldırılmıyordu.
 *      N request → N listener birikir; eski handler'lar yanlış RESPONSE'a tepki verir.
 *
 *   ✅ Çözüm: listener referansı saklanır, promise resolve/reject/timeout'da
 *      removeEventListener() çağrılır (finally benzeri cleanup).
 *
 * § 5  : REQUEST / STREAM / RESPONSE / CANCEL protokolü
 */

import { OfflineRuntime, MockLlamaCppLoader } from "../ai/OfflineRuntime";
import { CloudRuntime }                        from "../ai/CloudRuntime";
import { AIWorkerBridge, createMockWorkerFactory } from "../ai/AIWorkerBridge";
import { APIKeyStore, InMemorySecureStore }    from "../security/APIKeyStore";
import { AIModelId }                           from "../ai/AIModels";
import type { RuntimeMessage }                 from "../ai/IAIWorkerRuntime";

// ─── SSE Mock fetch ───────────────────────────────────────────────────────────

/**
 * Anthropic SSE protokolünü simüle eder.
 * CloudRuntime'ın gerçek SSE parser'ı bu stream'i işler.
 */
export function createMockSSEFetch(tokens: string[]): typeof fetch {
  return async (_url: unknown, _opts: unknown): Promise<Response> => {
    const encoder = new TextEncoder();
    let idx       = 0;

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (idx < tokens.length) {
          const token = tokens[idx++];
          const event = [
            `event: content_block_delta`,
            `data: ${JSON.stringify({
              type:  "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: token },
            })}`,
            "",
            "",
          ].join("\n");
          controller.enqueue(encoder.encode(event));
        } else {
          const stop = [
            `event: message_stop`,
            `data: ${JSON.stringify({ type: "message_stop" })}`,
            "",
            "",
          ].join("\n");
          controller.enqueue(encoder.encode(stop));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status:  200,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

// ─── E2ETestHarness ───────────────────────────────────────────────────────────

export interface E2EConfig {
  offlineTokens?: string[];
  cloudTokens?:   string[];
  anthropicKey?:  string;
  tokenDelayMs?:  number;
}

export interface E2EResult {
  tokens:   string[];
  fullText: string;
  duration: number;
  ok:       boolean;
  error?:   string;
}

export class E2ETestHarness {
  private readonly _bridge:       AIWorkerBridge;
  private readonly _keyStore:     APIKeyStore;
  // ✅ DÜZELTME #1: mock fetch instance saklanır
  private readonly _mockSSEFetch: typeof fetch;
  private _disposed = false;

  constructor(cfg: E2EConfig = {}) {
    const {
      offlineTokens = ["Hello", " world", "!"],
      cloudTokens   = ["Cloud", " response"],
      anthropicKey  = "sk-ant-api03-e2etestkey1234567890123456789012345678",
      tokenDelayMs  = 0,
    } = cfg;

    // ✅ DÜZELTME #1: mockFetch instance'ı constructor'da oluşturulur,
    //    globalThis'e HENÜZ atanmaz — runChat() içinde atanır.
    this._mockSSEFetch = createMockSSEFetch(cloudTokens);

    // KeyStore
    const secureStore = new InMemorySecureStore();
    this._keyStore    = new APIKeyStore(secureStore);
    void secureStore.setItemAsync("ai_key_anthropic", anthropicKey);

    // Offline runtime
    const offlineRuntime = new OfflineRuntime(
      new MockLlamaCppLoader(offlineTokens, tokenDelayMs),
    );

    // Cloud runtime — globalThis.fetch değiştirilmeden oluşturulur
    // (constructor fetch kullanmıyor; sadece streamChat sırasında kullanır)
    const cloudRuntime = new CloudRuntime(this._keyStore);

    const factory = createMockWorkerFactory(offlineRuntime, cloudRuntime);
    this._bridge  = new AIWorkerBridge(factory);
  }

  /**
   * Tam E2E chat akışı.
   *
   * ✅ DÜZELTME #1: fetch mock, request süresince aktif — sonra restore.
   * ✅ DÜZELTME #2: message listener request bitince kaldırılır.
   */
  async runChat(
    modelId:  AIModelId,
    messages: RuntimeMessage[],
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<E2EResult> {
    if (this._disposed) {
      return { tokens: [], fullText: "", duration: 0, ok: false, error: "Disposed" };
    }

    const timeoutMs    = opts?.timeoutMs ?? 5_000;
    const startTs      = Date.now();
    const tokens:  string[] = [];
    const requestId    = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // ✅ DÜZELTME #1: Cloud model ise fetch mock'u aktif et
    const isCloud     = !modelId.startsWith("offline:");
    const origFetch   = globalThis.fetch;
    if (isCloud) globalThis.fetch = this._mockSSEFetch;

    return new Promise<E2EResult>((resolve) => {
      let resolved = false;
      let timeoutHandle: ReturnType<typeof setTimeout>;

      // ✅ DÜZELTME #2: handler referansı saklanır
      const handler = (e: MessageEvent) => {
        if (resolved) return;
        const msg = e.data as { type: string; id: string; payload: unknown };
        if (msg.id !== requestId) return;

        if (msg.type === "STREAM") {
          const p = msg.payload as { token?: string; done?: boolean };
          if (p.token) tokens.push(p.token);
        } else if (msg.type === "RESPONSE") {
          cleanup();
          const p = msg.payload as { ok?: boolean; code?: string; message?: string };
          resolve({
            tokens, fullText: tokens.join(""),
            duration: Date.now() - startTs,
            ok: p.ok ?? false,
            error: p.ok ? undefined : (p.message ?? p.code),
          });
        }
      };

      // ✅ DÜZELTME #2: tek noktadan temizlik — her çıkış yolunda çağrılır
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutHandle);
        // ✅ Listener kaldırılır — memory leak yok
        this._bridge.removeEventListener("message", handler);
        // ✅ DÜZELTME #1: fetch restore
        if (isCloud) globalThis.fetch = origFetch;
      };

      this._bridge.addEventListener("message", handler);

      timeoutHandle = setTimeout(() => {
        cleanup();
        resolve({
          tokens, fullText: tokens.join(""),
          duration: Date.now() - startTs,
          ok: false, error: `Timeout (${timeoutMs}ms)`,
        });
      }, timeoutMs);

      if (opts?.signal) {
        opts.signal.addEventListener("abort", () => {
          if (!resolved) {
            this._bridge.postMessage({
              type: "CANCEL", id: `cancel-${requestId}`,
              from: "e2e-test", to: "ai", ts: Date.now(),
              payload: { targetId: requestId },
            });
            // abort sonrası RESPONSE beklenebilir — timeout halleder
          }
        }, { once: true });
      }

      this._bridge.postMessage({
        type: "REQUEST",
        id:   requestId,
        from: "e2e-test",
        to:   "ai",
        ts:   Date.now(),
        payload: { kind: "chat", model: modelId, messages, maxTokens: 50 },
      });
    });
  }

  get bridge(): AIWorkerBridge { return this._bridge; }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._keyStore.dispose();
    this._bridge.dispose();
  }
}
