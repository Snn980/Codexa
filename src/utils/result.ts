/**
 * @file     result.ts
 * @module   utils/result
 * @version  1.0.0
 * @since    Phase 1 — Foundation
 *
 * @description
 *   Result<T> monad yardımcıları.
 *   core.ts'de tanımlanan Result<T> / AsyncResult<T> tiplerinin
 *   tüm builder, guard ve combinator implementasyonları bu modülde yaşar.
 *
 *   Tasarım ilkeleri:
 *     • Saf fonksiyonlar — side-effect yok, her çağrı yeni nesne üretir
 *     • Generic kısıtlar — E extends AppError zorunluluğu tip güvenliği sağlar
 *     • Combinator zinciri — mapResult / chainResult ile railway-oriented
 *       programming desteklenir; iç içe if-blokları gerekmez
 *     • Async uyumu — tüm combinator'ların Promise varyantı mevcuttur
 *     • Tree-shaking — her fonksiyon named export; bundle'a yalnızca
 *       kullanılanlar dahil edilir
 *
 * @example — Temel kullanım
 *   import { ok, err, mapResult } from "@/utils/result";
 *
 *   async function findUser(id: UUID): AsyncResult<User> {
 *     const row = await db.get(id);
 *     if (!row) return err(ErrorCode.RECORD_NOT_FOUND, `User ${id} not found`);
 *     return ok(toUser(row));
 *   }
 *
 * @example — Zincir kullanımı
 *   const result = await chainResult(
 *     await projectRepo.findById(id),
 *     (project) => fileRepo.findByProject(project.id),
 *   );
 */

import type {
  AppError,
  AsyncResult,
  ErrorCode,
  MetaRecord,
  Result,
  UUID,
} from "../types/core";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Builder'lar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Başarılı bir Result değeri oluşturur.
 *
 * @example
 * return ok(project);  // Result<IProject>
 */
export function ok<T>(data: T): Result<T, never> {
  return { ok: true, data };
}

/**
 * Başarısız bir Result değeri oluşturur.
 * `timestamp` otomatik olarak `Date.now()` ile atanır.
 *
 * @param code     - ErrorCode sabiti
 * @param message  - İnsan okunabilir hata mesajı
 * @param options  - Opsiyonel context ve cause
 *
 * @example
 * return err(ErrorCode.RECORD_NOT_FOUND, `Project ${id} bulunamadı`, {
 *   context: { projectId: id },
 *   cause: originalError,
 * });
 */
export function err<T = never>(
  code:    ErrorCode,
  message: string,
  options?: {
    context?: MetaRecord;
    cause?:   unknown;
  },
): Result<T, AppError> {
  return {
    ok:    false,
    error: {
      code,
      message,
      context:   options?.context,
      cause:     options?.cause,
      timestamp: Date.now(),
    },
  };
}

/**
 * Mevcut bir AppError nesnesinden Result<T> üretir.
 * Repository katmanından yukarı hata iletirken kullanılır.
 *
 * @example
 * if (!result.ok) return errFrom(result.error);
 */
