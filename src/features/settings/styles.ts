/**
 * features/settings/styles.ts
 *
 * Tema güncellemesi:
 *   Sabit COLORS + StyleSheet.create → useSettingsStyles() hook'u
 *   Tüm Settings sub-componentleri (SettingsSection, ToggleRow vb.)
 *   bu hook'u çağırır → tema değişince anlık güncellenir.
 *
 * Geriye dönük uyumluluk:
 *   COLORS export korundu (dışarıdan kullananlar varsa kırılmaz)
 *   styles export → useSettingsStyles() hook'unun statik fallback'i
 */

import { useMemo } from 'react';
import { Platform } from 'react-native';
import { useTheme } from '@/theme';
import type { ThemeColors } from '@/theme';

export const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// ─── Geriye dönük uyumluluk — sabit renk export ───────────────────────────────
// Yeni kod useSettingsStyles() kullanmalı.

export const COLORS = {
  bg:      '#0a0e1a',
  surface: '#0d1117',
  border:  'rgba(255,255,255,0.06)',
  accent:  '#3b82f6',
  text:    '#f1f5f9',
  muted:   '#475569',
  subtle:  '#334155',
  success: '#22c55e',
} as const;

// ─── Dinamik stil fabrikası ───────────────────────────────────────────────────

export function makeSettingsStyles(C: ThemeColors) {
  return {
    container:           { flex: 1, backgroundColor: C.bg },
    center:              { alignItems: 'center' as const, justifyContent: 'center' as const },
    header:              { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
    headerTitle:         { fontSize: 15, fontWeight: '700' as const, color: C.text, fontFamily: MONO },
    headerRight:         { flexDirection: 'row' as const, alignItems: 'center' as const },
    resetText:           { fontSize: 12, color: C.muted, fontFamily: MONO },
    content:             { padding: 12, gap: 16, paddingBottom: 40 },

    // Section
    section:             { gap: 6 },
    sectionTitle:        { fontSize: 10, color: C.muted, fontFamily: MONO, letterSpacing: 0.8, textTransform: 'uppercase' as const, paddingLeft: 4 },
    sectionCard:         { backgroundColor: C.surface, borderRadius: 10, borderWidth: 1, borderColor: C.border, overflow: 'hidden' as const },

    // Row
    row:                 { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
    rowLeft:             { flex: 1, gap: 2 },
    rowLabel:            { fontSize: 13, color: C.text, fontFamily: MONO },
    rowDesc:             { fontSize: 10, color: C.muted, fontFamily: MONO },
    infoValue:           { fontSize: 12, color: C.muted, fontFamily: MONO },

    // Stepper
    stepper:             { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
    stepBtn:             { width: 28, height: 28, borderRadius: 6, backgroundColor: C.surface2, alignItems: 'center' as const, justifyContent: 'center' as const, borderWidth: 1, borderColor: C.border },
    stepBtnText:         { fontSize: 16, color: C.text, lineHeight: 20 },
    stepBtnDisabled:     { color: C.muted, opacity: 0.4 },
    stepValue:           { fontSize: 12, color: C.text, fontFamily: MONO, minWidth: 60, textAlign: 'center' as const },

    // Segment
    segmentRow:          { paddingHorizontal: 14, paddingVertical: 10, gap: 8, borderBottomWidth: 1, borderBottomColor: C.border },
    segmentControl:      { flexDirection: 'row' as const, backgroundColor: C.bg, borderRadius: 8, padding: 3, gap: 2, borderWidth: 1, borderColor: C.border },
    segmentOption:       { flex: 1, paddingVertical: 6, borderRadius: 6, alignItems: 'center' as const },
    segmentOptionActive: { backgroundColor: C.accent },
    segmentText:         { fontSize: 11, color: C.muted, fontFamily: MONO },
    segmentTextActive:   { color: '#ffffff', fontWeight: '600' as const },

    // Switch colors (for Switch component)
    switchTrackTrue:  C.accent,
    switchTrackFalse: C.border,
    switchThumbTrue:  '#ffffff',
    switchThumbFalse: C.muted,
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSettingsStyles() {
  const { colors } = useTheme();
  return useMemo(() => makeSettingsStyles(colors), [colors]);
}

// ─── Backward-compat static export ───────────────────────────────────────────
// Eski import edenler kırılmaz; yeni componentler useSettingsStyles() kullanmalı.

export const styles = makeSettingsStyles({
  bg: COLORS.bg, surface: '#0d1117', surface2: '#111827',
  toolbar: '#21262d', border: COLORS.border, separator: 'rgba(255,255,255,0.04)',
  text: COLORS.text, textSecondary: '#8b949e', muted: COLORS.muted,
  accent: COLORS.accent, accentMuted: 'rgba(56,139,253,0.15)',
  success: COLORS.success, warning: '#d29922', error: '#f85149', info: '#58a6ff',
  terminal: { bg: '#010409', stdout: '#e6edf3', stderr: '#ffa198', info: '#58a6ff', success: '#3fb950', warn: '#d29922', prompt: '#3fb950' },
  editor:   { bg: '#0d1117', activeLine: 'rgba(56,139,253,0.08)', selection: 'rgba(56,139,253,0.25)', lineNumber: '#484f58', cursor: '#388bfd' },
  tabBar:   { bg: '#010409', active: '#58a6ff', inactive: '#484f58', indicator: '#388bfd' },
  chat:     { userBubble: '#1f6feb', userText: '#ffffff', aiBubble: '#1c2128', aiText: '#e6edf3', inputBg: '#161b22' },
} as ThemeColors);
