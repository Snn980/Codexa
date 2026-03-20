/**
 * src/core/Result.ts
 *
 * Geriye dönük uyumluluk köprüsü.
 * Canonical konum: src/utils/result.ts
 * Bu dosya eski import path'lerini kırmadan çalışmaya devam ettirir.
 *
 * § 1 : Result<T> | ok() | err() | errFrom() | tryResultAsync()
 */
export {
  ok,
  err,
  errFrom,
  tryResultAsync,
} from '../utils/result';

export type {
  Result,
  AsyncResult,
  AppError,
} from '../utils/result';

// ErrorCode — canonical: types/core.ts
export { ErrorCode } from '../types/core';
export type { ErrorCode } from '../types/core';