export function errFrom<T = never>(error: AppError): Result<T, AppError> {
  return { ok: false, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Type Guard'lar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result'ın başarılı olduğunu doğrular.
 * TypeScript'e `result.data`'nın güvenli olduğunu söyler.
 *
 * @example
 * if (isOk(result)) {
 *   console.log(result.data.name); // tip: IProject
 * }
 */
export function isOk<T, E extends AppError>(
  result: Result<T, E>,
): result is { ok: true; data: T } {
  return result.ok === true;
}

/**
 * Result'ın başarısız olduğunu doğrular.
 * TypeScript'e `result.error`'un güvenli olduğunu söyler.
 *
 * @example
 * if (isErr(result)) {
 *   logger.error(result.error.code);
 * }
 */
export function isErr<T, E extends AppError>(
  result: Result<T, E>,
): result is { ok: false; error: E } {
  return result.ok === false;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. Combinator'lar — Senkron
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Başarılı Result üzerinde dönüşüm uygular; hata durumunda iletir.
 * Railway-oriented programming'in map adımıdır.
 *
 * @example
 * const nameResult = mapResult(
 *   await projectRepo.findById(id),
 *   (project) => project.name,
 * );
 */
export function mapResult<T, U, E extends AppError>(
  result: Result<T, E>,
  fn:     (data: T) => U,
): Result<U, E> {
  if (!result.ok) return result;
  return { ok: true, data: fn(result.data) };
}

/**
 * Hata durumunda alternatif Result üretir; başarıda iletir.
 * Hata kurtarma (recovery) için kullanılır.
 *
 * @example
 * const result = mapError(
 *   await cacheRepo.findById(id),
 *   (_err) => ok(defaultProject),  // cache miss → varsayılana dön
 * );
 */
export function mapError<T, E extends AppError, F extends AppError>(
  result: Result<T, E>,
  fn:     (error: E) => Result<T, F>,
): Result<T, F> {
  if (result.ok) return result;
  return fn(result.error);
}

/**
 * Başarılı Result'dan yeni bir Result üreten fonksiyon çalıştırır.
 * Zincirleme I/O operasyonları için idealdir.
 *
 * @example
 * const filesResult = chainResult(
 *   await projectRepo.findById(id),       // Result<IProject>
 *   (project) => fileRepo.findByProject(project.id),  // Result<IFile[]>
 * );
 */
export function chainResult<T, U, E extends AppError>(
  result: Result<T, E>,
  fn:     (data: T) => Result<U, E>,
): Result<U, E> {
  if (!result.ok) return result;
  return fn(result.data);
}

/**
 * Başarılı ise `data`'yı, başarısız ise `fallback`'i döner.
 * UI render katmanında güvenli unwrap için kullanılır.
 *
 * @example
 * const name = getOrElse(projectResult, "İsimsiz Proje");
 */
export function getOrElse<T, E extends AppError>(
  result:   Result<T, E>,
  fallback: T,
): T {
  return result.ok ? result.data : fallback;
}

/**
 * Başarılı ise `data`'yı döner; başarısız ise hata fırlatır.
 * Yalnızca kesinlikle başarılı olması garantilenen yerlerde kullanılmalı.
 * Test kodunda serbestçe kullanılabilir, production'da dikkatli olunmalı.
 *
 * @throws Error — result başarısız ise
 */
export function unwrap<T, E extends AppError>(result: Result<T, E>): T {
  if (result.ok) return result.data;
  throw new Error(
    `Result unwrap başarısız: [${result.error.code}] ${result.error.message}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Combinator'lar — Asenkron
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `mapResult`'ın async versiyonu.
 * Dönüşüm fonksiyonu Promise döndürebilir.
 *
 * @example
 * const enriched = await mapResultAsync(
 *   await projectRepo.findById(id),
 *   async (project) => ({ ...project, files: await loadFiles(project.id) }),
 * );
 */
export async function mapResultAsync<T, U, E extends AppError>(
  result: Result<T, E>,
  fn:     (data: T) => Promise<U>,
): AsyncResult<U, E> {
  if (!result.ok) return result;
  const data = await fn(result.data);
  return { ok: true, data };
}

/**
 * `chainResult`'ın async versiyonu.
 * Asenkron repository zincirlerinde ana combinator budur.
 *
 * @example
 * const result = await chainResultAsync(
 *   await projectRepo.findById(id),
 *   (project) => fileRepo.findByProject(project.id),
 * );
 */
export async function chainResultAsync<T, U, E extends AppError>(
  result: Result<T, E>,
  fn:     (data: T) => AsyncResult<U, E>,
): AsyncResult<U, E> {
  if (!result.ok) return result;
  return fn(result.data);
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. Koleksiyon Yardımcıları
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result dizisini tek bir Result'a çöker.
 * İlk hata bulunduğunda durur (fail-fast).
 *
 * @example
 * const ids: UUID[] = ["a", "b", "c"];
 * const results = await Promise.all(ids.map((id) => fileRepo.findById(id)));
 * const combined = collectResults(results); // Result<IFile[]>
 */
export function collectResults<T, E extends AppError>(
  results: ReadonlyArray<Result<T, E>>,
): Result<T[], E> {
  const data: T[] = [];

  for (const result of results) {
    if (!result.ok) return result;
    data.push(result.data);
  }

  return { ok: true, data };
}

/**
 * Async operasyonları paralel çalıştırır ve sonuçları çöker.
 * `collectResults`'ın Promise.all varyantı.
 *
 * @example
 * const result = await collectResultsAsync(
 *   ids.map((id) => fileRepo.findById(id)),
 * );
 */
export async function collectResultsAsync<T, E extends AppError>(
  promises: ReadonlyArray<AsyncResult<T, E>>,
): AsyncResult<T[], E> {
  const results = await Promise.all(promises);
  return collectResults(results);
}

// ─────────────────────────────────────────────────────────────────────────────
// § 6. Try-Catch Sarmalayıcılar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Senkron try/catch bloğunu Result'a dönüştürür.
 * Üçüncü taraf kütüphane çağrılarını sarmak için kullanılır.
 *
 * @example
 * const parsed = tryResult(
 *   () => JSON.parse(rawText),
 *   ErrorCode.VALIDATION_ERROR,
 *   "Geçersiz JSON",
 * );
 */
export function tryResult<T>(
  fn:      () => T,
  code:    ErrorCode,
  message: string,
  context?: MetaRecord,
): Result<T, AppError> {
  try {
    return { ok: true, data: fn() };
  } catch (cause) {
    return err(code, message, { context, cause });
  }
}

/**
 * Async try/catch bloğunu AsyncResult'a dönüştürür.
 * Tüm repository implementasyonlarının temel sarmalayıcısıdır.
 *
 * @example
 * return tryResultAsync(
 *   () => db.query("SELECT * FROM projects WHERE id = ?", [id]),
 *   ErrorCode.DB_QUERY_FAILED,
 *   `Project ${id} sorgulanamadı`,
 *   { projectId: id },
 * );
 */
export async function tryResultAsync<T>(
  fn:      () => Promise<T>,
  code:    ErrorCode,
  message: string,
  context?: MetaRecord,
): AsyncResult<T, AppError> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (cause) {
    return err(code, message, { context, cause });
  }
}
