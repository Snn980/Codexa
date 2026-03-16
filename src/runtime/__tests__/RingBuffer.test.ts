/**
 * @file     RingBuffer.test.ts
 * @module   runtime/console/__tests__
 * @version  1.0.0
 * @since    Phase 2 — Runtime Sandbox
 *
 * Test kapsamı:
 *   § 1  Constructor & kapasite doğrulama
 *   § 2  push() — dolmamış buffer
 *   § 3  push() — tam dolu buffer (circular overwrite)
 *   § 4  push() — seq monotonic garantisi
 *   § 5  toArray() — sıralı çıktı
 *   § 6  since() — incremental sorgulama
 *   § 7  forExecution() — executionId filtresi
 *   § 8  clear() — seq korunur, count sıfırlanır
 *   § 9  subscribe() / unsubscribe
 *   § 10 removeAllListeners()
 *   § 11 readonly özellikler (size, isEmpty, isFull, droppedCount, capacity, nextSeq)
 *   § 12 listener hatası buffer'ı bozmamalı
 *   § 13 sınır vakaları — kapasitesi 1, büyük batch
 */

import { RingBuffer }              from "../console/RingBuffer";
import type { ConsoleEntry }       from "../console/RingBuffer";
import { SECURITY_LIMITS }         from "../sandbox/SecurityLimits";

// ─────────────────────────────────────────────────────────────────────────────
// Test yardımcıları
// ─────────────────────────────────────────────────────────────────────────────

const EXEC_A = "exec-aaaa-1111" as ConsoleEntry["executionId"];
const EXEC_B = "exec-bbbb-2222" as ConsoleEntry["executionId"];

