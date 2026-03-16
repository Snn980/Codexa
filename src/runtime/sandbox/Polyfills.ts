/**
 * @file     Polyfills.ts
 * @module   runtime/sandbox
 * @version  1.0.0
 * @since    Phase 2 — Runtime Sandbox
 *
 * @description
 *   QuickJS sandbox'ına enjekte edilen minimal tarayıcı / Node.js polyfill'leri.
 *   Kullanıcı kodu yaygın global'lara erişebilir; bunlar sandbox'ın
 *   dışına sızmaz.
 *
 * Enjekte edilen API'lar:
 *   • console         — log / warn / error / info / debug → ConsoleStream'e yazar
 *   • setTimeout      — tek seferlik gecikme (clearTimeout ile iptal edilebilir)
 *   • setInterval     — tekrarlı zamanlayıcı (clearInterval ile iptal edilebilir)
 *   • clearTimeout    — zamanlayıcı iptali
 *   • clearInterval   — zamanlayıcı iptali
 *   • queueMicrotask  — Promise tabanlı erteleme
 *   • structuredClone — derin kopya
 *   • URL             — URL parse (minimal)
 *   • TextEncoder     — UTF-8 encode
 *   • TextDecoder     — UTF-8 decode
 *
 * Tasarım kararları:
 *   • `applyPolyfills` saf fonksiyon — her isolate ayrı çağrı.
 *   • Zamanlayıcılar execution timeout'a tabi; isolate kill edilince
 *     tümü otomatik temizlenir.
 *   • console çıktısı doğrudan stdout'a değil, `onOutput` callback'ine
 *     gider → ConsoleStream / RingBuffer entegrasyonu.
 *   • NativeGuard'dan SONRA çağrılmalı (guard önce, polyfill sonra).
 *
 * @example
 *   applyNativeGuard(sandbox, guardOpts);
 *   applyPolyfills(sandbox, {
 *     onOutput: (line, stream) => consoleStream.write(line, stream),
 *     executionId,
 *   });
 */

import type { UUID } from "../../types/core";
import { SECURITY_LIMITS } from "./SecurityLimits";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Tipler
// ─────────────────────────────────────────────────────────────────────────────

export type ConsoleStream = "stdout" | "stderr";

