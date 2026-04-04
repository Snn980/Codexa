/**
 * @file  theme/ThemeContext.tsx
 *
 * Merkezi tema sistemi.
 *
 * Kullanım:
 *   const { colors, theme, isDark } = useTheme();
 *
 * ThemeProvider:
 *   - Başlangıç temasını settingsRepository'den okur
 *   - settings:changed eventBus olayını dinler → anlık güncelleme
 *   - AppProviders içinde yer alır; tüm ekranlar erişebilir
 *
 * Ekranlarda renk kullanımı:
 *   ✅  const { colors } = useTheme();
 *       style={{ backgroundColor: colors.bg }}
 *
 *   ❌  style={{ backgroundColor: '#0d1117' }}  ← hardcoded, bu pattern kaldırılıyor
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';

import { THEME_PALETTES, darkColors } from './colors';
import type { ThemeColors, ThemeName } from './colors';
import type { EditorTheme, ISettings } from '@/types/core';

// ─── Tip ─────────────────────────────────────────────────────────────────────

export interface ThemeContextValue {
  /** Aktif renk paleti — her ekran buradan okur */
  colors:  ThemeColors;
  /** Aktif tema adı: 'dark' | 'light' | 'high-contrast' */
  theme:   ThemeName;
  /** Karanlık mı? — StatusBar barStyle için kullanışlı */
  isDark:  boolean;
  /** Temayı programatik olarak değiştir (settingsRepository üzerinden) */
  setTheme: (theme: EditorTheme) => void;
}

// ─── Context ─────────────────────────────────────────────────────────────────

const ThemeContext = createContext<ThemeContextValue>({
  colors:   darkColors,
  theme:    'dark',
  isDark:   true,
  setTheme: () => {},
});

// ─── Provider ────────────────────────────────────────────────────────────────

export interface ThemeProviderProps {
  initialTheme?: EditorTheme;
  onThemeChange?: (theme: EditorTheme) => void;
  onSettingsSubscribe?: (
    listener: (payload: { prev: ISettings; next: ISettings }) => void,
  ) => (() => void);
  children: React.ReactNode;
}

export function ThemeProvider({
  initialTheme = 'dark',
  onThemeChange,
  onSettingsSubscribe,
  children,
}: ThemeProviderProps): React.ReactElement {
  const [theme, setThemeState] = useState<ThemeName>(
    (initialTheme as ThemeName) ?? 'dark',
  );

  // EventBus üzerinden settings:changed → tema güncelle
  useEffect(() => {
    if (!onSettingsSubscribe) return;

    const unsub = onSettingsSubscribe(({ next }) => {
      const incoming = next.theme as ThemeName;
      if (incoming && THEME_PALETTES[incoming]) {
        setThemeState(incoming);
      }
    });

    return unsub;
  }, [onSettingsSubscribe]);

  const handleSetTheme = useCallback((newTheme: EditorTheme) => {
    const name = newTheme as ThemeName;
    if (!THEME_PALETTES[name]) return;
    setThemeState(name);
    onThemeChange?.(newTheme);
  }, [onThemeChange]);

  const value: ThemeContextValue = {
    colors:   THEME_PALETTES[theme] ?? darkColors,
    theme,
    isDark:   theme !== 'light',
    setTheme: handleSetTheme,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Aktif tema paletine ve yardımcı değerlere erişim sağlar.
 *
 * @example
 *   const { colors, isDark } = useTheme();
 *   return <View style={{ backgroundColor: colors.bg }} />;
 */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
