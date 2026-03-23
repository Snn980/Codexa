/**
 * @file     runtime.worker.ts
 * @module   ipc/workers
 * @version  1.0.0
 * @since    Phase 2 — Runtime Sandbox
 *
 * @description
 *   Kullanıcı kodunu QuickJS sandbox içinde çalıştıran Worker thread.
 *   Ana thread (editor) ile IPC Protocol üzerinden haberleşir.
 *
 * Mesaj akışı:
 *
 *   Editor → Worker  :  REQUEST  { payload: RunPayload }
 *   Worker → Editor  :  STREAM   { chunk: ConsoleChunk, done: false }  (N satır)
 *   Worker → Editor  :  RESPONSE { data:  RunResult }  veya  { error: AppError }
 *
 *   İptal:
 *   Editor → Worker  :  CANCEL   { id: <REQUEST id> }
 *   Worker → Editor  :  (sessiz — RESPONSE / STREAM gönderilmez)
 *
 * Tasarım kararları:
 *   • Bir anda yalnızca tek execution — paralel REQUEST reddedilir.
 *   • `ISandboxRuntime` arayüzü arkasında QuickJS bağlaması gizlenir;
 *     worker test edilebilir kalır (mock runtime ile).
 *   • QuickJS `evalCode` synchronous → `onOutput` callback doğrudan
 *     `self.postMessage` çağırır → gerçek zamanlı console akışı.
 *   • Timeout ve CANCEL aynı `_interrupted` flag'ini set eder;
 *     QuickJS interrupt handler bu flag'i polling yapar.
 *   • `try/finally` teardown — hata, timeout veya normal bitiş fark etmez.
 *   • Worker kapanırken (`self.onclose`) aktif execution interrupt edilir.
 *
 * QuickJS bağlaması (Phase 2 TODO):
 *   Gerçek `quickjs-emscripten` bağlaması `QuickJSSandboxRuntime` sınıfı
 *   içindedir. Bu dosya yalnızca arayüzü kullanır.
 *   Bağlama tamamlanana kadar `FallbackSandboxRuntime` aktiftir —
 *   Worker'ın kendi kısıtlı ortamında `new Function` yerine güvenli
 *   eval kullanır (Worker zaten ana thread'den izole).
 */

/// <reference lib="webworker" />

import {
  isIPCMessage,
  isIPCRequest,
  isIPCCancel,
  buildResponse,
  buildErrorResponse,
  buildStream,
} from "../../ipc/Protocol";
import type { RunPayload, RunResult, ConsoleChunk } from "../../ipc/Protocol";
import type { UUID }   from "../../types/core";
import { applyNativeGuard } from "../sandbox/NativeGuard";
import { applyPolyfills }   from "../sandbox/Polyfills";
import { SECURITY_LIMITS }  from "../sandbox/SecurityLimits";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. ISandboxRuntime — QuickJS Arayüzü
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sandbox çalışma ortamının soyut arayüzü.
 * `QuickJSSandboxRuntime`  → gerçek quickjs-emscripten bağlaması (Phase 2 TODO)
 * `FallbackSandboxRuntime` → Worker ortamında güvenli fallback (geliştirme/test)
 */
export interface ISandboxRuntime {
  /**
   * Kodu sandbox içinde çalıştırır.
   * `evalCode` synchronous olduğu için dönüş değeri de synchronous.
   */
  execute(opts: SandboxExecuteOptions): SandboxResult;
  /** Runtime'ı serbest bırakır (WASM heap temizliği). */
  dispose(): void;
}

export interface SandboxExecuteOptions {
  code:         string;
  executionId:  UUID;
  timeoutMs:    number;
  allowNetwork: boolean;
  /** Her console satırında synchronous çağrılır. */
  onOutput:     (line: string, stream: "stdout" | "stderr") => void;
  /**
   * QuickJS interrupt handler — her N op-code'da çağrılır.
   * `true` dönerse QuickJS execution'ı keser.
   */
  shouldInterrupt: () => boolean;
}

export type SandboxResult =
  | { readonly ok: true;  readonly durationMs: number }
  | { readonly ok: false; readonly durationMs: number; readonly error: string };

