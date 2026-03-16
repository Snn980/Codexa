/**
 * workers/ai.cloud.worker.ts — Cloud AI Worker thread entry
 *
 * T-P9-1 KAPANDI
 *
 * DÜZELTME #3 — encryptedKey naming güvenlik tutarsızlığı:
 *   ❌ { type: "SET_KEY", provider, encryptedKey: string }
 *      Alan adı "encryptedKey" → değer aslında plaintext API key.
 *      Yanlış isim → kod okuyucu "bu değer zaten şifreli, tekrar şifrelemeye gerek yok"
 *      diye düşünebilir → güvenlik açığı riskine yol açar.
 *
 *   ✅ { type: "SET_KEY", provider, key: string }
 *      + Yorum: "postMessage structured clone → Worker izole heap'te güvenli.
 *        Ana thread AES-GCM ile bellekte tutar (WebSecureStore), buraya plaintext gelir."
 *
 * § 5  : REQUEST / STREAM / RESPONSE / CANCEL / SET_KEY protokolü
 */

import { bootstrapWorker } from "../ai/AIWorker";
import { CloudRuntime }    from "../ai/CloudRuntime";
import { createAPIKeyStore } from "../security/APIKeyStore";

declare const self: DedicatedWorkerGlobalScope;

async function bootstrap(): Promise<void> {
  const isWebWorker = typeof sessionStorage === "undefined";

  const keyStore = isWebWorker
    ? await createWebWorkerKeyStore()
    : await createAPIKeyStore();

  const runtime = new CloudRuntime(keyStore);
  const worker  = bootstrapWorker(runtime, self);

  self.addEventListener("close", () => {
    worker.dispose();
    keyStore.dispose();
  });
}

// ─── Web Worker key protokolü ─────────────────────────────────────────────────

/**
 * ✅ DÜZELTME #3: SET_KEY mesaj tipi `key` alanı kullanır (plaintext, açık isimlendirme).
 *
 * Güvenlik modeli:
 *   - postMessage structured clone → referans paylaşımı yok, kopyalanır
 *   - Worker izole heap → ana thread JS erişemez
 *   - Key yalnızca Worker'ın InMemorySecureStore'unda yaşar
 *   - CloudRuntime.getKey() → bu store'dan plaintext okur → Authorization header
 *
 * Ana thread tarafı (AIRuntimeFactory veya AppContainer):
 *   cloudWorker.postMessage({ type: "SET_KEY", provider: "anthropic", key: rawKey })
 */
async function createWebWorkerKeyStore() {
  const { InMemorySecureStore, APIKeyStore: Store } =
    await import("../security/APIKeyStore");

  const memStore = new InMemorySecureStore();
  const apiStore = new Store(memStore);

  self.addEventListener("message", async (e: MessageEvent) => {
    // ✅ DÜZELTME #3: `key` alanı — plaintext, açık isimlendirme
    const msg = e.data as {
      type?:     string;
      provider?: string;
      key?:      string;   // ❌ eskisi: encryptedKey — yanıltıcıydı
    };

    if (msg?.type !== "SET_KEY") return;
    if (!msg.provider || !msg.key) return;

    const provider = msg.provider as "anthropic" | "openai";
    // plaintext key → Worker'ın izole belleğine yaz
    await memStore.setItemAsync(`ai_key_${provider}`, msg.key);
  });

  return apiStore;
}

void bootstrap().catch((e) => {
  self.postMessage({ type: "WORKER_BOOT_FAILED", error: String(e) });
});
