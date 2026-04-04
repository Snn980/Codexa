/**
 * @file  theme/colors.ts
 *
 * Uygulama genelinde kullanılan renk paletleri.
 * Her ekran sabit renk yazmak yerine bu dosyadan okur.
 *
 * Paletler:
 *   dark         → Varsayılan karanlık IDE teması (VSCode dark benzeri)
 *   light        → Aydınlık tema (okunabilir, göz yormaz)
 *   high-contrast → Yüksek kontrast (erişilebilirlik)
 */

export interface ThemeColors {
  // Zemin katmanları
  bg:        string;   // En alt zemin
  surface:   string;   // Kart, panel
  surface2:  string;   // İç kart, input bg
  toolbar:   string;   // Toolbar / header bg

  // Çizgiler
  border:    string;
  separator: string;

  // Metin
  text:      string;   // Birincil metin
  textSecondary: string; // İkincil / açıklama
  muted:     string;   // Pasif / placeholder

  // Aksanlar
  accent:    string;   // Birincil aksan (buton, bağlantı)
  accentMuted: string; // Aksan arka plan (badge, highlight)

  // Durum renkleri
  success:   string;
  warning:   string;
  error:     string;
  info:      string;

  // Terminal'e özgü
  terminal:  {
    bg:      string;
    stdout:  string;
    stderr:  string;
    info:    string;
    success: string;
    warn:    string;
    prompt:  string;
  };

  // Editör'e özgü
  editor: {
    bg:         string;
    activeLine: string;
    selection:  string;
    lineNumber: string;
    cursor:     string;
  };

  // Tab bar
  tabBar: {
    bg:       string;
    active:   string;
    inactive: string;
    indicator: string;
  };

  // Chat'e özgü
  chat: {
    userBubble:   string;
    userText:     string;
    aiBubble:     string;
    aiText:       string;
    inputBg:      string;
  };
}

// ─── Karanlık Tema ────────────────────────────────────────────────────────────

export const darkColors: ThemeColors = {
  bg:        '#0d1117',
  surface:   '#161b22',
  surface2:  '#1c2128',
  toolbar:   '#21262d',

  border:    'rgba(240,246,252,0.10)',
  separator: 'rgba(240,246,252,0.06)',

  text:          '#e6edf3',
  textSecondary: '#8b949e',
  muted:         '#484f58',

  accent:      '#388bfd',
  accentMuted: 'rgba(56,139,253,0.15)',

  success: '#3fb950',
  warning: '#d29922',
  error:   '#f85149',
  info:    '#58a6ff',

  terminal: {
    bg:      '#010409',
    stdout:  '#e6edf3',
    stderr:  '#ffa198',
    info:    '#58a6ff',
    success: '#3fb950',
    warn:    '#d29922',
    prompt:  '#3fb950',
  },

  editor: {
    bg:         '#0d1117',
    activeLine: 'rgba(56,139,253,0.08)',
    selection:  'rgba(56,139,253,0.25)',
    lineNumber: '#484f58',
    cursor:     '#388bfd',
  },

  tabBar: {
    bg:        '#010409',
    active:    '#58a6ff',
    inactive:  '#484f58',
    indicator: '#388bfd',
  },

  chat: {
    userBubble: '#1f6feb',
    userText:   '#ffffff',
    aiBubble:   '#1c2128',
    aiText:     '#e6edf3',
    inputBg:    '#161b22',
  },
};

// ─── Aydınlık Tema ────────────────────────────────────────────────────────────

export const lightColors: ThemeColors = {
  bg:        '#ffffff',
  surface:   '#f6f8fa',
  surface2:  '#eaeef2',
  toolbar:   '#f6f8fa',

  border:    'rgba(31,35,40,0.15)',
  separator: 'rgba(31,35,40,0.08)',

  text:          '#1f2328',
  textSecondary: '#59636e',
  muted:         '#9198a1',

  accent:      '#0969da',
  accentMuted: 'rgba(9,105,218,0.12)',

  success: '#1a7f37',
  warning: '#9a6700',
  error:   '#d1242f',
  info:    '#0969da',

  terminal: {
    bg:      '#f6f8fa',
    stdout:  '#1f2328',
    stderr:  '#d1242f',
    info:    '#0969da',
    success: '#1a7f37',
    warn:    '#9a6700',
    prompt:  '#1a7f37',
  },

  editor: {
    bg:         '#ffffff',
    activeLine: 'rgba(9,105,218,0.05)',
    selection:  'rgba(9,105,218,0.15)',
    lineNumber: '#9198a1',
    cursor:     '#0969da',
  },

  tabBar: {
    bg:        '#f6f8fa',
    active:    '#0969da',
    inactive:  '#9198a1',
    indicator: '#0969da',
  },

  chat: {
    userBubble: '#0969da',
    userText:   '#ffffff',
    aiBubble:   '#eaeef2',
    aiText:     '#1f2328',
    inputBg:    '#f6f8fa',
  },
};

// ─── Yüksek Kontrast Tema ─────────────────────────────────────────────────────

export const highContrastColors: ThemeColors = {
  bg:        '#000000',
  surface:   '#0a0a0a',
  surface2:  '#111111',
  toolbar:   '#0a0a0a',

  border:    'rgba(255,255,255,0.30)',
  separator: 'rgba(255,255,255,0.20)',

  text:          '#ffffff',
  textSecondary: '#cccccc',
  muted:         '#888888',

  accent:      '#1aff8c',
  accentMuted: 'rgba(26,255,140,0.15)',

  success: '#1aff8c',
  warning: '#ffdd00',
  error:   '#ff4444',
  info:    '#4fc3f7',

  terminal: {
    bg:      '#000000',
    stdout:  '#ffffff',
    stderr:  '#ff4444',
    info:    '#4fc3f7',
    success: '#1aff8c',
    warn:    '#ffdd00',
    prompt:  '#1aff8c',
  },

  editor: {
    bg:         '#000000',
    activeLine: 'rgba(26,255,140,0.10)',
    selection:  'rgba(26,255,140,0.30)',
    lineNumber: '#888888',
    cursor:     '#1aff8c',
  },

  tabBar: {
    bg:        '#000000',
    active:    '#1aff8c',
    inactive:  '#666666',
    indicator: '#1aff8c',
  },

  chat: {
    userBubble: '#1aff8c',
    userText:   '#000000',
    aiBubble:   '#111111',
    aiText:     '#ffffff',
    inputBg:    '#0a0a0a',
  },
};

// ─── Tema → Palet haritası ────────────────────────────────────────────────────

export const THEME_PALETTES = {
  dark:           darkColors,
  light:          lightColors,
  'high-contrast': highContrastColors,
} as const;

export type ThemeName = keyof typeof THEME_PALETTES;
