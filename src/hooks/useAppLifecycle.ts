/**
 * @file  hooks/useAppLifecycle.ts
 *
 * Uygulama ön plan / arka plan geçişlerini dinler.
 * App.tsx'teki AppState listener buraya taşındı.
 *
 * Sorumluluk: sadece AppState → EventBus köprüsü.
 */

import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";

import type { IEventBus } from "@/core/EventBus";

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useAppLifecycle(eventBus: IEventBus | null): void {
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    // eventBus hazır değilse (boot tamamlanmadan) dinleme başlatma
    if (!eventBus) return;

    const subscription = AppState.addEventListener(
      "change",
      (nextState: AppStateStatus) => {
        const prev = appStateRef.current;
        appStateRef.current = nextState;

        if (
          (prev === "background" || prev === "inactive") &&
          nextState === "active"
        ) {
          eventBus.emit("app:foreground", {});
        }

        if (
          prev === "active" &&
          (nextState === "background" || nextState === "inactive")
        ) {
          eventBus.emit("app:background", {});
        }
      },
    );

    return () => subscription.remove();
  }, [eventBus]);
}