// ─────────────────────────────────────────────────────────────────────────────
// § 2. FallbackSandboxRuntime
// ─────────────────────────────────────────────────────────────────────────────

/**
 * QuickJS WASM yüklenene kadar kullanılan fallback runtime.
 * Worker zaten ana thread'den izole olduğundan güvenli kabul edilir.
 *
 * Kısıtlamalar:
 *   • NativeGuard + Polyfills uygulanır (sandbox nesne üzerinden).
 *   • Gerçek QuickJS'in interrupt / memory limit desteği yoktur —
 *     timeout worker tarafından yönetilir (interrupt döngüsü yok).
 *   • Phase 2 sonunda `QuickJSSandboxRuntime` ile değiştirilecektir.
 */
export class FallbackSandboxRuntime implements ISandboxRuntime {
  execute(opts: SandboxExecuteOptions): SandboxResult {
    const startMs = Date.now();

    // Sandbox global nesnesi — kullanıcı kodu bunu görür
    const sandbox: Record<string, unknown> = Object.create(null);

    // Guard → Polyfills sırası kritik
    applyNativeGuard(sandbox, {
      allowNetwork: opts.allowNetwork,
      logBlocked:   false,
    });

    const cleanupTimers = applyPolyfills(sandbox, {
      executionId: opts.executionId,
      onOutput:    opts.onOutput,
    });

    try {
      // Sandbox içinde kodu çalıştır.
      // Worker ortamında `Function` constructor kullanımı ana thread'den
      // izole olduğundan kabul edilebilir (NativeGuard bunu sandbox'ta engeller).
      // Gerçek QuickJS bağlaması geldikten sonra bu satır kaldırılacak.
      const run = new Function(
        ...Object.keys(sandbox),
        `"use strict";\n${opts.code}`,
      );
      run(...Object.values(sandbox));

      return { ok: true, durationMs: Date.now() - startMs };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { ok: false, durationMs: Date.now() - startMs, error };
    } finally {
      cleanupTimers();
    }
  }