function makeEntry(
  line:        string,
  executionId: ConsoleEntry["executionId"] = EXEC_A,
  stream:      "stdout" | "stderr"         = "stdout",
): Omit<ConsoleEntry, "ts" | "seq"> {
  return { line, executionId, stream };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Constructor & kapasite doğrulama
// ─────────────────────────────────────────────────────────────────────────────

describe("RingBuffer — constructor", () => {
  test("varsayılan kapasite SECURITY_LIMITS.CONSOLE_MAX_LINES'a eşit", () => {
    const buf = new RingBuffer();
    expect(buf.capacity).toBe(SECURITY_LIMITS.CONSOLE_MAX_LINES);
  });

  test("özel kapasite atanır", () => {
    const buf = new RingBuffer(42);
    expect(buf.capacity).toBe(42);
  });

  test("kapasitesi 1 geçerli", () => {
    const buf = new RingBuffer(1);
    expect(buf.capacity).toBe(1);
  });

  test("kapasite 0 → RangeError fırlatır", () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
  });

  test("kapasite negatif → RangeError fırlatır", () => {
    expect(() => new RingBuffer(-5)).toThrow(RangeError);
  });

  test("başlangıçta boş", () => {
    const buf = new RingBuffer(10);
    expect(buf.isEmpty).toBe(true);
    expect(buf.isFull).toBe(false);
    expect(buf.size).toBe(0);
    expect(buf.droppedCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 2. push() — dolmamış buffer
// ─────────────────────────────────────────────────────────────────────────────

describe("RingBuffer — push (dolmamış)", () => {
  test("dönen entry input alanlarını içerir", () => {
    const buf   = new RingBuffer(10);
    const entry = buf.push(makeEntry("hello"));
    expect(entry.line).toBe("hello");
    expect(entry.executionId).toBe(EXEC_A);
    expect(entry.stream).toBe("stdout");
  });

  test("dönen entry ts ve seq alanlarını ekler", () => {
    const buf   = new RingBuffer(10);
    const before = Date.now();
    const entry  = buf.push(makeEntry("ts test"));
    const after  = Date.now();
    expect(entry.ts).toBeGreaterThanOrEqual(before);
    expect(entry.ts).toBeLessThanOrEqual(after);
    expect(typeof entry.seq).toBe("number");
  });

  test("size her push'ta artar", () => {
    const buf = new RingBuffer(10);
    buf.push(makeEntry("a"));
    buf.push(makeEntry("b"));
    buf.push(makeEntry("c"));
    expect(buf.size).toBe(3);
  });

  test("kapasiteye ulaşınca isFull true olur", () => {
    const buf = new RingBuffer(3);
    buf.push(makeEntry("1"));
    buf.push(makeEntry("2"));
    expect(buf.isFull).toBe(false);
    buf.push(makeEntry("3"));
    expect(buf.isFull).toBe(true);
  });

  test("droppedCount dolmadan 0 kalır", () => {
    const buf = new RingBuffer(5);
    buf.push(makeEntry("a"));
    buf.push(makeEntry("b"));
    expect(buf.droppedCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 3. push() — circular overwrite
// ─────────────────────────────────────────────────────────────────────────────

describe("RingBuffer — push (circular overwrite)", () => {
  test("kapasitesi dolunca en eski satır silinir", () => {
    const buf = new RingBuffer(3);
    buf.push(makeEntry("first"));
    buf.push(makeEntry("second"));
    buf.push(makeEntry("third"));
    buf.push(makeEntry("fourth")); // "first" overwrite edilmeli

    const lines = buf.toArray().map((e) => e.line);
    expect(lines).toEqual(["second", "third", "fourth"]);
  });

  test("droppedCount overwrite sayısını izler", () => {
    const buf = new RingBuffer(3);
    buf.push(makeEntry("a"));
    buf.push(makeEntry("b"));
    buf.push(makeEntry("c"));
    buf.push(makeEntry("d")); // +1 drop
    buf.push(makeEntry("e")); // +1 drop
    expect(buf.droppedCount).toBe(2);
  });

  test("size kapasiteyi aşmaz", () => {
    const buf = new RingBuffer(3);
    for (let i = 0; i < 10; i++) buf.push(makeEntry(`line-${i}`));
    expect(buf.size).toBe(3);
  });

  test("tam tur sonrası toArray hâlâ sıralı döner", () => {
    const cap = 4;
    const buf = new RingBuffer(cap);
    // 2 tam tur = 8 push
    for (let i = 0; i < 8; i++) buf.push(makeEntry(`line-${i}`));
    // Son 4 satır beklenir: 4,5,6,7
    const lines = buf.toArray().map((e) => e.line);
    expect(lines).toEqual(["line-4", "line-5", "line-6", "line-7"]);
  });

  test("kapasitesi 1 olan buffer: son push'un değeri döner", () => {
    const buf = new RingBuffer(1);
    buf.push(makeEntry("first"));
    buf.push(makeEntry("last"));
    expect(buf.toArray()[0]?.line).toBe("last");
    expect(buf.droppedCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 4. push() — seq monotonic garantisi
// ─────────────────────────────────────────────────────────────────────────────

describe("RingBuffer — seq monotonic", () => {
  test("seq 0'dan başlar ve her push'ta 1 artar", () => {
    const buf = new RingBuffer(10);
    const e0  = buf.push(makeEntry("a"));
    const e1  = buf.push(makeEntry("b"));
    const e2  = buf.push(makeEntry("c"));
    expect(e0.seq).toBe(0);
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
  });

  test("nextSeq her zaman bir sonraki seq değerini gösterir", () => {
    const buf = new RingBuffer(10);
    expect(buf.nextSeq).toBe(0);
    buf.push(makeEntry("a"));
    expect(buf.nextSeq).toBe(1);
    buf.push(makeEntry("b"));
    expect(buf.nextSeq).toBe(2);
  });

  test("overwrite sırasında seq devam eder (eski seq'ler kaybolmaz, yenileri artar)", () => {
    const buf = new RingBuffer(2);
    buf.push(makeEntry("a")); // seq=0
    buf.push(makeEntry("b")); // seq=1
    const e2 = buf.push(makeEntry("c")); // seq=2, "a" overwrite
    const e3 = buf.push(makeEntry("d")); // seq=3, "b" overwrite
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
    expect(buf.nextSeq).toBe(4);
  });

  test("clear() sonrası seq sıfırlanmaz", () => {
    const buf = new RingBuffer(10);
    buf.push(makeEntry("a")); // seq=0
    buf.push(makeEntry("b")); // seq=1
    buf.clear();
    const e = buf.push(makeEntry("c")); // seq=2 olmalı
    expect(e.seq).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 5. toArray()
// ─────────────────────────────────────────────────────────────────────────────

describe("RingBuffer — toArray()", () => {
  test("boş buffer → boş dizi döner", () => {
    expect(new RingBuffer(10).toArray()).toEqual([]);
  });

  test("sıralama en eskiden en yeniye", () => {
    const buf = new RingBuffer(5);
    ["a", "b", "c"].forEach((l) => buf.push(makeEntry(l)));
    const lines = buf.toArray().map((e) => e.line);
    expect(lines).toEqual(["a", "b", "c"]);
  });

  test("dönen dizi bağımsız — mutate etmek buffer'ı bozmaz", () => {
    const buf = new RingBuffer(5);
    buf.push(makeEntry("original"));
    const arr = buf.toArray();
    arr.splice(0); // tamamen boşalt
    expect(buf.size).toBe(1); // buffer etkilenmemeli
    expect(buf.toArray().length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 6. since()
// ─────────────────────────────────────────────────────────────────────────────

describe("RingBuffer — since()", () => {
  test("since(0) tüm girişleri döner", () => {
    const buf = new RingBuffer(10);
    buf.push(makeEntry("a"));
    buf.push(makeEntry("b"));
    expect(buf.since(0).length).toBe(2);
  });

  test("since(n) yalnızca seq >= n girişleri döner", () => {
    const buf = new RingBuffer(10);
    buf.push(makeEntry("a")); // seq=0
    buf.push(makeEntry("b")); // seq=1
    buf.push(makeEntry("c")); // seq=2
    const result = buf.since(2);
    expect(result.length).toBe(1);
    expect(result[0]?.line).toBe("c");
  });

  test("since(nextSeq) boş dizi döner", () => {
    const buf = new RingBuffer(10);
    buf.push(makeEntry("a"));
    expect(buf.since(buf.nextSeq).length).toBe(0);
  });

  test("clear() + push sonrası since(lastSeenSeq + 1) doğru çalışır", () => {
    const buf  = new RingBuffer(10);
    buf.push(makeEntry("a")); // seq=0
    buf.push(makeEntry("b")); // seq=1
    const lastSeen = buf.nextSeq - 1; // 1
    buf.clear();
    buf.push(makeEntry("c")); // seq=2
    buf.push(makeEntry("d")); // seq=3

    const fresh = buf.since(lastSeen + 1); // seq >= 2
    expect(fresh.map((e) => e.line)).toEqual(["c", "d"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 7. forExecution()
// ─────────────────────────────────────────────────────────────────────────────

describe("RingBuffer — forExecution()", () => {
  test("belirtilen executionId'ye ait satırları döner", () => {
    const buf = new RingBuffer(20);
    buf.push(makeEntry("a1", EXEC_A));
    buf.push(makeEntry("b1", EXEC_B));
    buf.push(makeEntry("a2", EXEC_A));
    buf.push(makeEntry("b2", EXEC_B));

    const aLines = buf.forExecution(EXEC_A).map((e) => e.line);
    const bLines = buf.forExecution(EXEC_B).map((e) => e.line);

    expect(aLines).toEqual(["a1", "a2"]);
    expect(bLines).toEqual(["b1", "b2"]);
  });

  test("executionId yoksa boş dizi döner", () => {
    const buf = new RingBuffer(10);
    buf.push(makeEntry("a", EXEC_A));
    expect(buf.forExecution(EXEC_B).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 8. clear()
// ─────────────────────────────────────────────────────────────────────────────

describe("RingBuffer — clear()", () => {
  test("clear sonrası buffer boş", () => {
    const buf = new RingBuffer(10);
    buf.push(makeEntry("a"));
    buf.push(makeEntry("b"));
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.isEmpty).toBe(true);
    expect(buf.toArray()).toEqual([]);
  });

  test("droppedCount sıfırlanır", () => {
    const buf = new RingBuffer(2);
    buf.push(makeEntry("a"));
    buf.push(makeEntry("b"));
    buf.push(makeEntry("c")); // drop++
    expect(buf.droppedCount).toBe(1);
    buf.clear();
    expect(buf.droppedCount).toBe(0);
  });

  test("seq sıfırlanmaz — monotonic korunur", () => {
    const buf = new RingBuffer(10);
    buf.push(makeEntry("a")); // seq=0
    buf.push(makeEntry("b")); // seq=1
    buf.clear();
    expect(buf.nextSeq).toBe(2); // seq sıfırlanmamalı
  });

  test("listener'lar korunur", () => {
    const buf      = new RingBuffer(10);
    const received: string[] = [];
    buf.subscribe((e) => received.push(e.line));

    buf.push(makeEntry("before"));
    buf.clear();
    buf.push(makeEntry("after"));

    expect(received).toEqual(["before", "after"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 9. subscribe() / unsubscribe
// ─────────────────────────────────────────────────────────────────────────────

describe("RingBuffer — subscribe()", () => {
  test("push yeni entry ile listener'ı çağırır", () => {
    const buf     = new RingBuffer(10);
    const calls: ConsoleEntry[] = [];
    buf.subscribe((e) => calls.push(e));
    buf.push(makeEntry("hello"));
    expect(calls.length).toBe(1);
    expect(calls[0]?.line).toBe("hello");
  });

  test("unsubscribe sonrası listener çağrılmaz", () => {
    const buf     = new RingBuffer(10);
    const calls: string[] = [];
    const unsub   = buf.subscribe((e) => calls.push(e.line));
    buf.push(makeEntry("a"));
    unsub();
    buf.push(makeEntry("b"));
    expect(calls).toEqual(["a"]);
  });

  test("birden fazla listener bağımsız çalışır", () => {
    const buf  = new RingBuffer(10);
    const log1: string[] = [];
    const log2: string[] = [];
    buf.subscribe((e) => log1.push(e.line));
    buf.subscribe((e) => log2.push(e.line));
    buf.push(makeEntry("x"));
    expect(log1).toEqual(["x"]);
    expect(log2).toEqual(["x"]);
  });

  test("subscribe dönen unsub idempotent — iki kez çağrılabilir", () => {
    const buf   = new RingBuffer(10);
    const calls: string[] = [];
    const unsub = buf.subscribe((e) => calls.push(e.line));
    unsub();
    expect(() => unsub()).not.toThrow();
    buf.push(makeEntry("z"));
    expect(calls.length).toBe(0);
  });

  test("listenerCount doğru", () => {
    const buf   = new RingBuffer(10);
    expect(buf.listenerCount).toBe(0);
    const unsub = buf.subscribe(() => {});
    expect(buf.listenerCount).toBe(1);
    buf.subscribe(() => {});
    expect(buf.listenerCount).toBe(2);
    unsub();
    expect(buf.listenerCount).toBe(1);
  });

  test("push sırasında listener eklenmesi güvenli (snapshot iteration)", () => {
    const buf    = new RingBuffer(10);
    const calls: string[] = [];
    buf.subscribe(() => {
      // listener içinde başka bir listener ekle
      buf.subscribe((e) => calls.push(`nested:${e.line}`));
    });
    buf.push(makeEntry("trigger"));
    // Nested listener henüz bu push'u görmemeli (snapshot alınmıştı)
    expect(calls.length).toBe(0);
    // Bir sonraki push'ta nested aktif olur
    buf.push(makeEntry("second"));
    expect(calls).toContain("nested:second");
  });

  test("push sırasında unsubscribe güvenli (snapshot iteration)", () => {
    const buf    = new RingBuffer(10);
    const calls: string[] = [];
    let unsub: (() => void) | null = null;
    unsub = buf.subscribe((e) => {
      calls.push(e.line);
      // kendini push içinde kaldır
      unsub?.();
    });
    buf.push(makeEntry("once"));
    buf.push(makeEntry("twice"));
    expect(calls).toEqual(["once"]); // ikinci push'ta artık dinlemez
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 10. removeAllListeners()
// ─────────────────────────────────────────────────────────────────────────────

describe("RingBuffer — removeAllListeners()", () => {
  test("tüm listener'ları kaldırır", () => {
    const buf  = new RingBuffer(10);
    const log: string[] = [];
    buf.subscribe((e) => log.push(e.line));
    buf.subscribe((e) => log.push(e.line));
    buf.removeAllListeners();
    buf.push(makeEntry("after"));
    expect(log.length).toBe(0);
    expect(buf.listenerCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 11. Readonly özellikler
// ─────────────────────────────────────────────────────────────────────────────

describe("RingBuffer — readonly özellikler", () => {
  test("size, isEmpty, isFull, capacity tutarlı", () => {
    const buf = new RingBuffer(3);
    expect(buf.size).toBe(0);
    expect(buf.isEmpty).toBe(true);
    expect(buf.isFull).toBe(false);

    buf.push(makeEntry("a"));
    buf.push(makeEntry("b"));
    buf.push(makeEntry("c"));
    expect(buf.size).toBe(3);
    expect(buf.isEmpty).toBe(false);
    expect(buf.isFull).toBe(true);
    expect(buf.capacity).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 12. Listener hatası buffer'ı bozmamalı
// ─────────────────────────────────────────────────────────────────────────────

describe("RingBuffer — listener hatası yalıtımı", () => {
  test("hata fırlatan listener diğer listener'ları engellemez", () => {
    const buf       = new RingBuffer(10);
    const goodLog: string[] = [];

    buf.subscribe(() => { throw new Error("listener crashed"); });
    buf.subscribe((e) => goodLog.push(e.line));

    expect(() => buf.push(makeEntry("test"))).not.toThrow();
    expect(goodLog).toEqual(["test"]);
  });

  test("hata sonrası push işlemi başarıyla tamamlanır", () => {
    const buf = new RingBuffer(10);
    buf.subscribe(() => { throw new Error("crash"); });

    const entry = buf.push(makeEntry("safe"));
    expect(entry.line).toBe("safe");
    expect(buf.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 13. Sınır vakaları
// ─────────────────────────────────────────────────────────────────────────────

describe("RingBuffer — sınır vakaları", () => {
  test("kapasite 1: overwrite + seq + droppedCount", () => {
    const buf = new RingBuffer(1);
    const e0  = buf.push(makeEntry("first"));
    const e1  = buf.push(makeEntry("second"));
    expect(e0.seq).toBe(0);
    expect(e1.seq).toBe(1);
    expect(buf.toArray()[0]?.line).toBe("second");
    expect(buf.droppedCount).toBe(1);
  });

  test("10K satır push — size ve droppedCount tutarlı", () => {
    const cap = 1_000;
    const buf = new RingBuffer(cap);
    const pushCount = 10_000;

    for (let i = 0; i < pushCount; i++) buf.push(makeEntry(`line-${i}`));

    expect(buf.size).toBe(cap);
    expect(buf.droppedCount).toBe(pushCount - cap);
    expect(buf.toArray().length).toBe(cap);
  });

  test("10K satırda toArray sıralı seq içerir", () => {
    const cap = 500;
    const buf = new RingBuffer(cap);
    for (let i = 0; i < 1000; i++) buf.push(makeEntry(`line-${i}`));

    const arr = buf.toArray();
    for (let i = 1; i < arr.length; i++) {
      expect(arr[i]!.seq).toBeGreaterThan(arr[i - 1]!.seq);
    }
  });

  test("stdout / stderr ayrımı korunur", () => {
    const buf = new RingBuffer(10);
    buf.push(makeEntry("out", EXEC_A, "stdout"));
    buf.push(makeEntry("err", EXEC_A, "stderr"));
    const arr = buf.toArray();
    expect(arr[0]?.stream).toBe("stdout");
    expect(arr[1]?.stream).toBe("stderr");
  });
});
