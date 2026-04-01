/**
 * @file  App.tsx
 *
 * Uygulama kök bileşeni — sadece orchestrator.
 * AppContainer bağımlılığı kaldırıldı.
 */

import React, { useEffect } from "react";

import { useAppBoot }       from "@/hooks/useAppBoot";
import { useAppLifecycle }  from "@/hooks/useAppLifecycle";
import { AppProviders }     from "@/app/AppProviders";
import { AppErrorBoundary } from "@/app/AppErrorBoundary";
import { BootScreen, ErrorScreen } from "@/app/screens/BootScreens";
import { sentryService }    from "@/monitoring/SentryService";
import { RootNavigator }    from "@/navigations/RootNavigator";

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App(): React.ReactElement {
  const { boot, initialize, dispose } = useAppBoot();

  useEffect(() => {
    void initialize();
    return () => dispose();
  }, [initialize, dispose]);

  useAppLifecycle(
    boot.phase === "ready" ? boot.services.eventBus : null,
  );

  if (boot.phase === "booting") return <BootScreen />;

  if (boot.phase === "error") {
    return <ErrorScreen message={boot.message} onRetry={initialize} />;
  }

  return (
    <AppProviders services={boot.services}>
      <AppErrorBoundary onRetry={initialize}>
        <RootNavigator
          onNavError={(error, info) => {
            boot.services.eventBus.emit("nav:error", { error: error.message });
            sentryService.captureNavError(error, info);
            if (__DEV__) console.error("[App] nav error:", error, info);
          }}
        />
      </AppErrorBoundary>
    </AppProviders>
  );
}
