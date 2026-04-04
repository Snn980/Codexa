/**
 * @file  theme/index.ts
 * Public API — dış modüller buradan import eder.
 */

export { useTheme, ThemeProvider } from './ThemeContext';
export type { ThemeContextValue, ThemeProviderProps } from './ThemeContext';
export { THEME_PALETTES, darkColors, lightColors, highContrastColors } from './colors';
export type { ThemeColors, ThemeName } from './colors';
