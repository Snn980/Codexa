/**
 * src/core/Result.ts — geriye dönük uyumluluk köprüsü.
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
} from '../types/core';

// ErrorCode — value olarak (type ayrı export edilmez, value export tipi de kapsar)
export { ErrorCode } from '../types/core';
