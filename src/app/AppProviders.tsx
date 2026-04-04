/**
 * @file  app/AppProviders.tsx
 *
 * Tüm React provider'ları tek noktada toplar.
 *
 * Provider sırası (dıştan içe):
 *   AppContext         → servis enjeksiyonu (en dışta — diğerleri servise erişebilsin)
 *   SafeAreaProvider  → safe area insets
 *   ThemeProvider     → tema sistemi (settingsRepository + eventBus bağlı)
 *
 * Yeni provider eklemek için sadece bu dosya değişir — App.tsx dokunulmaz.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppContext }      from '@/app/AppContext';
import { ThemeProvider }   from '@/theme/ThemeContext';
import type { AppServices } from '@/app/system/AppServices';
import type { EditorTheme, ISettings } from '@/types/core';

// ─── Tipler ──────────────────────────────────────────────────────────────────

interface AppProvidersProps {
  services: AppServices;
  children: React.ReactNode;
}

// ─── İç bileşen: tema köprüsü ────────────────────────────────────────────────
//
// AppContext içindeyiz, bu yüzden services'e erişebiliriz.
// settingsRepository'den başlangıç temasını okur.
// eventBus'tan settings:changed dinler → ThemeProvider'ı günceller.

function ThemeBridge({
  services,
  children,
}: {
  services: AppServices;
  children: React.ReactNode;
}): React.ReactElement {
  const [initialTheme, setInitialTheme] = useState<EditorTheme>('dark');
  const [ready, setReady]               = useState(false);
  const mountedRef                      = useRef(true);

  // Başlangıç temasını oku
  useEffect(() => {
    mountedRef.current = true;

    void services.settingsRepository.get().then((result) => {
      if (!mountedRef.current) return;
      if (result.ok) {
        setInitialTheme(result.data.theme);
      }
      setReady(true);
    }).catch(() => {
      if (mountedRef.current) setReady(true);
    });

    return () => { mountedRef.current = false; };
  }, [services.settingsRepository]);

  // settings:changed → tema senkronizasyonu için subscribe factory
  const onSettingsSubscribe = useCallback(
    (listener: (payload: { prev: ISettings; next: ISettings }) => void) => {
      return services.eventBus.on('settings:changed', listener);
    },
    [services.eventBus],
  );

  // Tema değişikliğini settingsRepository'ye kaydet
  const onThemeChange = useCallback((theme: EditorTheme) => {
    void services.settingsRepository.set({ theme });
  }, [services.settingsRepository]);

  if (!ready) {
    // settingsRepository hazır olmadan ThemeProvider mount edilmez.
    // Genellikle < 50ms — kullanıcı görmez.
    return <>{children}</>;
  }

  return (
    <ThemeProvider
      initialTheme={initialTheme}
      onThemeChange={onThemeChange}
      onSettingsSubscribe={onSettingsSubscribe}
    >
      {children}
    </ThemeProvider>
  );
}

// ─── AppProviders ─────────────────────────────────────────────────────────────

export function AppProviders({ services, children }: AppProvidersProps): React.ReactElement {
  return (
    <AppContext.Provider value={{ services }}>
      <SafeAreaProvider>
        <ThemeBridge services={services}>
          {children}
        </ThemeBridge>
      </SafeAreaProvider>
    </AppContext.Provider>
  );
}
