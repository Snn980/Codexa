/**
 * @file     NativeGuard.ts
 * @module   runtime/sandbox
 * @version  1.0.0
 * @since    Phase 2 — Runtime Sandbox
 *
 * @description
 *   Sandbox içindeki kullanıcı kodunun tehlikeli global API'lara
 *   erişimini engeller veya güvenli stub ile sararak etkisizleştirir.
 *
 * Engellenen kategoriler (architecture doc § Security Sandbox):
 *   • Dosya sistemi      — fs, require("fs"), Deno.readFile vb.
 *   • Ağ                 — fetch, XMLHttpRequest, WebSocket
 *                          (allowNetwork=true ise fetch stub açılır)
 *   • Native / process   — process.exit, eval, Function constructor
 *   • Zamanlama saldırısı— performance.now (hassasiyet kısıtlanır)
 *
 * Kullanım:
 *   QuickJS isolate'i oluşturulduktan hemen sonra,
 *   Polyfills.ts'den önce `applyNativeGuard()` çağrılır.
 *   Bu sıra kritiktir — guard override edilmeden önce uygulanmalıdır.
 *
 * Tasarım kararları:
 *   • `applyNativeGuard` saf fonksiyon; singleton değil.
 *     Her isolate için ayrı çağrılır → test izolasyonu kolaylaşır.
 *   • Gerçek QuickJS bağlaması Phase 2'de quickjs-emscripten üzerinden;
 *     bu dosya `globalThis` üzerinden apply eder —
 *     WebView içi sandbox veya Node.js test ortamıyla uyumlu.
 *   • Engellenen özellik erişilirse `GuardError` fırlatılır
 *     (kullanıcı koduna anlamlı hata mesajı).
 */

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Tipler
// ─────────────────────────────────────────────────────────────────────────────

export interface NativeGuardOptions {
  /**
   * `true` ise fetch stub aktif edilir (kısıtlı, loglanan).
   * `false` ise fetch tamamen engellenir.
   * Varsayılan: false.
   */
  readonly allowNetwork: boolean;
  /**
   * Engellenen API erişimi loglanır mı?
   * Üretimde false, geliştirme / test modunda true önerilir.
   */
  readonly logBlocked:   boolean;
}

export const DEFAULT_GUARD_OPTIONS: NativeGuardOptions = Object.freeze({
  allowNetwork: false,
  logBlocked:   false,
});

/**
 * Guard tarafından fırlatılan hata.
 * `instanceof GuardError` ile yakalanabilir.
 */
