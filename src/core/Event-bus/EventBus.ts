/**
 * @file     EventBus.ts
 * @module   core/event-bus
 * @version  1.0.0
 * @since    Phase 1 — Foundation
 *
 * @description
 *   IEventBus kontratının implementasyonu.
 *   Tüm katmanlar arası iletişim bu modül üzerinden yönetilir.
 *   Doğrudan bağımlılık yerine olaylar üzerinden haberleşme sağlanır.
 *
 *   Sorumluluklar:
 *     • Tip güvenli emit / on / off / once / onError
 *     • Async listener hata yakalama — unhandled rejection önleme
 *     • Memory leak koruması — listener sayısı üst sınırı (MAX_LISTENERS)
 *     • Wildcard dinleme — "*" ile tüm olayları izleme (debug/logging)
 *     • once() doğru teardown — listener çalıştıktan sonra map'ten silinir
 *     • removeAllListeners() — test cleanup ve uygulama teardown
 *
 *   Tasarım kararları:
 *     • Singleton DEĞİL — DI container veya factory üzerinden sağlanır;
 *       test izolasyonu için her test yeni instance alır.
 *     • emit() senkron — listener'lar sırayla ve hemen çağrılır;
 *       async listener'lar fire-and-forget olarak çalışır, hata onError'a düşer.
 *     • emit() asla throw etmez — listener hatası uygulamayı çökertemez.
 *     • Listener Map<K, Set<fn>> — aynı fn iki kez eklense de bir kez çalışır.
 *     • off() Set.delete() O(1) — büyük listener listelerinde performans kaybı yok.
 *     • once() wrapper pattern — orijinal fn referansı korunur; off() ile iptal edilebilir.
 *
 * @example — Temel kullanım
 *   const bus = new EventBus();
 *
 *   const unsubscribe = bus.on("file:saved", ({ file }) => {
 *     console.log("Kaydedildi:", file.name);
 *   });
 *
 *   bus.emit("file:saved", { file });
 *   unsubscribe(); // listener temizlenir
 *
 * @example — Async listener
 *   bus.onError((event, error) => logger.error({ event, error }));
 *
 *   bus.on("project:created", async ({ project }) => {
 *     await indexService.index(project);  // hata fırlatırsa onError'a düşer
 *   });
 *
 * @example — Wildcard (debug)
 *   bus.onAny((event, payload) => console.debug("[BUS]", event, payload));
 */

import type {
  AppEventMap,
  EventListener,
  IEventBus,
} from "../../types/core";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Sabitler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Olay başına maksimum listener sayısı.
 * Node.js EventEmitter varsayılanı 10; IDE için 32 daha uygun.
 * Aşılırsa console.warn — throw edilmez, uygulama çalışmaya devam eder.
 */
const MAX_LISTENERS_PER_EVENT = 32;

// ─────────────────────────────────────────────────────────────────────────────
// § 2. İç Tipler
// ─────────────────────────────────────────────────────────────────────────────

type EventKey     = keyof AppEventMap;
type AnyListener  = (payload: unknown) => void | Promise<void>;
type WildcardFn   = (event: EventKey, payload: unknown) => void | Promise<void>;
type ErrorHandler = (event: string, error: unknown) => void;

/**
 * once() wrapper'ı için meta veri.
 * Orijinal fn referansı `original` alanda tutulur; off(original) ile iptal edilebilir.
 */
interface OnceWrapper {
  readonly wrapper:  AnyListener;
  readonly original: AnyListener;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. EventBus
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tip güvenli, async-safe event bus implementasyonu.
 *
 * Memory model:
 *   listeners:     Map<EventKey, Set<AnyListener>>
 *   onceWrappers:  Map<AnyListener, OnceWrapper>   ← orijinal → wrapper eşlemesi
 *   wildcards:     Set<WildcardFn>
 *   errorHandler:  ErrorHandler
 */
export class EventBus implements IEventBus {

  private readonly listeners:    Map<EventKey, Set<AnyListener>> = new Map();
  private readonly onceWrappers: Map<AnyListener, OnceWrapper>   = new Map();
  private readonly wildcards:    Set<WildcardFn>                  = new Set();

  /**
   * Varsayılan hata handler — production'da loglama servisine bağlanmalı.
   * `onError()` ile değiştirilebilir.
   */
  private errorHandler: ErrorHandler = (event, error) => {
    console.error(`[EventBus] "${event}" listener hatası:`, error);
  };

