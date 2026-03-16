/**
 * @file     RingBuffer.ts
 * @module   runtime/console
 * @version  1.0.0
 * @since    Phase 2 — Runtime Sandbox
 *
 * @description
 *   Sabit kapasiteli dairesel tampon — konsol çıktısını saklar.
 *   Dolduğunda en eski satırı silerek yeni satır ekler (FIFO overwrite).
 *
 * Özellikler:
 *   • Sabit MAX_LINES kapasitesi (varsayılan: SECURITY_LIMITS.CONSOLE_MAX_LINES)
 *   • O(1) push, O(1) size — dizi yeniden boyutlandırma yok
 *   • `toArray()` → ekrana sıralı gösterim için `ConsoleEntry[]`
 *   • `subscribe` → yeni satır geldiğinde UI'ı bilgilendirir (VirtualList)
 *   • Çok execution arasında temizlenebilir (`clear()`)
 *   • Thread-safe değil (tek thread kullanımı için tasarlandı);
 *     Worker → Main mesajlaşması zaten sıralıdır.
 *
 * Tasarım kararları:
 *   • `head` ve `count` ile klasik ring buffer implementasyonu;
 *     JS dizisi sabit uzunlukta tutulur — GC baskısı minimumdur.
 *   • `subscribe` snapshot iteration kullanır (EventBus ile aynı pattern);
 *     listener eklenip çıkarılırken push güvenlidir.
 *   • `executionId` her satırda tutulur — birden fazla çalıştırma
 *     çıktısı aynı buffer'da karışsa dahi filtrele.
 *
 * @example
 *   const buffer = new RingBuffer();
 *
 *   const unsub = buffer.subscribe((entry) => {
 *     virtualList.append(entry);
 *   });
 *
 *   buffer.push({ executionId, line: "hello", stream: "stdout" });
 *   console.log(buffer.size);   // 1
 *   console.log(buffer.isFull); // false
 *
 *   buffer.clear();
 *   unsub();
 */

import type { UUID } from "../../types/core";
import { SECURITY_LIMITS } from "../sandbox/SecurityLimits";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Tipler
// ─────────────────────────────────────────────────────────────────────────────

export interface ConsoleEntry {
  /** Hangi çalıştırmaya ait. */
  readonly executionId: UUID;
  /** Satır içeriği — NativeGuard tarafından zaten kısaltılmış. */
  readonly line:        string;
  /** stdout → normal; stderr → hata / uyarı. */
  readonly stream:      "stdout" | "stderr";
  /** Unix ms — satırın geldiği zaman. */
  readonly ts:          number;
  /**
   * Buffer içindeki global sıra numarası.
   * VirtualList'in stable key'i; UI yeniden sıralama yapamaz.
   */
  readonly seq:         number;
}

export type RingBufferListener = (entry: ConsoleEntry) => void;

// ─────────────────────────────────────────────────────────────────────────────
// § 2. RingBuffer
// ─────────────────────────────────────────────────────────────────────────────

export class RingBuffer {
  private readonly _capacity: number;
  private readonly _buffer:   (ConsoleEntry | undefined)[];
  private _head:    number = 0;   // en eski öğenin indeksi
  private _count:   number = 0;   // mevcut öğe sayısı
  private _seq:     number = 0;   // global sıra (sıfırlanmaz)
  private _dropped: number = 0;   // kapasite dolduğu için silinen satır sayısı

  private readonly _listeners: Set<RingBufferListener> = new Set();

  /**
   * @param capacity — Maksimum satır sayısı.
   *                   Varsayılan: SECURITY_LIMITS.CONSOLE_MAX_LINES (10_000)
   */
  constructor(capacity: number = SECURITY_LIMITS.CONSOLE_MAX_LINES) {
    if (capacity < 1) throw new RangeError("RingBuffer: capacity en az 1 olmalı");
    this._capacity = capacity;
    this._buffer   = new Array<ConsoleEntry | undefined>(capacity).fill(undefined);
  }

  // ── Yazma ────────────────────────────────────────────────────────────────

