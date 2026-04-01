/**
 * @file  hooks/useAppBoot.ts
 *
 * Boot state machine — initializeApp() üzerinden çalışır.
 * AppContainer bağımlılığı kaldırıldı.
 */

import { useState, useCallback, useRef } from "react";

import { getApp }              from "@/index";
import { sentryService }       from "@/monitoring/SentryService";
import { initializeApp, disposeApp } from "@/app/system/initializeApp";

import type { AppServices }    from "@/app/system/AppServices";

// ─── Tipler ──────────────────────────────────────────────────────────────────

export type BootPhase =
  | { phase: "booting" }
  | { phase: "ready";  services: AppServices }
  | { phase: "error";  message: string };

export interface UseAppBootReturn {
  boot:       BootPhase;
  initialize: () => Promise<void>;
  dispose:    () => void;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useAppBoot(): UseAppBootReturn {
  const [boot, setBoot]       = useState<BootPhase>({ phase: "booting" });
  const servicesRef           = useRef<AppServices | null>(null);

  const initialize = useCallback(async () => {
    setBoot({ phase: "booting" });

    // 1. Sentry — mümkün olan en erken noktada
    void sentryService.init();

    // 2. Base services (ProjectService, FileService, DB)
    const result = await getApp().initialize();
    if (!result.ok) {
      setBoot({ phase: "error", message: result.error.message });
      return;
    }

    // 3. App services
    try {
      const services = await initializeApp({
        eventBus: getApp().services.eventBus,
      });

      servicesRef.current = services;
      setBoot({ phase: "ready", services });
    } catch (e) {
      const message = e instanceof Error ? e.message : "App init failed";
      setBoot({ phase: "error", message });
    }
  }, []);

  const dispose = useCallback(() => {
    if (servicesRef.current) {
      disposeApp(servicesRef.current);
      servicesRef.current = null;
    }
    void getApp().dispose();
  }, []);

  return { boot, initialize, dispose };
}