  // ── IEventBus ────────────────────────────────────────────────

  /**
   * Olayı senkron yayınlar.
   * Async listener'lar fire-and-forget; hata onError'a düşer.
   * emit() hiçbir zaman throw etmez.
   *
   * @param event    - AppEventMap'teki olay adı
   * @param payload  - Olay verisi — tip güvenli
   */
  emit<K extends EventKey>(event: K, payload: AppEventMap[K]): void {
    // Kayıtlı listener'ları çalıştır
    const bucket = this.listeners.get(event);
    if (bucket) {
      for (const fn of bucket) {
        this.invoke(fn, event, payload);
      }
    }

    // Wildcard listener'ları çalıştır
    for (const fn of this.wildcards) {
      this.invoke(fn as AnyListener, event, payload);
    }
  }

  /**
   * Olay dinleyicisi ekler.
   * Aynı fn referansı tekrar eklenirse görmezden gelinir (Set semantiği).
   *
   * @returns Unsubscribe fonksiyonu — çağrıldığında listener temizlenir.
   *
   * @example
   * const unsub = bus.on("file:saved", handler);
   * // ...
   * unsub(); // temizle
   */
  on<K extends EventKey>(event: K, listener: EventListener<K>): () => void {
    const fn = listener as AnyListener;

    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    const bucket = this.listeners.get(event)!;

    // Memory leak uyarısı
    if (bucket.size >= MAX_LISTENERS_PER_EVENT) {
      console.warn(
        `[EventBus] "${event}" için listener sayısı ${MAX_LISTENERS_PER_EVENT} sınırına ulaştı. ` +
        "Memory leak olasılığı — unsubscribe çağrıları kontrol edilmeli.",
      );
    }

    bucket.add(fn);

    // Unsubscribe fonksiyonu — closure olarak event ve fn'i yakalar
    return () => this.off(event, listener);
  }

  /**
   * Olay dinleyicisini kaldırır.
   * once() ile eklenen listener'lar off(originalFn) ile iptal edilebilir.
   */
  off<K extends EventKey>(event: K, listener: EventListener<K>): void {
    const fn     = listener as AnyListener;
    const bucket = this.listeners.get(event);
    if (!bucket) return;

    // once() wrapper'ı mı? Orijinal fn'den wrapper'ı bul ve sil
    const onceEntry = this.onceWrappers.get(fn);
    if (onceEntry) {
      bucket.delete(onceEntry.wrapper);
      this.onceWrappers.delete(fn);
    } else {
      bucket.delete(fn);
    }

    // Boş Set → Map'ten temizle (bellek tasarrufu)
    if (bucket.size === 0) {
      this.listeners.delete(event);
    }
  }

  /**
   * Listener'ı yalnızca bir kez çalıştırır, sonra otomatik kaldırır.
   * off(originalListener) ile erken iptal edilebilir.
   *
   * @example
   * bus.once("project:opened", ({ project }) => {
   *   initFirstRunWizard(project);
   * });
   */
  once<K extends EventKey>(event: K, listener: EventListener<K>): void {
    const fn = listener as AnyListener;

    const wrapper: AnyListener = (payload) => {
      // Önce kaldır, sonra çalıştır — re-entrant emit'lerde çift çalışma olmaz
      this.off(event, listener);
      return fn(payload);
    };

    // Orijinal fn → wrapper eşlemesi — off(originalFn) için gerekli
    this.onceWrappers.set(fn, { wrapper, original: fn });

    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    this.listeners.get(event)!.add(wrapper);
  }

  /**
   * Async listener hatalarını yakalar.
   * Her EventBus instance'ı için bir kez çağrılmalıdır.
   *
   * @example
   * bus.onError((event, error) => {
   *   Sentry.captureException(error, { extra: { event } });
   * });
   */
  onError(handler: ErrorHandler): void {
    this.errorHandler = handler;
  }