  /**
   * Yeni bir satır ekler.
   * Buffer doluysa en eski satır silinerek yeri açılır (`_dropped` artar).
   *
   * @example
   *   buffer.push({ executionId, line: "hello", stream: "stdout" });
   */
  push(input: Omit<ConsoleEntry, "ts" | "seq">): ConsoleEntry {
    const entry: ConsoleEntry = {
      ...input,
      ts:  Date.now(),
      seq: this._seq++,
    };

    const writeIndex = (this._head + this._count) % this._capacity;

    if (this._count < this._capacity) {
      // Dolmamış — doğrudan yaz
      this._buffer[writeIndex] = entry;
      this._count++;
    } else {
      // Dolu — head'in üstüne yaz, head'i ilerlet
      this._buffer[this._head] = entry;
      this._head = (this._head + 1) % this._capacity;
      this._dropped++;
    }

    // Listener'ları bilgilendir (snapshot — güvenli iterasyon)
    const snapshot = [...this._listeners];
    for (const listener of snapshot) {
      try { listener(entry); } catch { /* listener hatası buffer'ı bozmaz */ }
    }

    return entry;
  }

  // ── Okuma ────────────────────────────────────────────────────────────────

  /**
   * Buffer içeriğini en eskiden en yeniye sıralı dizi olarak döner.
   * Her çağrıda yeni dizi oluşturulur — `toArray()` sonucunu mutate etmek güvenlidir.
   *
   * @example
   *   const lines = buffer.toArray();
   *   // lines[0] en eski, lines[lines.length-1] en yeni
   */
  toArray(): ConsoleEntry[] {
    const result: ConsoleEntry[] = new Array(this._count);
    for (let i = 0; i < this._count; i++) {
      result[i] = this._buffer[(this._head + i) % this._capacity]!;
    }
    return result;
  }

  /**
   * `seq >= fromSeq` olan girişleri döner.
   * VirtualList incremental güncelleme için kullanır.
   *
   * @example
   *   // Son bilinen seq'den sonrasını al
   *   const newEntries = buffer.since(lastSeenSeq + 1);
   */
  since(fromSeq: number): ConsoleEntry[] {
    return this.toArray().filter((e) => e.seq >= fromSeq);
  }

  /**
   * Belirli bir executionId'ye ait tüm satırları döner.
   *
   * @example
   *   const lines = buffer.forExecution(executionId);
   */
  forExecution(executionId: UUID): ConsoleEntry[] {
    return this.toArray().filter((e) => e.executionId === executionId);
  }

  // ── Durum ─────────────────────────────────────────────────────────────────

  /** Mevcut öğe sayısı. */
  get size(): number { return this._count; }

  /** Buffer tamamen doldu mu? */
  get isFull(): boolean { return this._count === this._capacity; }

  /** Buffer boş mu? */
  get isEmpty(): boolean { return this._count === 0; }

  /** Kapasite dolduğu için kaç satır silindi. */
  get droppedCount(): number { return this._dropped; }

  /** Bir sonraki push'un alacağı seq numarası. */
  get nextSeq(): number { return this._seq; }

  /** Maksimum kapasite. */
  get capacity(): number { return this._capacity; }

  // ── Temizleme ─────────────────────────────────────────────────────────────

  /**
   * Buffer'ı temizler — yeni çalıştırma başlamadan önce çağrılır.
   * `_dropped` sıfırlanır; listener'lar korunur.
   *
   * BUG 6 FIX: `_seq` sıfırlanmıyor. Monotonic artış korunur.
   * `since(lastSeenSeq + 1)` clear sonrasında da doğru çalışır —
   * yeni seq'ler her zaman önceki seq'lerden büyük olur.
   *
   * @example
   *   eventBus.on("runtime:started", () => buffer.clear());
   */
  clear(): void {
    this._buffer.fill(undefined);
    this._head    = 0;
    this._count   = 0;
    // _seq sıfırlanmıyor — monotonic garantisi
    this._dropped = 0;
  }

  // ── Abonelik ─────────────────────────────────────────────────────────────

  /**
   * Yeni satır geldiğinde çağrılacak listener ekler.
   * Dönen fonksiyon çağrılarak abonelik iptal edilir.
   *
   * @example
   *   const unsub = buffer.subscribe((entry) => ui.append(entry));
   *   // ...
   *   unsub(); // temizlik
   */
  subscribe(listener: RingBufferListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Tüm listener'ları kaldırır. Dispose senaryosu için. */
  removeAllListeners(): void {
    this._listeners.clear();
  }

  /** Aktif listener sayısı (diagnostik). */
  get listenerCount(): number {
    return this._listeners.size;
  }
}
