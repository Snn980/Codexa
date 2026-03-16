/**
 * @file     Protocol.ts
 * @module   ipc
 * @version  1.0.0
 * @since    Phase 2 — Runtime Sandbox
 *
 * @description
 *   Worker thread IPC mesaj kontratı.
 *   Tüm thread'ler arası iletişim bu şema üzerinden akar;
 *   runtime, language, ai ve indexer worker'ları bu protokolü paylaşır.
 *
 * Mesaj akış şeması:
 *
 *   Main Thread (editor)
 *     │  postMessage({ type:"REQUEST", ... })
 *     ▼
 *   Worker Thread (runtime | language | ai | indexer)
 *     │  postMessage({ type:"RESPONSE" | "STREAM", ... })
 *     ▲
 *
 *   İptal akışı:
 *     Main → Worker: { type:"CANCEL", id: <REQUEST id'si> }
 *     Worker bekleyen iş varsa keser, RESPONSE göndermez.
 *
 * Tasarım kararları:
 *   • Her mesaj çifti (REQUEST↔RESPONSE) aynı `id` değerini taşır.
 *   • STREAM mesajları REQUEST'in `id`'sine ek olarak
 *     sıralı `seq` numarası içerir — kayıp / sıra dışı tespit için.
 *   • `payload` bilinçli olarak `unknown` bırakıldı;
 *     her worker kendi guard'ını uygular (tip daraltma worker içinde).
 *   • Seri hale getirme: JSON (SharedArrayBuffer yok — Expo uyumu).
 *
 * @example — Kod çalıştırma isteği
 *   const msg: IPCRequest<RunPayload> = {
 *     type:    "REQUEST",
 *     id:      createUUID(),
 *     from:    "editor",
 *     to:      "runtime",
 *     ts:      Date.now(),
 *     payload: { executionId, code, timeout: 10_000 },
 *   };
 *   runtimeWorker.postMessage(msg);
 *
 * @example — İptal
 *   const cancel: IPCCancel = {
 *     type: "CANCEL",
 *     id:   <REQUEST id'si>,
 *     from: "editor",
 *     to:   "runtime",
 *     ts:   Date.now(),
 *   };
 */

import type { UUID, AppError } from "../types/core";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Temel Tipler
// ─────────────────────────────────────────────────────────────────────────────

/** Mesajın hangi thread'den geldiği / kime gittiği. */
export type IPCActor =
  | "editor"
  | "runtime"
  | "language"
  | "ai"
  | "indexer";

/** Dört temel mesaj türü. */
export type IPCMessageType =
  | "REQUEST"
  | "RESPONSE"
  | "STREAM"
  | "CANCEL";