export interface PolyfillOptions {
  /** Sandbox'tan gelen console satırlarını tüketir. */
  readonly onOutput:    (line: string, stream: ConsoleStream) => void;
  /** Hangi çalıştırma oturumuna ait (log prefix için). */
  readonly executionId: UUID;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Ana Enjektör
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sandbox nesnesine minimal polyfill seti enjekte eder.
 * NativeGuard'dan sonra çağrılmalıdır.
 *
 * @param sandbox   — QuickJS global nesnesi (veya test için düz obje).
 * @param options   — Çıktı callback'i ve execution ID.
 * @returns cleanup — timer'ları ve kaynakları serbest bırakan fonksiyon.
 *                    runtime.worker.ts teardown'da çağrılmalıdır.
 */
export function applyPolyfills(
  sandbox: Record<string, unknown>,
  options: PolyfillOptions,
): () => void {
  installConsole(sandbox, options);
  const cleanupTimers = installTimers(sandbox);  // BUG 5 FIX: cleanup döner
  installQueueMicrotask(sandbox);
  installStructuredClone(sandbox);
  installTextCoding(sandbox);
  installURL(sandbox);
  return cleanupTimers;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. console Polyfill
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kullanıcı kodunun `console.log(...)` çağrısı → `onOutput("...", "stdout")`.
 * `console.error` / `console.warn` → `"stderr"`.
 */
function installConsole(
  sandbox: Record<string, unknown>,
  { onOutput }: PolyfillOptions,
): void {
  /**
   * Birden fazla argümanı Node.js tarzı string'e çevirir.
   * Nesne, dizi → JSON; primitive → String().
   */
  function formatArgs(args: unknown[]): string {
    return args
      .map((a) => {
        if (a === null)            return "null";
        if (a === undefined)       return "undefined";
        if (typeof a === "string") return a;
        if (typeof a === "number" || typeof a === "boolean") return String(a);
        try {
          return JSON.stringify(a, null, 2);
        } catch {
          return String(a);
        }
      })
      .join(" ");
  }

  function trim(line: string): string {
    return line.length > SECURITY_LIMITS.CONSOLE_LINE_MAX_CHARS
      ? line.slice(0, SECURITY_LIMITS.CONSOLE_LINE_MAX_CHARS) + "… [kesildi]"
      : line;
  }

  const stdout = (...args: unknown[]): void =>
    onOutput(trim(formatArgs(args)), "stdout");

  const stderr = (...args: unknown[]): void =>
    onOutput(trim(formatArgs(args)), "stderr");

  sandbox["console"] = Object.freeze({
    log:   stdout,
    info:  stdout,
    debug: stdout,
    warn:  stderr,
    error: stderr,
    /** Kullanıcı kodu console.clear() çağırırsa sessizce yoksay. */
    clear: (): void => { /* no-op */ },
    /**
     * console.assert(condition, ...msg)
     * Koşul yanlışsa stderr'e yazar.
     */
    assert: (condition: unknown, ...args: unknown[]): void => {
      if (!condition) {
        stderr("Assertion failed:", ...args);
      }
    },
    /**
     * console.table(data) — basit tablo çıktısı.
     * Karmaşık veriyi JSON ile göster.
     */
    table: (data: unknown): void => {
      stdout("[table]", data);
    },
    /** console.time / timeEnd — milisaniye ölçer. */
    _timers: {} as Record<string, number>,
    time(label: string = "default"): void {
      (this._timers as Record<string, number>)[label] = Date.now();
    },
    timeEnd(label: string = "default"): void {
      const start = (this._timers as Record<string, number>)[label];
      if (start === undefined) {
        stderr(`console.timeEnd: label "${label}" bulunamadı`);
        return;
      }
      stdout(`${label}: ${Date.now() - start}ms`);
      delete (this._timers as Record<string, number>)[label];
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Zamanlayıcı Polyfill'leri
// ─────────────────────────────────────────────────────────────────────────────

/**
 * setTimeout / clearTimeout / setInterval / clearInterval.
 *
 * BUG 5 FIX: `__clearAllTimers__` artık sandbox global'ına yazılmıyor.
 * Bunun yerine `installTimers` cleanup fonksiyonu döndürür;
 * worker teardown adımı bunu saklar ve isolate kapatılırken çağırır.
 *
 * @returns cleanup — tüm aktif timer'ları iptal eden fonksiyon.
 */
function installTimers(sandbox: Record<string, unknown>): () => void {
  const activeTimers = new Set<ReturnType<typeof setTimeout>>();

  sandbox["setTimeout"] = (
    fn: (...args: unknown[]) => void,
    ms: number,
    ...args: unknown[]
  ): ReturnType<typeof setTimeout> => {
    const id = setTimeout((...a) => {
      activeTimers.delete(id);
      fn(...a);
    }, ms, ...args);
    activeTimers.add(id);
    return id;
  };

  sandbox["clearTimeout"] = (id: ReturnType<typeof setTimeout>): void => {
    clearTimeout(id);
    activeTimers.delete(id);
  };

  sandbox["setInterval"] = (
    fn: (...args: unknown[]) => void,
    ms: number,
    ...args: unknown[]
  ): ReturnType<typeof setInterval> => {
    const id = setInterval(fn, ms, ...args);
    activeTimers.add(id as unknown as ReturnType<typeof setTimeout>);
    return id;
  };

  sandbox["clearInterval"] = (id: ReturnType<typeof setInterval>): void => {
    clearInterval(id);
    activeTimers.delete(id as unknown as ReturnType<typeof setTimeout>);
  };

  // Cleanup fonksiyonu — caller (runtime.worker.ts) teardown'da çağırır.
  return (): void => {
    for (const id of activeTimers) clearTimeout(id);
    activeTimers.clear();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. queueMicrotask
// ─────────────────────────────────────────────────────────────────────────────

function installQueueMicrotask(sandbox: Record<string, unknown>): void {
  if (typeof queueMicrotask === "function") {
    sandbox["queueMicrotask"] = queueMicrotask;
  } else {
    // Fallback: Promise.resolve()
    sandbox["queueMicrotask"] = (fn: () => void): void => {
      Promise.resolve().then(fn).catch(() => { /* sessiz */ });
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 6. structuredClone
// ─────────────────────────────────────────────────────────────────────────────

function installStructuredClone(sandbox: Record<string, unknown>): void {
  if (typeof structuredClone === "function") {
    sandbox["structuredClone"] = structuredClone;
    return;
  }

  // Minimal fallback — fonksiyon ve Symbol'ü kopyalamaz
  sandbox["structuredClone"] = <T>(value: T): T => {
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      return value; // kopyalanamayan değer aynen döner
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 7. TextEncoder / TextDecoder
// ─────────────────────────────────────────────────────────────────────────────

function installTextCoding(sandbox: Record<string, unknown>): void {
  if (typeof TextEncoder !== "undefined") {
    sandbox["TextEncoder"] = TextEncoder;
    sandbox["TextDecoder"] = TextDecoder;
    return;
  }

  // Minimal UTF-8 stub (test / eski ortam)
  sandbox["TextEncoder"] = class {
    encode(s: string): Uint8Array {
      return new Uint8Array([...s].map((c) => c.charCodeAt(0) & 0xff));
    }
  };

  sandbox["TextDecoder"] = class {
    decode(buf: Uint8Array): string {
      // BUG 9 FIX: String.fromCharCode(...largeArray) → stack overflow.
      // Chunk-based loop ile güvenli decode.
      const CHUNK = 4096;
      let result  = "";
      for (let i = 0; i < buf.length; i += CHUNK) {
        result += String.fromCharCode(...Array.from(buf.subarray(i, i + CHUNK)));
      }
      return result;
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 8. URL (minimal)
// ─────────────────────────────────────────────────────────────────────────────

function installURL(sandbox: Record<string, unknown>): void {
  if (typeof URL !== "undefined") {
    sandbox["URL"] = URL;
    return;
  }

  // Stub — Phase 3'te tam WHATWG URL polyfill ile değiştirilebilir
  sandbox["URL"] = class {
    readonly href:     string;
    readonly protocol: string;
    readonly host:     string;
    readonly pathname: string;
    readonly search:   string;
    readonly hash:     string;

    constructor(input: string, _base?: string) {
      this.href     = input;
      const m       = input.match(/^(\w+:\/\/)?([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/) ?? [];
      this.protocol = m[1] ?? "";
      this.host     = m[2] ?? "";
      this.pathname = m[3] ?? "/";
      this.search   = m[4] ?? "";
      this.hash     = m[5] ?? "";
    }

    toString(): string {
      return this.href;
    }
  };
}
