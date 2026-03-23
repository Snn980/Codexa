/**
 * src/core/EventBus.ts
 *
 * Geriye dönük uyumluluk köprüsü.
 * Canonical konum: src/core/event-bus/EventBus.ts
 * IEventBus tipi: src/types/core.ts
 *
 * § 3 : IEventBus | on() → unsub() | emit() never throws
 */
export {
  EventBus,
  getAppEventBus,
  createEventBus,
  resetAppEventBus,
} from './event-bus/EventBus';

export type {
  IEventBus,
  AppEventMap,
  EventListener,
} from '../types/core';
