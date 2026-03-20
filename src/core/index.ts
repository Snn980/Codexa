/**
 * src/core/index.ts — Core barrel export
 *
 * Birden fazla dosyanın "../../core" veya "../core" şeklinde
 * dizin bazlı import yapmasını sağlar.
 *
 * Canonical kaynaklar:
 *   Tipler (UUID, Result, AppError, IEventBus, AppEventMap, Values …) → types/core.ts
 *   Result builders (ok, err, errFrom, tryResultAsync …)              → utils/result.ts
 *   EventBus (EventBus class, createEventBus, getAppEventBus …)       → core/Event-bus/EventBus.ts
 */

// ─── Tipler ───────────────────────────────────────────────────────────────────
export type {
  UUID,
  Timestamp,
  MetaRecord,
  Values,
  DeepReadonly,
  RequireFields,
  ErrorCode,
  AppError,
  Result,
  AsyncResult,
  IEventBus,
  EventListener,
  AppEventMap,
  AIProvider,
  AIPermissionStatus,
  AIPermissionState,
  IProject,
  IFile,
  ISettings,
  ITab,
  IAISession,
  AIMessage,
  Diagnostic,
  DiagnosticSeverity,
  Position,
  CursorPosition,
} from '../types/core';

// ─── ErrorCode sabiti (value olarak) ─────────────────────────────────────────
export { ErrorCode } from '../types/core';

// ─── Result builder'ları ──────────────────────────────────────────────────────
export {
  ok,
  err,
  errFrom,
  tryResultAsync,
  isOk,
  isErr,
  mapResult,
  mapError,
  chainResult,
  getOrElse,
  unwrap,
  mapResultAsync,
  chainResultAsync,
  collectResults,
  collectResultsAsync,
  tryResult,
} from '../utils/result';

// ─── EventBus ────────────────────────────────────────────────────────────────
export {
  EventBus,
  getAppEventBus,
  createEventBus,
  resetAppEventBus,
} from './Event-bus/EventBus';
