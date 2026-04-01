/**
 * @file  app/AppProviders.tsx
 *
 * Tüm React provider'ları tek noktada toplar.
 * Yeni provider eklemek için sadece bu dosya değişir — App.tsx dokunulmaz.
 *
 * Mevcut:
 *   AppContext      → servis enjeksiyonu
 *   SafeAreaProvider → safe area insets
 *
 * İleride buraya eklenir:
 *   ThemeProvider, QueryClientProvider, vb.
 */

import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AppContext }      from "@/app/AppContext";
import type { AppServices } from "@/app/system/AppServices";

// ─── Tipler ──────────────────────────────────────────────────────────────────

interface AppProvidersProps {
  services: AppServices;
  children: React.ReactNode;
}

// ─── Bileşen ─────────────────────────────────────────────────────────────────

export function AppProviders({ services, children }: AppProvidersProps): React.ReactElement {
  return (
    <AppContext.Provider value={{ services }}>
      <SafeAreaProvider>
        {children}
      </SafeAreaProvider>
    </AppContext.Provider>
  );
}
