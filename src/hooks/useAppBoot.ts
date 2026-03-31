/**
 * @file  hooks/useAppBoot.ts
 *
 * Uygulama başlatma state machine'i.
 * App.tsx'teki initialize() + BootState buraya taşındı.
 *
 * Sorumluluk: sadece boot — UI yok, lifecycle yok.
 */

import { useState, useCallback } from "react";

import AsyncStorage           from "@react-native-async-storage/async-storage";
import { getApp }             from "@/index";
import { Database }           from "@/storage/Database";
import type { AppServices }   from "@/index";
import { appContainer }       from "@/app/AppContainer";
import { sentryService }      from "@/monitoring/SentryService";

// ─── Tipler ──────────────────────────────────────────────────────────────────

export type BootPhase =
  | { phase: "booting" }
  | { phase: "ready";  services: AppServices }
  | { phase: "error";  message: string };

export interface UseAppBootReturn {
  boot:       BootPhase;
  initialize: () => Promise<void>;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useAppBoot(): UseAppBootReturn {
  const [boot, setBoot] = useState<BootPhase>({ phase: "booting" });

  const initialize = useCallback(async () => {
    setBoot({ phase: "booting" });

    // 1. Sentry — mümkün olan en erken noktada, hataları bloklamaz
    void sentryService.init();

    // 2. Base services (ProjectService, FileService, DB)
    const result = await getApp().initialize();
    if (!result.ok) {
      setBoot({ phase: "error", message: result.error.message });
      return;
    }

    // 3. AI container
    try {
      await appContainer.init({
        eventBus:     getApp().services.eventBus,
        asyncStorage: AsyncStorage,
        dbDriver: (() => {
          try { return Database.getInstance().getDriver(); }
          catch { return undefined; }
        })(),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "AI container init failed";
      setBoot({ phase: "error", message });
      return;
    }

    setBoot({ phase: "ready", services: getApp().services });
  }, []);

  return { boot, initialize };
}