export class GuardError extends Error {
  constructor(apiName: string) {
    super(
      `[Sandbox] "${apiName}" bu ortamda kullanılamaz. ` +
      `Kodunuzu sandbox dışında çalıştırmayı deneyin.`,
    );
    this.name = "GuardError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Engellenen API Listesi
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Her zaman engellenen global property isimleri.
 * `Object.defineProperty` ile non-configurable, erişimde throw eder.
 */
const BLOCKED_GLOBALS: readonly string[] = [
  // Dosya sistemi
  "require",        // CommonJS — Node.js / Hermes ortamında olabilir
  "__dirname",
  "__filename",

  // Process
  "process",

  // Deno
  "Deno",

  // Worker'ın kendi nesnesi (iç mesajlaşmayı dışarı açmamak için)
  // Not: postMessage stub Polyfills.ts'de ayrıca ele alınır.
] as const;

/** Network ile ilgili; `allowNetwork=false` ise eklenir. */
const NETWORK_GLOBALS: readonly string[] = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
] as const;

/** Kod üretme / eval yüzeyleri — her zaman engellenir. */
const EVAL_GLOBALS: readonly string[] = [
  "eval",
  "Function",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// § 3. Guard Uygulayıcı
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verilen `sandbox` nesnesine (QuickJS global veya test ortamı için
 * düz obje) guard uygular.
 *
 * @param sandbox   — Kullanıcı kodunun göreceği global nesne.
 * @param options   — Guard seçenekleri.
 *
 * @example
 *   // QuickJS context global'ı için (Phase 2 binding)
 *   applyNativeGuard(quickjsContext.global, { allowNetwork: false, logBlocked: true });
 *
 *   // Test
 *   const g: Record<string, unknown> = { fetch: globalThis.fetch };
 *   applyNativeGuard(g, DEFAULT_GUARD_OPTIONS);
 *   expect(() => g["fetch"]).toThrow(GuardError);
 */
export function applyNativeGuard(
  sandbox: Record<string, unknown>,
  options: NativeGuardOptions = DEFAULT_GUARD_OPTIONS,
): void {
  // BUG 3 FIX: EVAL_GLOBALS toBlock'tan çıkarıldı.
  // blockEval kendi defineProperty'sini uygular; blockProperty ile çakışmaz.
  const toBlock = [
    ...BLOCKED_GLOBALS,
    ...(options.allowNetwork ? [] : NETWORK_GLOBALS),
  ];

  for (const name of toBlock) {
    blockProperty(sandbox, name, options.logBlocked);
  }

  // eval / Function — blockEval ayrıca yönetir (value+writable descriptor)
  blockEval(sandbox, options.logBlocked);

  // performance.now — hassasiyet kısıtla (timing attack azalt)
  patchPerformanceNow(sandbox);

  // allowNetwork=true → fetch stub (loglayan, kısıtlı)
  if (options.allowNetwork) {
    installFetchStub(sandbox, options.logBlocked);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. İç Yardımcılar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `sandbox[name]` için hem get hem set'te `GuardError` fırlatan
 * non-configurable property tanımlar.
 *
 * BUG 8 FIX: defineProperty başarısız olursa sessizce undefined atamak yerine
 * writable:false descriptor dene; o da başarısız olursa uyarı logla.
 * Tamamen bloke edilemeyen property güvenlik açığı yaratır, en azından
 * üretim loguna düşsün.
 */
function blockProperty(
  sandbox:    Record<string, unknown>,
  name:       string,
  logBlocked: boolean,
): void {
  try {
    Object.defineProperty(sandbox, name, {
      configurable: false,
      enumerable:   false,
      get() {
        if (logBlocked) {
           
          console.warn(`[NativeGuard] blocked access: "${name}"`);
        }
        throw new GuardError(name);
      },
      set() {
        if (logBlocked) {
           
          console.warn(`[NativeGuard] blocked write: "${name}"`);
        }
        throw new GuardError(name);
      },
    });
  } catch {
    // defineProperty başarısız — en azından writable:false dene
    try {
      Object.defineProperty(sandbox, name, {
        configurable: false,
        writable:     false,
        value:        undefined,
      });
    } catch {
      // İkinci deneme de başarısız — ortam kısıtlıdır, logla
       
      console.error(
        `[NativeGuard] UYARI: "${name}" bloke edilemedi. ` +
        `Güvenlik açığı riski — ortamı kontrol edin.`,
      );
    }
  }
}

/**
 * `eval` ve `Function` constructor'ını non-writable stub ile kapatır.
 * `eval("x")` → GuardError
 * `new Function("return 1")` → GuardError
 *
 * BUG 4 FIX: FunctionStub artık `(...): never` arrow değil;
 * `.prototype` atanabilen düz function expression.
 */
function blockEval(
  sandbox:    Record<string, unknown>,
  logBlocked: boolean,
): void {
  const evalStub = (..._args: unknown[]): never => {
    if (logBlocked) console.warn("[NativeGuard] blocked: eval");
    throw new GuardError("eval");
  };

  // `never` return tipli arrow'a .prototype atanamaz (compile error).
  // function expression kullanılıyor — prototype assign'a izin verir.
  function FunctionStub(..._args: unknown[]): never {
    if (logBlocked) console.warn("[NativeGuard] blocked: Function");
    throw new GuardError("Function");
  }
  FunctionStub.prototype = Object.create(null);

  try {
    Object.defineProperty(sandbox, "eval", {
      configurable: false, writable: false, value: evalStub,
    });
    Object.defineProperty(sandbox, "Function", {
      configurable: false, writable: false, value: FunctionStub,
    });
  } catch {
    // Ortam defineProperty'yi desteklemiyorsa basit atama
    sandbox["eval"]     = evalStub;
    sandbox["Function"] = FunctionStub;
  }
}

/**
 * `performance.now()` hassasiyetini 1ms'ye indirir.
 * Yüksek çözünürlüklü zamanlama → Spectre-benzeri saldırıları zorlaştırır.
 */
function patchPerformanceNow(sandbox: Record<string, unknown>): void {
  if (
    typeof sandbox["performance"] !== "object" ||
    sandbox["performance"] === null
  ) {
    return;
  }

  const perf = sandbox["performance"] as { now?: () => number };
  const original = perf.now?.bind(perf);
  if (!original) return;

  perf.now = (): number => Math.floor(original()) ; // 1ms hassasiyet
}

/**
 * `allowNetwork=true` durumunda fetch'i loglayan ama gerçekten
 * ağa çıkmayan bir stub ile değiştirir.
 * Gerçek network erişimi Phase 2'de NativeGuard dışında
 * ayrıca kontrol edilecek.
 */
function installFetchStub(
  sandbox:    Record<string, unknown>,
  logBlocked: boolean,
): void {
  sandbox["fetch"] = async (input: unknown): Promise<never> => {
    if (logBlocked) {
      console.warn(`[NativeGuard] fetch intercepted: ${String(input)}`);
    }
    // Phase 2: gerçek proxy veya mock response buraya gelecek.
    throw new GuardError("fetch (network not yet enabled)");
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. Guard Durumu Sorgulama (test / diagnostik)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verilen sandbox nesnesinin belirli bir property için
 * guard uygulanmış olup olmadığını test eder.
 *
 * @example
 *   expect(isGuarded(sandbox, "fetch")).toBe(true);
 */
export function isGuarded(
  sandbox: Record<string, unknown>,
  name:    string,
): boolean {
  try {
    void sandbox[name]; // guard varsa throw eder
    return false;
  } catch (e) {
    return e instanceof GuardError;
  }
}
