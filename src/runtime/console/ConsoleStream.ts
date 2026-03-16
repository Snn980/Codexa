/**
 * @file     ConsoleStream.ts
 * @module   runtime/console
 * @version  1.0.0
 * @since    Phase 2 — Runtime Sandbox
 *
 * @description
 *   Runtime worker'dan gelen IPC STREAM mesajlarını alır,
 *   `RingBuffer`'a yazar ve EventBus üzerinden UI'ı bilgilendirir.
 *
 * Veri akışı:
 *
 *   runtime.worker.ts
 *     │  postMessage({ type:"STREAM", chunk: ConsoleChunk })
 *     ▼
 *   ConsoleStream.handleWorkerMessage()
 *     │  RingBuffer.push(entry)
 *     │  eventBus.emit("runtime:output", ...)
 *     ▼
 *   VirtualList.tsx / TerminalScreen.tsx
 *
 * Sorumluluklar:
 *   • Worker mesajlarını tip-güvenli şekilde ayrıştırır.
 *   • Tek bir RingBuffer örneğini yönetir (execution başında temizler).
 *   • Kapasite uyarısı — buffer %90 dolduğunda EventBus'a uyarı gönderir.
 *   • `dispose()` → worker listener'ını kaldırır, buffer'ı temizler.
 *
 * Tasarım kararları:
 *   • `ConsoleStream` EventBus'a bağımlıdır; DI ile enjekte edilir.
 *   • `attachWorker` / `detachWorker` — test kolaylığı için worker
 *     constructor'da değil sonradan bağlanır.
 *   • IPC mesaj tip guard'ları Protocol.ts'den import edilir;
 *     bu dosya kendi parse mantığını tanımlamaz.
 *
 * @example
 *   const stream = new ConsoleStream(eventBus);
 *   stream.attachWorker(runtimeWorker);
 *
 *   // Tüm satırları al (VirtualList ilk render)
 *   const lines = stream.buffer.toArray();
 *
 *   // Abonelik (incremental update)
 *   const unsub = stream.buffer.subscribe((entry) => list.append(entry));
 */

import type { IEventBus, UUID }      from "../../types/core";
import { RingBuffer }                from "./RingBuffer";
import type { ConsoleEntry }         from "./RingBuffer";
import { isIPCStream, isIPCMessage } from "../../ipc/Protocol";
import type { ConsoleChunk }         from "../../ipc/Protocol";
import { SECURITY_LIMITS }           from "../sandbox/SecurityLimits";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Tipler
// ─────────────────────────────────────────────────────────────────────────────

/** Worker arayüzü — gerçek Worker veya test mock'u. */
export interface IWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
  terminate(): void;
}

export interface ConsoleStreamOptions {
  /** Buffer kapasitesi. Varsayılan: SECURITY_LIMITS.CONSOLE_MAX_LINES */
  readonly capacity?: number;
  /**
   * Kapasite uyarı eşiği (0–1 arasında oran).
   * Varsayılan: 0.9 — buffer %90 dolduğunda uyarı gönderilir.
   */
  readonly warnThreshold?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. ConsoleStream
// ─────────────────────────────────────────────────────────────────────────────

export class ConsoleStream {
  readonly buffer:  RingBuffer;

  private readonly _eventBus:      IEventBus;
  private readonly _warnThreshold: number;

  private _worker:         IWorkerLike | null = null;
  private _activeExecId:   UUID | null        = null;
  private _warnFired:      boolean            = false;
  private _isDisposed:     boolean            = false;

  constructor(
    eventBus: IEventBus,
    options:  ConsoleStreamOptions = {},
  ) {
    this._eventBus      = eventBus;
    this._warnThreshold = options.warnThreshold ?? 0.9;
    this.buffer         = new RingBuffer(
      options.capacity ?? SECURITY_LIMITS.CONSOLE_MAX_LINES,
    );
  }

  // ── Worker Bağlantısı ────────────────────────────────────────────────────

  /**
   * Runtime worker'ı bağlar.
   * `onmessage` override edilir — önceki listener varsa önce `detachWorker` çağır.
   *
   * @example
   *   stream.attachWorker(new Worker("runtime.worker.js"));
   */
  attachWorker(worker: IWorkerLike): void {
    if (this._isDisposed) {
      throw new Error("[ConsoleStream] disposed instance'a worker eklenemez");
    }
    if (this._worker) this.detachWorker();

    this._worker            = worker;
    worker.onmessage        = this._handleWorkerMessage.bind(this);
  }

