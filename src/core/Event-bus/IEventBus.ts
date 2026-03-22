/**
 * core/Event-bus/IEventBus.ts
 * Genel IEventBus arayüzü — AppEventMap bağımlılığı yok.
 * runtime/ ve language-services/ katmanları bu arayüzü kullanır.
 */

export interface IEventBus {
  emit(event: string, payload?: unknown): void;
  on(event: string, listener: (payload: unknown) => void): () => void;
  off(event: string, listener: (payload: unknown) => void): void;
  once(event: string, listener: (payload: unknown) => void): void;
  onError(handler: (event: string, error: unknown) => void): void;
  removeAllListeners(event?: string): void;
}