/** Tüm IPC mesajlarının ortak alanları. */
interface IPCBase {
  /** Mesaj türü. */
  readonly type: IPCMessageType;
  /**
   * REQUEST için yeni oluşturulan UUID.
   * RESPONSE / STREAM / CANCEL için eşleşen REQUEST'in UUID'si.
   */
  readonly id:   UUID;
  /** Gönderen thread. */
  readonly from: IPCActor;
  /** Alıcı thread. */
  readonly to:   IPCActor;
  /** Unix ms — mesaj oluşturulma zamanı. */
  readonly ts:   number;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Mesaj Türleri
// ─────────────────────────────────────────────────────────────────────────────

/** İş isteği — her çift bir REQUEST ile başlar. */
export interface IPCRequest<P = unknown> extends IPCBase {
  readonly type:    "REQUEST";
  readonly payload: P;
}

/**
 * Tek seferlik yanıt — iş tamamlandığında veya hata oluştuğunda gönderilir.
 * `ok: true`  → `data` dolu, `error` yok.
 * `ok: false` → `error` dolu, `data` yok.
 */
export type IPCResponse<D = unknown> = IPCBase & (
  | { readonly type: "RESPONSE"; readonly ok: true;  readonly data:  D }
  | { readonly type: "RESPONSE"; readonly ok: false; readonly error: AppError }
);

/**
 * Akış mesajı — uzun süren işlerin ara çıktıları için.
 * Örnek: console satırları, AI token'ları, indexer ilerleme.
 * `seq` sıfırdan başlar; alıcı eksik seq tespiti yapabilir.
 * `done: true` son pakettir — ardından RESPONSE beklenmez.
 */
export interface IPCStream<C = unknown> extends IPCBase {
  readonly type:    "STREAM";
  readonly seq:     number;
  readonly done:    boolean;
  readonly chunk:   C;
}

/**
 * İptal isteği — worker mevcut işi durdurur.
 * Worker CANCEL aldıktan sonra o `id` için RESPONSE / STREAM göndermez.
 */
export interface IPCCancel extends IPCBase {
  readonly type: "CANCEL";
}

/** Discriminated union — tüm IPC mesajlarını kapsar. */
export type IPCMessage<P = unknown, D = unknown, C = unknown> =
  | IPCRequest<P>
  | IPCResponse<D>
  | IPCStream<C>
  | IPCCancel;

// ─────────────────────────────────────────────────────────────────────────────
// § 3. Runtime Worker Payload'ları
// ─────────────────────────────────────────────────────────────────────────────

/** editor → runtime: Kod çalıştırma isteği. */
export interface RunPayload {
  /** Çalıştırma oturumunun benzersiz ID'si; tüm event'lerde taşınır. */
  readonly executionId: UUID;
  /** Çalıştırılacak JS kaynak kodu (bundle veya tek dosya). */
  readonly code:        string;
  /** Maksimum çalışma süresi ms cinsinden (varsayılan: 10_000). */
  readonly timeout:     number;
}

/** runtime → editor: Çalıştırma tamamlandı. */
export interface RunResult {
  readonly executionId: UUID;
  readonly durationMs:  number;
  readonly exitCode:    0 | 1;
}

/** runtime → editor STREAM chunk: Tek console satırı. */
export interface ConsoleChunk {
  readonly executionId: UUID;
  readonly line:        string;
  readonly stream:      "stdout" | "stderr";
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Bundler Payload'ları
// ─────────────────────────────────────────────────────────────────────────────

/** editor → runtime: Bundle isteği (multi-file proje). */
export interface BundlePayload {
  readonly executionId: UUID;
  /** Giriş dosyası yolu (proje kökünden göreli). */
  readonly entryPath:   string;
  /** Tüm proje dosyaları — {path → content} haritası. */
  readonly files:       Readonly<Record<string, string>>;
}

/** runtime → editor: Bundle sonucu. */
export interface BundleResult {
  readonly executionId: UUID;
  readonly bundledCode: string;
  readonly sizeBytes:   number;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. Tip Guard'ları
// ─────────────────────────────────────────────────────────────────────────────

/** Gelen `unknown` değerin geçerli bir IPCMessage olup olmadığını doğrular. */
export function isIPCMessage(value: unknown): value is IPCMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m["id"]   === "string" &&
    typeof m["from"] === "string" &&
    typeof m["to"]   === "string" &&
    typeof m["ts"]   === "number" &&
    (m["type"] === "REQUEST"  ||
     m["type"] === "RESPONSE" ||
     m["type"] === "STREAM"   ||
     m["type"] === "CANCEL")
  );
}

export function isIPCRequest(msg: IPCMessage): msg is IPCRequest {
  return msg.type === "REQUEST";
}

export function isIPCResponse(msg: IPCMessage): msg is IPCResponse {
  return msg.type === "RESPONSE";
}

export function isIPCStream(msg: IPCMessage): msg is IPCStream {
  return msg.type === "STREAM";
}

export function isIPCCancel(msg: IPCMessage): msg is IPCCancel {
  return msg.type === "CANCEL";
}

// ─────────────────────────────────────────────────────────────────────────────
// § 6. Builder Yardımcıları
// ─────────────────────────────────────────────────────────────────────────────

/**
 * REQUEST mesajı oluşturur.
 *
 * @example
 *   const msg = buildRequest(createUUID(), "editor", "runtime", runPayload);
 *   runtimeWorker.postMessage(msg);
 */
export function buildRequest<P>(
  id:      UUID,
  from:    IPCActor,
  to:      IPCActor,
  payload: P,
): IPCRequest<P> {
  return { type: "REQUEST", id, from, to, ts: Date.now(), payload };
}

/**
 * Başarılı RESPONSE mesajı oluşturur.
 *
 * @example
 *   self.postMessage(buildResponse(msg.id, "runtime", "editor", result));
 */
export function buildResponse<D>(
  id:   UUID,
  from: IPCActor,
  to:   IPCActor,
  data: D,
): IPCResponse<D> {
  return { type: "RESPONSE", id, from, to, ts: Date.now(), ok: true, data };
}

/**
 * Hatalı RESPONSE mesajı oluşturur.
 *
 * @example
 *   self.postMessage(buildErrorResponse(msg.id, "runtime", "editor", appError));
 */
export function buildErrorResponse(
  id:    UUID,
  from:  IPCActor,
  to:    IPCActor,
  error: AppError,
): IPCResponse<never> {
  return { type: "RESPONSE", id, from, to, ts: Date.now(), ok: false, error };
}

/**
 * STREAM chunk mesajı oluşturur.
 *
 * @example
 *   self.postMessage(buildStream(msg.id, "runtime", "editor", seq, chunk, false));
 */
export function buildStream<C>(
  id:    UUID,
  from:  IPCActor,
  to:    IPCActor,
  seq:   number,
  chunk: C,
  done:  boolean,
): IPCStream<C> {
  return { type: "STREAM", id, from, to, ts: Date.now(), seq, chunk, done };
}

/**
 * CANCEL mesajı oluşturur.
 *
 * @example
 *   runtimeWorker.postMessage(buildCancel(executionId, "editor", "runtime"));
 */
export function buildCancel(
  id:   UUID,
  from: IPCActor,
  to:   IPCActor,
): IPCCancel {
  return { type: "CANCEL", id, from, to, ts: Date.now() };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 7. PendingRequest Tracker — Ana Thread Tarafı
// ─────────────────────────────────────────────────────────────────────────────

type ResponseHandler<D>  = (response: IPCResponse<D>) => void;
type StreamHandler<C>    = (stream:   IPCStream<C>)   => void;

interface PendingEntry<D = unknown, C = unknown> {
  onResponse: ResponseHandler<D>;
  onStream?:  StreamHandler<C>;
  timeoutId:  ReturnType<typeof setTimeout>;
  /** Timeout response'unda doğru `from` aktörünü belirtmek için. */
  to:         IPCActor;
}

/**
 * Ana thread'de bekleyen REQUEST'leri takip eder.
 * Gelen her mesajı `dispatch()` ile işle.
 *
 * @example
 *   const tracker = new PendingRequestTracker();
 *
 *   worker.onmessage = (e) => tracker.dispatch(e.data);
 *
 *   tracker.register(requestId, {
 *     onResponse: (resp) => { ... },
 *     onStream:   (strm) => appendLine(strm.chunk),
 *     timeoutMs:  10_000,
 *   });
 */
export class PendingRequestTracker {
  private readonly _pending = new Map<UUID, PendingEntry>();

  /**
   * Yeni bir REQUEST'i kaydeder.
   * `timeoutMs` süresi dolduğunda `onResponse` hata yanıtıyla çağrılır
   * ve kayıt otomatik temizlenir.
   */
  register<D, C>(
    id: UUID,
    opts: {
      onResponse: ResponseHandler<D>;
      onStream?:  StreamHandler<C>;
      timeoutMs:  number;
      /** Hangi aktöre request gönderildi (timeout response'unda from olarak kullanılır). */
      to:         IPCActor;
    },
  ): void {
    // BUG 2 FIX: Aynı ID zaten kayıtlıysa önce eski timeout'u temizle.
    const existing = this._pending.get(id);
    if (existing) {
      clearTimeout(existing.timeoutId);
      this._pending.delete(id);
    }

    const timeoutId = setTimeout(() => {
      const entry = this._pending.get(id);
      if (!entry) return;
      this._pending.delete(id);
      // BUG 7 FIX: from = hedef aktör (worker), to = "editor" (caller).
      (entry.onResponse as ResponseHandler<unknown>)({
        type:  "RESPONSE",
        id,
        from:  entry.to,     // worker'dan geliyormuş gibi modellenir
        to:    "editor",
        ts:    Date.now(),
        ok:    false,
        error: {
          code:      "EXECUTION_TIMEOUT",
          message:   `IPC request timed out after ${opts.timeoutMs}ms`,
          timestamp: Date.now(),
        },
      });
    }, opts.timeoutMs);

    this._pending.set(id, {
      onResponse: opts.onResponse as ResponseHandler<unknown>,
      onStream:   opts.onStream   as StreamHandler<unknown> | undefined,
      timeoutId,
      to:         opts.to,
    });
  }

  /** Worker'dan gelen mesajı ilgili handler'a yönlendirir. */
  dispatch(msg: unknown): void {
    if (!isIPCMessage(msg)) return;
    if (msg.type === "REQUEST" || msg.type === "CANCEL") return;

    const entry = this._pending.get(msg.id);
    if (!entry) return;

    if (msg.type === "STREAM") {
      entry.onStream?.(msg as IPCStream<unknown>);
      if (msg.done) {
        clearTimeout(entry.timeoutId);
        this._pending.delete(msg.id);
      }
      return;
    }

    // RESPONSE — işi bitir
    clearTimeout(entry.timeoutId);
    this._pending.delete(msg.id);
    entry.onResponse(msg as IPCResponse<unknown>);
  }

  /**
   * Bekleyen tüm istekleri iptal eder ve her caller'a EXECUTION_TIMEOUT
   * hata yanıtı gönderir (dispose / uygulama kapatma senaryosu).
   * Sessiz drop yerine caller'ın temiz kapanabilmesi için gerekli.
   */
  cancelAll(): void {
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timeoutId);
      entry.onResponse({
        type:  "RESPONSE",
        id,
        from:  entry.to,
        to:    "editor",
        ts:    Date.now(),
        ok:    false,
        error: {
          code:      "EXECUTION_TIMEOUT",
          message:   "IPC tracker disposed — tüm bekleyen istekler iptal edildi",
          timestamp: Date.now(),
        },
      });
    }
    this._pending.clear();
  }

  /** Kaç istek bekliyor. */
  get pendingCount(): number {
    return this._pending.size;
  }
}
