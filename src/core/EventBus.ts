/**
 * src/core/EventBus.ts
 *
 * Geriye dönük uyumluluk köprüsü.
 * Canonical konum: src/core/Event-bus/EventBus.ts
 * IEventBus tipi: src/types/core.ts
 *
 * § 3 : IEventBus | on() → unsub() | emit() never throws
 */
export {
  EventBus,
  getAppEventBus,
  createEventBus,
  resetAppEventBus,
} from './Event-bus/EventBus';

export type {
  IEventBus,
  AppEventMap,
  EventListener,
} from '../types/core';
