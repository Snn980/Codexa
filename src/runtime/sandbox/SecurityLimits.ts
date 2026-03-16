/**
 * @file     SecurityLimits.ts
 * @module   runtime/sandbox
 * @version  1.0.0
 * @since    Phase 2 — Runtime Sandbox
 *
 * @description
 *   QuickJS sandbox kaynak sınırları ve limit doğrulama yardımcıları.
 *   Tüm runtime bileşenleri limitleri buradan okur — magic number yok.
 *
 * Sınır değerleri (architecture doc § Security Sandbox):
 *   CPU  : max %80 tek çekirdek
 *   RAM  : hard cap 128MB / çalıştırma
 *   Süre : varsayılan 10s, yapılandırılabilir
 *   Stack: 512KB maks
 *
 * Tasarım kararları:
 *   • `Object.freeze` — çalışma zamanında değiştirilemez.
 *   • `EXECUTION_TIMEOUT` kullanıcı tarafından daraltılabilir
 *     (MAX_EXECUTION_TIMEOUT üst sınırına kadar).
 *   • Limit aşımı → Result<T> hatası; exception fırlatılmaz.
 *   • `validateExecutionConfig` — worker başlamadan önce config'i doğrular.
 */

import type { AppError } from "../../types/core";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Temel Limitler (sabit, değiştirilemez)
// ─────────────────────────────────────────────────────────────────────────────

export const SECURITY_LIMITS = Object.freeze({
  /** QuickJS'in kullanabileceği maksimum CPU oranı (tek çekirdek). */
  CPU_MAX_PERCENT:       80,

  /** Bir çalıştırma için hard RAM sınırı (128 MB). */
  MEMORY_MAX_BYTES:      128 * 1024 * 1024,

  /** Varsayılan çalıştırma zaman aşımı (10 saniye). */
  EXECUTION_TIMEOUT_MS:  10_000,

  /**
   * Kullanıcı yapılandırması ile izin verilen maksimum zaman aşımı.
   * Settings ekranından bu değerin üstüne çıkılamaz.
   */
  MAX_EXECUTION_TIMEOUT_MS: 60_000,

  /** Minimum izin verilen zaman aşımı (kaza ile 0 girilmesini önler). */
  MIN_EXECUTION_TIMEOUT_MS: 1_000,

  /** QuickJS call stack maksimum derinliği (512 KB). */
  STACK_MAX_BYTES:       512 * 1024,

  /** RingBuffer maksimum satır sayısı. */
  CONSOLE_MAX_LINES:     10_000,

  /** Tek console satırının karakter sınırı (aşan kısım kesilir). */
  CONSOLE_LINE_MAX_CHARS: 4_096,

  /** esbuild ile bundle edilebilecek maksimum giriş boyutu (5 MB). */
  BUNDLE_MAX_SIZE_BYTES: 5 * 1024 * 1024,

  /** Tek proje içinde açılabilecek maksimum dosya sayısı. */
  MAX_FILES_PER_PROJECT: 500,

  /**
   * Worker'ın başlatılması için verilen maksimum süre.
   * Bu süre aşılırsa SANDBOX_INIT_FAILED döner.
   */
  WORKER_INIT_TIMEOUT_MS: 5_000,
} as const);

export type SecurityLimits = typeof SECURITY_LIMITS;

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Çalıştırma Konfigürasyonu
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kullanıcı tarafından yapılandırılabilen çalıştırma parametreleri.
 * `validateExecutionConfig()` ile doğrulanmalı; ham kullanıcı girdisi
 * doğrudan worker'a geçirilmez.
 */
export interface ExecutionConfig {
  /** ms cinsinden zaman aşımı [1_000 – 60_000]. */
  readonly timeoutMs:      number;
  /** Sandbox'a network erişimi verilsin mi? (varsayılan: false). */
  readonly allowNetwork:   boolean;
  /** console.log / warn / error çıktısı yakalanmalı mı? */
  readonly captureConsole: boolean;
}

export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = Object.freeze({
  timeoutMs:      SECURITY_LIMITS.EXECUTION_TIMEOUT_MS,
  allowNetwork:   false,
  captureConsole: true,
});

// ─────────────────────────────────────────────────────────────────────────────
// § 3. Limit Doğrulama
// ─────────────────────────────────────────────────────────────────────────────

export type LimitValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: AppError };

/**
 * Kullanıcı sağlanan `ExecutionConfig`'i limit sınırları içinde doğrular.
 * Hata durumunda `Result<never>` döner — worker spawn edilmez.
 *
 * @example
 *   const check = validateExecutionConfig({ timeoutMs: 120_000, ... });
 *   if (!check.ok) return check; // VALIDATION_ERROR
 */
export function validateExecutionConfig(
  config: ExecutionConfig,
): LimitValidationResult {
  const { timeoutMs } = config;

  if (timeoutMs < SECURITY_LIMITS.MIN_EXECUTION_TIMEOUT_MS) {
    return limitError(
      `timeoutMs çok küçük: ${timeoutMs}ms ` +
      `(minimum: ${SECURITY_LIMITS.MIN_EXECUTION_TIMEOUT_MS}ms)`,
    );
  }

  if (timeoutMs > SECURITY_LIMITS.MAX_EXECUTION_TIMEOUT_MS) {
    return limitError(
      `timeoutMs çok büyük: ${timeoutMs}ms ` +
      `(maksimum: ${SECURITY_LIMITS.MAX_EXECUTION_TIMEOUT_MS}ms)`,
    );
  }

  return { ok: true };
}

/**
 * Bundle boyutunu sınır ile karşılaştırır.
 *
 * @example
 *   const check = validateBundleSize(bundleCode.length);
 *   if (!check.ok) return check; // VALIDATION_ERROR
 */
export function validateBundleSize(
  sizeBytes: number,
): LimitValidationResult {
  if (sizeBytes > SECURITY_LIMITS.BUNDLE_MAX_SIZE_BYTES) {
    const mb = (sizeBytes / (1024 * 1024)).toFixed(2);
    const max = (SECURITY_LIMITS.BUNDLE_MAX_SIZE_BYTES / (1024 * 1024)).toFixed(0);
    return limitError(
      `Bundle boyutu sınırı aşıldı: ${mb}MB (maksimum: ${max}MB)`,
    );
  }
  return { ok: true };
}

/**
 * RAM kullanımını limit ile karşılaştırır.
 * QuickJS'in raporladığı anlık kullanım ile çağrılır.
 *
 * @example
 *   const check = checkMemoryUsage(heapUsedBytes);
 *   if (!check.ok) killWorker(); // MEMORY_LIMIT_EXCEEDED
 */
export function checkMemoryUsage(
  usedBytes: number,
): LimitValidationResult {
  if (usedBytes >= SECURITY_LIMITS.MEMORY_MAX_BYTES) {
    const mb = (usedBytes / (1024 * 1024)).toFixed(1);
    return {
      ok:    false,
      error: makeError(
        "MEMORY_LIMIT_EXCEEDED",
        `Bellek sınırı aşıldı: ${mb}MB kullanıldı ` +
        `(limit: ${SECURITY_LIMITS.MEMORY_MAX_BYTES / (1024 * 1024)}MB)`,
      ),
    };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. İç Yardımcılar
// ─────────────────────────────────────────────────────────────────────────────

function limitError(message: string): LimitValidationResult {
  return { ok: false, error: makeError("VALIDATION_ERROR", message) };
}

function makeError(
  code: AppError["code"],
  message: string,
): AppError {
  return { code, message, timestamp: Date.now() };
}