  /** Worker bağlantısını keser. Worker terminate edilmez. */
  detachWorker(): void {
    if (this._worker) {
      this._worker.onmessage = null;
      this._worker           = null;
    }
  }

  // ── Execution Yaşam Döngüsü ─────────────────────────────────────────────

  /**
   * Yeni çalıştırma başlamadan önce çağrılır.
   * Buffer temizlenir, kapasite uyarısı sıfırlanır.
   *
   * @example
   *   eventBus.on("runtime:started", ({ executionId }) => {
   *     stream.beginExecution(executionId);
   *   });
   */
  beginExecution(executionId: UUID): void {
    this._activeExecId = executionId;
    this._warnFired    = false;
    this.buffer.clear();
  }

  /**
   * Çalıştırma bittiğinde çağrılır.
   * Aktif execution ID temizlenir; buffer verisi korunur (UI okuyabilir).
   *
   * @example
   *   eventBus.on("runtime:finished", ({ executionId }) => {
   *     stream.endExecution(executionId);
   *   });
   */
  endExecution(executionId: UUID): void {
    if (this._activeExecId === executionId) {
      this._activeExecId = null;
    }
  }

  // ── Mesaj İşleyici ───────────────────────────────────────────────────────

  private _handleWorkerMessage(event: { data: unknown }): void {
    const msg = event.data;

    if (!isIPCMessage(msg) || !isIPCStream(msg)) return;

    // Yalnızca ConsoleChunk tipindeki STREAM'leri işle
    const chunk = msg.chunk as Partial<ConsoleChunk>;
    if (
      typeof chunk?.executionId !== "string" ||
      typeof chunk?.line        !== "string" ||
      (chunk.stream !== "stdout" && chunk.stream !== "stderr")
    ) {
      return;
    }

    this._writeLine(
      chunk.executionId as UUID,
      chunk.line,
      chunk.stream,
    );
  }

  // ── Yazma ────────────────────────────────────────────────────────────────

  /**
   * Bir satırı buffer'a yazar ve EventBus event'ini ateşler.
   * Worker üzerinden gelmeden doğrudan da çağrılabilir (test / mock).
   *
   * @example
   *   stream.writeLine(executionId, "hello", "stdout");
   */
  writeLine(
    executionId: UUID,
    line:        string,
    stream:      "stdout" | "stderr",
  ): ConsoleEntry {
    return this._writeLine(executionId, line, stream);
  }

  private _writeLine(
    executionId: UUID,
    line:        string,
    stream:      "stdout" | "stderr",
  ): ConsoleEntry {
    const entry = this.buffer.push({ executionId, line, stream });

    // EventBus → TerminalScreen / SettingsScreen
    this._eventBus.emit("runtime:output", { executionId, line, stream });

    // Kapasite uyarısı (tek seferlik)
    if (
      !this._warnFired &&
      this.buffer.size >= this.buffer.capacity * this._warnThreshold
    ) {
      this._warnFired = true;
      this._emitCapacityWarning();
    }

    return entry;
  }

  private _emitCapacityWarning(): void {
    // EventBus'ta doğrudan bir "console:capacity:warning" event'i yok;
    // stderr satırı olarak kullanıcıya göster.
    if (this._activeExecId) {
      this.buffer.push({
        executionId: this._activeExecId,
        line: `⚠ Konsol tamponu %${Math.round(this._warnThreshold * 100)} doldu. ` +
              `En eski ${this.buffer.droppedCount > 0 ? "satırlar siliniyor" : "satırlar silinecek"}.`,
        stream: "stderr",
      });
    }
  }

  // ── Dispose ──────────────────────────────────────────────────────────────

  /**
   * Tüm kaynakları serbest bırakır.
   *
   * @example
   *   // AppContainer.dispose() zincirinde
   *   consoleStream.dispose();
   */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.detachWorker();
    this.buffer.removeAllListeners();
    this._activeExecId = null;
  }

  // ── Durum ─────────────────────────────────────────────────────────────────

  /** Aktif execution ID (çalışma yoksa null). */
  get activeExecutionId(): UUID | null { return this._activeExecId; }

  /** Worker bağlı mı? */
  get isAttached(): boolean { return this._worker !== null; }

  /** Dispose edildi mi? */
  get isDisposed(): boolean { return this._isDisposed; }
}
