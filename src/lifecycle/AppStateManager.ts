/**
 * lifecycle/AppStateManager.ts — T-P10-2: AppState lifecycle yönetimi
 *
 * DÜZELTME #3 — Küçük lifecycle edge case:
 *   ❌ _handleAppStateChange async. Şu senaryo mümkün:
 *      1. background → active geçişi tetiklenir
 *      2. _onForeground() içinde `await this._keyStore.getKey(provider)` bekliyor
 *      3. Bu await sırasında dispose() çağrılır
 *      4. Await biter → `_disposed` kontrolü yok → bridge.postMessage(SET_KEY) çalışır
 *         (dispose edilmiş bridge'e mesaj gönderiliyor — crash riski)
 *
 *   ✅ Çözüm: Her `await` sonrasında `if (this._disposed) return` guard.
 *      _onBackground ve _onForeground'da await öncesi/sonrası kontrol.
 *
 *   ❌ İkinci edge case: start() çağrılmadan simulateStateChange() tetiklenirse
 *      `_currentState = "active"` (initial) ama subscription yok.
 *      Bu test ortamında sorun değil ama production'da karışıklık yaratır.
 *
 *   ✅ Çözüm: simulateStateChange() start() gerektirmez (test hook'u),
 *      ama _handleAppStateChange _disposed kontrolü her await'te çalışır.
 *
 * § 1  : Result<T>
 * § 4  : AppContainer DI
 */

import { AppState, type AppStateStatus } from "react-native";
import type { IAPIKeyStoreExtended }      from "../security/APIKeyStore";
import type { AIWorkerBridge }            from "../ai/AIWorkerBridge";

export class AppStateManager {
  private readonly _keyStore: IAPIKeyStoreExtended;
  private readonly _bridge:   AIWorkerBridge | null;
  private _currentState: AppStateStatus = "active";
  private _subscription: ReturnType<typeof AppState.addEventListener> | null = null;
  private _disposed = false;

  constructor(opts: {
    keyStore: IAPIKeyStoreExtended;
    bridge:   AIWorkerBridge | null;
  }) {
    this._keyStore = opts.keyStore;
    this._bridge   = opts.bridge;
  }

  // ─── Başlatma ──────────────────────────────────────────────────────────────

  start(): void {
    if (this._disposed || this._subscription) return;
    this._currentState = AppState.currentState;
    this._subscription = AppState.addEventListener(
      "change",
      this._handleAppStateChange,
    );
  }

  // ─── AppState handler ─────────────────────────────────────────────────────

  private _handleAppStateChange = async (
    nextState: AppStateStatus,
  ): Promise<void> => {
    if (this._disposed) return;

    const prev = this._currentState;
    this._currentState = nextState;

    const goingToBackground =
      prev === "active" &&
      (nextState === "background" || nextState === "inactive");

    const comingToForeground =
      (prev === "background" || prev === "inactive") &&
      nextState === "active";

    if (goingToBackground) {
      await this._onBackground();
    } else if (comingToForeground) {
      await this._onForeground();
    }
  };

  // ─── Background ───────────────────────────────────────────────────────────

  private async _onBackground(): Promise<void> {
    if (this._disposed) return; // ✅ async başlamadan önce kontrol

    // Senkron — await yok, ara kontrol gereksiz
    this._keyStore.clearMemoryCache();

    if (this._disposed) return; // ✅ clearMemoryCache sonrası kontrol
    if (this._bridge) {
      try { this._bridge.postMessage({ type: "CLEAR_KEYS" }); }
      catch { /* bridge kapalı */ }
    }
  }

  // ─── Foreground ───────────────────────────────────────────────────────────

  /**
   * ✅ DÜZELTME #3: Her await sonrasında disposed kontrolü.
   *
   * Senaryo:
   *   getKey("anthropic") await ederken → dispose() → getKey biter
   *   → disposed=true → SET_KEY gönderilmez → güvenli
   */
  private async _onForeground(): Promise<void> {
    if (this._disposed) return;
    if (!this._bridge) return;

    for (const provider of ["anthropic", "openai"] as const) {
      // ✅ Her döngü başında disposed kontrolü
      if (this._disposed) return;

      let key: string | null;
      try {
        key = await this._keyStore.getKey(provider);
      } catch {
        continue;
      }

      // ✅ DÜZELTME #3: await sonrası disposed kontrolü
      //    dispose() getKey bekliyorken çağrıldıysa burada durur
      if (this._disposed) return;

      if (!key) continue;

      try {
        this._bridge.postMessage({ type: "SET_KEY", provider, key });
      } catch { /* bridge kapalı */ }
    }
  }

  // ─── Test hook ────────────────────────────────────────────────────────────

  async simulateStateChange(next: AppStateStatus): Promise<void> {
    await this._handleAppStateChange(next);
  }

  get currentState(): AppStateStatus { return this._currentState; }

  // ─── Dispose ──────────────────────────────────────────────────────────────

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._subscription?.remove();
    this._subscription = null;
  }
}

export function createAppStateManager(opts: {
  keyStore: IAPIKeyStoreExtended;
  bridge:   AIWorkerBridge | null;
}): AppStateManager {
  return new AppStateManager(opts);
}
