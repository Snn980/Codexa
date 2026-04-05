/**
 * app/components/MobileKeyboard.tsx
 *
 * Değişiklikler:
 *   • useTheme() entegrasyonu — hardcoded COLORS kaldırıldı
 *   • Gezinme tuşları aktif — cursor-left/right/up/down callback'leri çalışıyor
 *   • Kategoriler arasında geçiş animasyonu iyileştirildi
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '@/theme';
import type { ThemeColors } from '@/theme';

// ─── Token tanımları ──────────────────────────────────────────────────────────

interface KeyToken {
  label:   string;
  value:   string;
  wide?:   boolean;
  action?: 'cursor-left' | 'cursor-right' | 'cursor-up' | 'cursor-down';
}

const CATEGORIES: { id: string; label: string; keys: KeyToken[] }[] = [
  {
    id: 'basic',
    label: 'Temel',
    keys: [
      { label: '⇥',  value: '\t',  wide: true },
      { label: '{',   value: '{' },
      { label: '}',   value: '}' },
      { label: '[',   value: '[' },
      { label: ']',   value: ']' },
      { label: '(',   value: '(' },
      { label: ')',   value: ')' },
      { label: ';',   value: ';' },
      { label: ':',   value: ':' },
      { label: "'",   value: "'" },
      { label: '"',   value: '"' },
      { label: '`',   value: '`' },
      { label: '\\',  value: '\\' },
      { label: '/',   value: '/' },
      { label: '_',   value: '_' },
      { label: '.',   value: '.' },
    ],
  },
  {
    id: 'operator',
    label: 'Op',
    keys: [
      { label: '=',   value: ' = ' },
      { label: '===', value: ' === ' },
      { label: '!==', value: ' !== ' },
      { label: '+',   value: ' + ' },
      { label: '-',   value: ' - ' },
      { label: '*',   value: ' * ' },
      { label: '%',   value: ' % ' },
      { label: '!',   value: '!' },
      { label: '&&',  value: ' && ' },
      { label: '||',  value: ' || ' },
      { label: '??',  value: ' ?? ' },
      { label: '=>',  value: ' => ' },
      { label: '<',   value: ' < ' },
      { label: '>',   value: ' > ' },
      { label: '>=',  value: ' >= ' },
      { label: '<=',  value: ' <= ' },
    ],
  },
  {
    id: 'nav',
    label: 'Gezinme',
    keys: [
      { label: '◀',   value: '', action: 'cursor-left',  wide: true },
      { label: '▶',   value: '', action: 'cursor-right', wide: true },
      { label: '▲',   value: '', action: 'cursor-up',    wide: true },
      { label: '▼',   value: '', action: 'cursor-down',  wide: true },
    ],
  },
  {
    id: 'snippet',
    label: 'Snippet',
    keys: [
      { label: 'fn',      value: 'function ',           wide: true },
      { label: 'const',   value: 'const ',              wide: true },
      { label: 'let',     value: 'let ',                wide: true },
      { label: 'var',     value: 'var ',                wide: true },
      { label: 'async',   value: 'async ',              wide: true },
      { label: 'await',   value: 'await ',              wide: true },
      { label: 'return',  value: 'return ',             wide: true },
      { label: 'if',      value: 'if () {\n  \n}',      wide: true },
      { label: 'for',     value: 'for (let i = 0; i < ; i++) {\n  \n}', wide: true },
      { label: '()=>{}',  value: '() => {\n  \n}',      wide: true },
      { label: 'log',     value: 'console.log()',        wide: true },
      { label: 'import',  value: 'import  from ""',      wide: true },
      { label: 'export',  value: 'export ',              wide: true },
      { label: 'class',   value: 'class  {\n  \n}',      wide: true },
    ],
  },
];

// ─── Stil fabrikası ───────────────────────────────────────────────────────────

function makeStyles(C: ThemeColors) {
  return {
    container:      { backgroundColor: C.surface, borderTopWidth: 1, borderTopColor: C.border },
    catRow:         { flexDirection: 'row' as const, backgroundColor: C.bg, borderBottomWidth: 1, borderBottomColor: C.border, paddingHorizontal: 8, gap: 2 },
    catBtn:         { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 4, marginVertical: 3 },
    catBtnActive:   { backgroundColor: C.accentMuted },
    catLabel:       { fontSize: 10, color: C.muted, fontFamily: MONO },
    catLabelActive: { color: C.accent, fontWeight: '600' as const },
    keysScroll:     { maxHeight: 46 },
    keysContent:    { paddingHorizontal: 8, paddingVertical: 6, gap: 5, alignItems: 'center' as const },
    key:            {
      height: 34, minWidth: 34, paddingHorizontal: 10,
      backgroundColor: C.surface2,
      borderWidth: 1, borderColor: C.border,
      borderRadius: 6,
      alignItems: 'center' as const, justifyContent: 'center' as const,
      ...Platform.select({
        ios:     { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.3, shadowRadius: 1 },
        android: { elevation: 2 },
      }),
    },
    keyWide:        { minWidth: 58 },
    keyNav:         { backgroundColor: C.accentMuted, borderColor: `${C.accent}40` },
    keyPressed:     { backgroundColor: C.bg, borderColor: C.accent },
    keyLabel:       { fontSize: 13, color: C.textSecondary, fontFamily: MONO },
    keyNavLabel:    { color: C.accent, fontWeight: '600' as const },
  };
}

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface MobileKeyboardProps {
  onToken:   (value: string) => void;
  onAction?: (action: NonNullable<KeyToken['action']>) => void;
}

// ─── KeyButton ────────────────────────────────────────────────────────────────

function KeyButton({
  token, onPress, S,
}: {
  token:   KeyToken;
  onPress: (key: KeyToken) => void;
  S:       ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      onPress={() => onPress(token)}
      style={({ pressed }) => [
        S.key,
        token.wide   && S.keyWide,
        token.action && S.keyNav,
        pressed      && S.keyPressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={token.label}
      hitSlop={4}
    >
      <Text style={[S.keyLabel, token.action && S.keyNavLabel]}>
        {token.label}
      </Text>
    </Pressable>
  );
}

// ─── MobileKeyboard ───────────────────────────────────────────────────────────

export function MobileKeyboard({ onToken, onAction }: MobileKeyboardProps): React.ReactElement {
  const { colors }   = useTheme();
  const S            = useMemo(() => makeStyles(colors), [colors]);
  const [activeCat, setActiveCat] = useState('basic');

  const category = CATEGORIES.find(c => c.id === activeCat) ?? CATEGORIES[0]!;

  const handleKey = useCallback((key: KeyToken) => {
    if (key.action) {
      onAction?.(key.action);
    } else if (key.value) {
      onToken(key.value);
    }
  }, [onToken, onAction]);

  return (
    <View style={S.container}>
      {/* Kategori seçici */}
      <View style={S.catRow}>
        {CATEGORIES.map(cat => (
          <Pressable
            key={cat.id}
            onPress={() => setActiveCat(cat.id)}
            style={[S.catBtn, activeCat === cat.id && S.catBtnActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeCat === cat.id }}
          >
            <Text style={[S.catLabel, activeCat === cat.id && S.catLabelActive]}>
              {cat.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Tuş sırası */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        bounces={false}
        contentContainerStyle={S.keysContent}
        style={S.keysScroll}
        keyboardShouldPersistTaps="always"
      >
        {category.keys.map((key, i) => (
          <KeyButton key={i} token={key} onPress={handleKey} S={S} />
        ))}
      </ScrollView>
    </View>
  );
}