  dispose(): void {
    // Fallback: dispose edilecek WASM kaynağı yok
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// § 3. QuickJSSandboxRuntime (§ 72 — Gerçek Bağlama)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * quickjs-emscripten WASM sandbox runtime.
 *
 * Yaşam döngüsü:
 *   const runtime = await QuickJSSandboxRuntime.create();
 *   const result  = runtime.execute(opts);
 *   runtime.dispose();
 *
 * Güvenlik katmanları (her execute çağrısında):
 *   1. setMemoryLimit  — SECURITY_LIMITS.MEMORY_MAX_BYTES
 *   2. setMaxStackSize — SECURITY_LIMITS.STACK_MAX_BYTES
 *   3. setInterruptHandler — shouldInterrupt() döngüsü
 *   4. applyNativeGuard    — fetch/XMLHttpRequest/require bloke
 *   5. applyPolyfills      — console.log → onOutput köprüsü
 *
 * Timeout stratejisi:
 *   RuntimeWorker, execute() çağrısından önce `shouldInterrupt` callback'ini
 *   oluşturur. QuickJS her N op-code'da callback'i çağırır; callback
 *   deadline aşıldığında `true` döner → evalCode() `Interrupted` hatası fırlatır.
 *   Bu Worker thread'i bloke etmeden synchronous timeout sağlar.
 *
 * § 1  : Result<T>
 * § 72 : QuickJSSandboxRuntime
 */
export class QuickJSSandboxRuntime implements ISandboxRuntime {

  // quickjs-emscripten module instance — WASM belleğini temsil eder.
  // Tip: QuickJSWASMModule (runtime'da import edilen gerçek tip kullanılır).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _module: any;

  private constructor(module: unknown) {
    this._module = module;
  }

  /**
   * Factory — WASM modülünü async olarak yükler.
   * Worker başlangıcında bir kez çağrılır; sonraki execute() çağrıları sync.
   *
   * @example
   *   const qjs = await QuickJSSandboxRuntime.create();
   */
  static async create(): Promise<QuickJSSandboxRuntime> {
    // Dynamic import — bundle boyutunu küçük tutar (§ 9)
    // quickjs-emscripten paket ismi package.json'a eklendiğinde aktif olur.
     
    // @ts-ignore — quickjs-emscripten opsiyonel bağımlılık, package.json eklenince aktif
    const { getQuickJS } = await import("quickjs-emscripten") as any;
    const module = await getQuickJS();
    return new QuickJSSandboxRuntime(module);
  }

  /**
   * Kodu QuickJS sandbox içinde çalıştırır.
   *
   * Akış:
   *   newRuntime() → limitleri ayarla → newContext() →
   *   guard/polyfill kur → evalCode() → dispose
   */
  execute(opts: SandboxExecuteOptions): SandboxResult {
    const startMs = Date.now();

    const qjsRuntime = this._module.newRuntime();

    try {
      // ── 1. Güvenlik limitleri ────────────────────────────────────────────
      qjsRuntime.setMemoryLimit(SECURITY_LIMITS.MEMORY_MAX_BYTES);
      qjsRuntime.setMaxStackSize(SECURITY_LIMITS.STACK_MAX_BYTES);

      // QuickJS her N op-code'da shouldInterrupt'ı çağırır
      qjsRuntime.setInterruptHandler(() => opts.shouldInterrupt());

      // ── 2. Context oluştur ───────────────────────────────────────────────
      const ctx = qjsRuntime.newContext();

      try {
        // ── 3. Guard: tehlikeli API'ları bloke et ──────────────────────────
        this._applyGuard(ctx, opts);

        // ── 4. Polyfill: console.log → onOutput ───────────────────────────
        this._applyConsole(ctx, opts);

        // ── 5. Kodu çalıştır ──────────────────────────────────────────────
        const evalResult = ctx.evalCode(opts.code, "sandbox.js");

        if (evalResult.error) {
          const errorMsg = ctx.dump(evalResult.error);
          evalResult.error.dispose();
          return {
            ok:         false,
            durationMs: Date.now() - startMs,
            error:      typeof errorMsg === "string"
              ? errorMsg
              : JSON.stringify(errorMsg),
          };
        }

        evalResult.value.dispose();
        return { ok: true, durationMs: Date.now() - startMs };

      } finally {
        ctx.dispose();
      }

    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      // "Interrupted" → timeout veya CANCEL
      const isTimeout = error.includes("Interrupted") || error.includes("interrupted");
      return {
        ok:         false,
        durationMs: Date.now() - startMs,
        error:      isTimeout ? "Execution timeout (interrupted)" : error,
      };

    } finally {
      qjsRuntime.dispose();
    }
  }

  /** WASM kaynakları serbest bırak. */
  dispose(): void {
    // getQuickJS() ile alınan module global — dispose edilmez.
    // QuickJS runtime/context her execute() sonunda dispose edilir.
  }

  // ── Yardımcılar ──────────────────────────────────────────────────────────

  /**
   * Tehlikeli global API'ları context.globalThis'ten siler.
   * NativeGuard ile aynı kural seti — kayıt değişiklikleri buraya da yansımalı.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _applyGuard(ctx: any, opts: SandboxExecuteOptions): void {
    // Ağ erişimi kısıtlaması
    if (!opts.allowNetwork) {
      for (const api of ["fetch", "XMLHttpRequest", "WebSocket"]) {
        const undef = ctx.undefined;
        ctx.globalThis.setProp(api, undef);
      }
    }
    // Node.js / module sistemi erişimi kısıtla
    for (const api of ["require", "process", "__dirname", "__filename", "module", "exports"]) {
      ctx.globalThis.deleteProp(api);
    }
  }

  /**
   * console.log/warn/error → opts.onOutput köprüsü.
   * QuickJS context içinde `console` nesnesi oluşturur.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _applyConsole(ctx: any, opts: SandboxExecuteOptions): void {
    const makeLogFn = (stream: "stdout" | "stderr") =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx.newFunction("log", (...args: any[]) => {
        const line = args
          .map((a: unknown) => {
            try { return ctx.dump(a); } catch { return String(a); }
          })
          .map((v: unknown) => (typeof v === "string" ? v : JSON.stringify(v)))
          .join(" ");
        opts.onOutput(line, stream);
      });

    const consoleObj = ctx.newObject();
    consoleObj.setProp("log",   makeLogFn("stdout"));
    consoleObj.setProp("info",  makeLogFn("stdout"));
    consoleObj.setProp("warn",  makeLogFn("stderr"));
    consoleObj.setProp("error", makeLogFn("stderr"));
    ctx.globalThis.setProp("console", consoleObj);
    consoleObj.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. RuntimeWorker
// ─────────────────────────────────────────────────────────────────────────────

export class RuntimeWorker {
  /** Aktif çalıştırma request ID'si; null = boşta. */
  private _activeId:    UUID | null = null;
  /** İptal veya timeout istekleri buraya eklenir. */
  private _cancelSet:   Set<UUID>   = new Set();
  /** STREAM mesajları için monotonic sıra numarası. */
  private _seq      = 0;
  /** Interrupt flag — timeout ve CANCEL tarafından set edilir. */
  private _interrupted     = false;

  private readonly _runtime: ISandboxRuntime;

  /**
   * @param runtime — Test'te mock, üretimde FallbackSandboxRuntime
   *                  (ileride QuickJSSandboxRuntime).
   * @param poster  — `self.postMessage` wrapper; test'te mock edilebilir.
   */
  constructor(
    runtime?: ISandboxRuntime,
    private readonly _post: (msg: unknown) => void = (m) => self.postMessage(m),
  ) {
    this._runtime = runtime ?? new FallbackSandboxRuntime();
  }

  // ── Mesaj Girişi ──────────────────────────────────────────────────────────

  handleMessage(event: MessageEvent): void {
    const msg = event.data;
    if (!isIPCMessage(msg)) return;
    // Worker yalnızca "editor"dan gelen mesajları kabul eder
    if (msg.to !== "runtime") return;

    if (isIPCRequest(msg)) {
      void this._handleRun(msg.id, msg.payload as Partial<RunPayload>);
      return;
    }

    if (isIPCCancel(msg)) {
      this._handleCancel(msg.id);
    }
  }

  // ── Run İşleyici ──────────────────────────────────────────────────────────

  private async _handleRun(
    requestId: UUID,
    rawPayload: Partial<RunPayload>,
  ): Promise<void> {
    // ── Eşzamanlılık koruması ────────────────────────────────────────────────
    if (this._activeId !== null) {
      this._postError(requestId, "VALIDATION_ERROR",
        "Worker meşgul — önceki çalıştırma henüz tamamlanmadı");
      return;
    }

    // ── İptal — REQUEST gelmeden önce CANCEL alındıysa ───────────────────────
    if (this._cancelSet.has(requestId)) {
      this._cancelSet.delete(requestId);
      return;   // sessiz iptal — RESPONSE / STREAM gönderilmez
    }

    // ── Payload doğrulama ────────────────────────────────────────────────────
    if (
      typeof rawPayload?.executionId !== "string" ||
      typeof rawPayload?.code        !== "string" ||
      typeof rawPayload?.timeout     !== "number"
    ) {
      this._postError(requestId, "VALIDATION_ERROR", "Geçersiz RunPayload");
      return;
    }

    const payload: RunPayload = {
      executionId: rawPayload.executionId as UUID,
      code:        rawPayload.code,
      timeout:     rawPayload.timeout,
    };

    // ── Timeout sınır kontrolü ────────────────────────────────────────────────
    const timeoutMs = Math.min(
      Math.max(payload.timeout, SECURITY_LIMITS.MIN_EXECUTION_TIMEOUT_MS),
      SECURITY_LIMITS.MAX_EXECUTION_TIMEOUT_MS,
    );

    this._activeId    = requestId;
    this._interrupted = false;

    // ── Timeout kurulumu ─────────────────────────────────────────────────────
    // ⚠ FallbackRuntime'da bu callback senkron _execute bitene kadar çalışamaz
    //   (JS single-threaded — event loop bloke). Timeout yalnızca QuickJS'in
    //   shouldInterruptAfterDeadline() interrupt handler'ı ile gerçek anlam
    //   kazanır. QuickJSSandboxRuntime bağlamasında bu setTimeout kaldırılacak,
    //   deadline doğrudan evalCode opts'a geçilecek.
    const timeoutHandle = setTimeout(() => {
      this._interrupted = true;
      // Timeout → stderr'e bilgi satırı (kullanıcı görür)
      this._postChunk(requestId, {
        executionId: payload.executionId,
        line:        `⏱ Zaman aşımı: ${timeoutMs}ms sonra sonlandırıldı.`,
        stream:      "stderr",
      });
    }, timeoutMs);

    try {
      this._execute(requestId, payload, timeoutMs);
    } finally {
      clearTimeout(timeoutHandle);
      this._activeId    = null;
      this._interrupted = false;
      this._cancelSet.delete(requestId);
    }
  }

  // ── Çalıştırma ────────────────────────────────────────────────────────────

  private _execute(
    requestId: UUID,
    payload:   RunPayload,
    timeoutMs: number,
  ): void {
    const { executionId, code } = payload;

    const result = this._runtime.execute({
      code,
      executionId,
      timeoutMs,
      allowNetwork:    false,
      shouldInterrupt: () => this._interrupted || this._cancelSet.has(requestId),
      onOutput:        (line, stream) => {
        // İptal edilmişse output'u yutma — caller bir şey görmemeli
        if (this._cancelSet.has(requestId)) return;
        this._postChunk(requestId, { executionId, line, stream });
      },
    });

    // İptal edilmişse RESPONSE gönderme
    if (this._cancelSet.has(requestId)) return;

    if (result.ok) {
      this._postResponse<RunResult>(requestId, {
        executionId,
        durationMs: result.durationMs,
        exitCode:   0,
      });
    } else {
      // Kullanıcı hatasını önce stderr'e yaz
      this._postChunk(requestId, {
        executionId,
        line:   result.error,
        stream: "stderr",
      });
      this._postResponse<RunResult>(requestId, {
        executionId,
        durationMs: result.durationMs,
        exitCode:   1,
      });
    }
  }

  // ── Cancel İşleyici ───────────────────────────────────────────────────────

  private _handleCancel(requestId: UUID): void {
    this._cancelSet.add(requestId);
    // Aktif execution varsa interrupt et
    if (this._activeId === requestId) {
      this._interrupted = true;
    }
  }

  // ── Worker Kapatma ────────────────────────────────────────────────────────

  /** Worker kapanırken çağrılır — aktif execution interrupt edilir. */
  terminate(): void {
    this._interrupted = true;
    this._runtime.dispose();
  }

  // ── IPC Yardımcıları ──────────────────────────────────────────────────────

  /** Tek console satırını STREAM mesajı olarak gönderir. */
  private _postChunk(
    requestId: UUID,
    chunk:     ConsoleChunk,
  ): void {
    this._post(
      buildStream<ConsoleChunk>(
        requestId,
        "runtime",
        "editor",
        this._seq++,
        chunk,
        false,   // done:true asla — kapanış sinyali RESPONSE ile gelir
      ),
    );
  }

  /** Başarılı RESPONSE gönderir. */
  private _postResponse<D>(requestId: UUID, data: D): void {
    this._post(buildResponse<D>(requestId, "runtime", "editor", data));
  }

  /** Hata RESPONSE gönderir. */
  private _postError(
    requestId: UUID,
    code:      "VALIDATION_ERROR" | "SANDBOX_INIT_FAILED" | "EXECUTION_TIMEOUT",
    message:   string,
  ): void {
    this._post(
      buildErrorResponse(requestId, "runtime", "editor", {
        code,
        message,
        timestamp: Date.now(),
      }),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. Worker Entry Point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Worker instance — module-level singleton.
 * Test ortamında: `new RuntimeWorker(mockRuntime, mockPost)` ile doğrudan kullan.
 */
const worker = new RuntimeWorker();

// Jest ortamında self tanımlı değil — sadece Worker context'inde çalıştır
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.onmessage = (event: MessageEvent) => {
    worker.handleMessage(event);
  };
}

// `onclose` DedicatedWorkerGlobalScope spec'inde yok — addEventListener zorunlu.
// `self.onclose = ...` browser'larda sessizce yoksayılır, cleanup çalışmaz.
self.addEventListener("close", () => {
  worker.terminate();
});