  /**
   * Tüm listener'ları temizler.
   *
   * @param event  - Belirtilirse yalnızca o olayın listener'ları temizlenir.
   *                 Belirtilmezse tüm olaylar temizlenir.
   *
   * @example — Test teardown
   * afterEach(() => bus.removeAllListeners());
   *
   * @example — Tek olay
   * bus.removeAllListeners("file:saved");
   */
  removeAllListeners(event?: EventKey): void {
    if (event) {
      const bucket = this.listeners.get(event);
      if (!bucket) return;

      /**
       * Snapshot iteration — onceWrappers Map'i iterasyon sırasında
       * mutate edildiğinde undefined behavior oluşur.
       * [...entries()] anlık kopya alır; silme işlemleri kopya üzerinden yapılır.
       *
       * Neden bucket üzerinden değil onceWrappers üzerinden iterate ediyoruz?
       *   bucket → wrapper fn'leri içerir
       *   onceWrappers key → original fn
       *   İkisi farklı referanslar; bucket.has(entry.wrapper) tek doğru eşleşme yolu.
       */
      for (const [original, entry] of [...this.onceWrappers.entries()]) {
        if (bucket.has(entry.wrapper)) {
          this.onceWrappers.delete(original);
        }
      }

      this.listeners.delete(event);
    } else {
      this.listeners.clear();
      this.onceWrappers.clear();
      this.wildcards.clear();
    }
  }

  // ── Genişletilmiş API  (IEventBus ötesi) ─────────────────────

  /**
   * Tüm olayları dinler — debug ve loglama için.
   * IEventBus kontratının dışındadır; yalnızca geliştirme ortamında kullanılmalı.
   *
   * @returns Unsubscribe fonksiyonu
   *
   * @example
   * const unsub = bus.onAny((event, payload) => {
   *   devLogger.trace({ event, payload });
   * });
   */
  onAny(fn: WildcardFn): () => void {
    this.wildcards.add(fn);
    return () => this.wildcards.delete(fn);
  }

  /**
   * Belirli bir olayın kaç listener'ı olduğunu döner.
   * Diagnostics ve test doğrulaması için kullanılır.
   *
   * @example
   * expect(bus.listenerCount("file:saved")).toBe(1);
   */
  listenerCount(event: EventKey): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /**
   * Bir sonraki olayı Promise olarak bekler.
   * Tek seferlik async iş akışları için idealdir.
   *
   * @param event    - Beklenen olay
   * @param timeoutMs - Zaman aşımı (varsayılan: 5000ms). 0 = sonsuz bekle.
   *
   * @throws Error — timeout aşılırsa
   *
   * @example
   * // Runtime'ın başlamasını bekle
   * const { executionId } = await bus.waitFor("runtime:started", 3000);
   */
  waitFor<K extends EventKey>(
    event:     K,
    timeoutMs: number = 5_000,
  ): Promise<AppEventMap[K]> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const listener = (payload: AppEventMap[K]) => {
        if (timer) clearTimeout(timer);
        resolve(payload);
      };

      this.once(event, listener);

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.off(event, listener);
          reject(
            new Error(
              `[EventBus] waitFor("${event}") zaman aşımı: ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }
    });
  }

  // ── Yardımcı ─────────────────────────────────────────────────

  /**
   * Listener'ı güvenli şekilde çalıştırır.
   * Senkron throw → onError
   * Async rejection  → onError
   * emit() asla throw etmez.
   */
  private invoke(fn: AnyListener, event: string, payload: unknown): void {
    try {
      const result = fn(payload);
      if (result instanceof Promise) {
        result.catch((error: unknown) => {
          this.errorHandler(event, error);
        });
      }
    } catch (error) {
      this.errorHandler(event, error);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Uygulama geneli tek EventBus instance'ı.
 * DI container kullanılmıyorsa bu factory fonksiyonu tercih edilir.
 *
 * Singleton değil — her çağrıda aynı instance döner ama
 * test ortamında `createEventBus()` ile yeni instance oluşturulabilir.
 */
let appBusInstance: EventBus | null = null;

export function getAppEventBus(): EventBus {
  if (!appBusInstance) {
    appBusInstance = new EventBus();
  }
  return appBusInstance;
}

/**
 * Test izolasyonu için yeni EventBus üretir.
 * Her test suite kendi bus'ını alır; olaylar sızmaz.
 *
 * @example
 * beforeEach(() => {
 *   bus = createEventBus();
 * });
 */
export function createEventBus(): EventBus {
  return new EventBus();
}

/**
 * Uygulama instance'ını sıfırlar.
 * YALNIZCA test ortamında kullanılır.
 */
export function resetAppEventBus(): void {
  appBusInstance = null;
}
