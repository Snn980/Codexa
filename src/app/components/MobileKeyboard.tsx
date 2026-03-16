/**
 * @file     MobileKeyboard.tsx
 * @module   app/components
 * @version  1.0.0
 * @since    Phase 1 — App Shell
 *
 * @description
 *   Özel mobil kod klavyesi.
 *
 *   Mobil cihazlarda kod yazmayı kolaylaştırmak için sistem klavyesi üstüne
 *   ek tuş sırası (toolbar) sunar. Tuşlar kategorilere ayrılmıştır;
 *   kategori çubuğuyla hızla geçilebilir.
 *
 *   Tuş kategorileri:
 *     Temel    — tab, enter, { } [ ] ( ) ; : ' " ` \
 *     Operatör — = + - * / % ! & | ^ ~ < > ? ,
 *     Gezinme  — ← → ↑ ↓ (cursor hareketi — Phase 2'de CM6 komutuna bağlanır)
 *     Snippet  — () {} [] => function const let var async await
 *
 *   onToken:
 *     Üst bileşen (EditorScreen) token'ı alır, cursor pozisyonuna insert eder.
 *     Phase 2: CM6 editörüne direct command dispatch yapılacak.
 *
 *   Tasarım kararı — kontrollü yerleşim:
 *     Klavye inputAccessoryView (iOS) / KeyboardAvoidingView offset (Android) ile
 *     sistem klavyesi üstüne hizalanır.
 *     Platform farkı: iOS'ta `inputAccessoryViewID` kullanılabilir (gelecek).
 *
 * @example
 *   <MobileKeyboard onToken={(token) => insertAtCursor(token)} />
 */

import React, { useCallback, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Token tanımları
// ─────────────────────────────────────────────────────────────────────────────

interface KeyToken {
  label:   string;    // Ekranda görünen
  value:   string;    // Editor'a gönderilen
  wide?:   boolean;   // 1.5x genişlik
  action?: "cursor-left" | "cursor-right" | "cursor-up" | "cursor-down";
  // Fix #17: Phase 2 gelene kadar gezinme tuşları disabled — sessiz no-op yerine görsel ipucu
  disabled?: boolean;
}

const CATEGORIES: { id: string; label: string; keys: KeyToken[] }[] = [
  {
    id: "basic",
    label: "Temel",
    keys: [
      { label: "⇥",   value: "\t",   wide: true },
      { label: "{",    value: "{ " },
      { label: "}",    value: " }" },
      { label: "[",    value: "[" },
      { label: "]",    value: "]" },
      { label: "(",    value: "(" },
      { label: ")",    value: ")" },
      { label: ";",    value: ";" },
      { label: ":",    value: ":" },
      { label: "'",    value: "'" },
      { label: '"',    value: '"' },
      { label: "`",    value: "`" },
      { label: "\\",   value: "\\" },
      { label: "/",    value: "/" },
    ],
  },
  {
    id: "operator",
    label: "Op",
    keys: [
      { label: "=",    value: " = " },
      { label: "==",   value: " === " },
      { label: "!=",   value: " !== " },
      { label: "+",    value: " + " },
      { label: "-",    value: " - " },
      { label: "*",    value: " * " },
      { label: "%",    value: " % " },
      { label: "!",    value: "!" },
      { label: "&&",   value: " && " },
      { label: "||",   value: " || " },
      { label: "??",   value: " ?? " },
      { label: "=>",   value: " => " },
      { label: "<",    value: " < " },
      { label: ">",    value: " > " },
    ],
  },
  {
    id: "nav",
    label: "Gezinme",
    keys: [
      // Fix #17: disabled — Phase 2'de CM6 cursor command'a bağlanacak
      { label: "◀",  value: "", action: "cursor-left",  wide: true, disabled: true },
      { label: "▶",  value: "", action: "cursor-right", wide: true, disabled: true },
      { label: "▲",  value: "", action: "cursor-up",    wide: true, disabled: true },
      { label: "▼",  value: "", action: "cursor-down",  wide: true, disabled: true },
    ],
  },
  {
    id: "snippet",
    label: "Snippet",
    keys: [
      { label: "fn",       value: "function ",          wide: true },
      { label: "const",    value: "const ",             wide: true },
      { label: "let",      value: "let ",               wide: true },
      { label: "var",      value: "var ",               wide: true },
      { label: "async",    value: "async ",             wide: true },
      { label: "await",    value: "await ",             wide: true },
      { label: "return",   value: "return ",            wide: true },
      { label: "if ()",    value: "if () {\n  \n}",     wide: true },
      { label: "for ()",   value: "for (let i = 0; i < ; i++) {\n  \n}", wide: true },
      { label: "()=>{}",   value: "() => {\n  \n}",    wide: true },
      { label: "console",  value: "console.log()",      wide: true },
      { label: "import",   value: 'import  from ""',    wide: true },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Props
// ─────────────────────────────────────────────────────────────────────────────

interface MobileKeyboardProps {
  /** Token basıldığında çağrılır — EditorScreen cursor'a insert eder */
  onToken:  (value: string) => void;
  /** Gezinme tuşu basıldığında (Phase 2 — CM6 cursor command) */
  onAction?: (action: NonNullable<KeyToken["action"]>) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. MobileKeyboard
// ─────────────────────────────────────────────────────────────────────────────

export function MobileKeyboard({ onToken, onAction }: MobileKeyboardProps): React.ReactElement {
  const [activeCat, setActiveCat] = useState("basic");

  const category = CATEGORIES.find(c => c.id === activeCat) ?? CATEGORIES[0]!;

  const handleKey = useCallback((key: KeyToken) => {
    if (key.action) {
      onAction?.(key.action);
    } else if (key.value) {
      onToken(key.value);
    }
  }, [onToken, onAction]);

  return (
    <View style={styles.container}>
      {/* Kategori seçici */}
      <View style={styles.catRow}>
        {CATEGORIES.map(cat => (
          <Pressable
            key={cat.id}
            onPress={() => setActiveCat(cat.id)}
            style={[styles.catBtn, activeCat === cat.id && styles.catBtnActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeCat === cat.id }}
          >
            <Text style={[styles.catLabel, activeCat === cat.id && styles.catLabelActive]}>
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
        contentContainerStyle={styles.keysContent}
        style={styles.keysScroll}
        keyboardShouldPersistTaps="always"
      >
        {category.keys.map((key, i) => (
          <KeyButton key={i} token={key} onPress={handleKey} />
        ))}
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. KeyButton
// ─────────────────────────────────────────────────────────────────────────────

interface KeyButtonProps {
  token:   KeyToken;
  onPress: (key: KeyToken) => void;
}

function KeyButton({ token, onPress }: KeyButtonProps): React.ReactElement {
  return (
    <Pressable
      onPress={() => !token.disabled && onPress(token)}
      style={({ pressed }) => [
        styles.key,
        token.wide && styles.keyWide,
        token.action && styles.keyNav,
        token.disabled && styles.keyDisabled,
        pressed && !token.disabled && styles.keyPressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={token.disabled ? `${token.label} (Phase 2)` : token.label}
      accessibilityState={{ disabled: token.disabled }}
      hitSlop={4}
    >
      <Text style={[
        styles.keyLabel,
        token.action && styles.keyNavLabel,
        token.disabled && styles.keyDisabledLabel,
      ]}>
        {token.label}
      </Text>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. Stiller
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = {
  bg:        "#0d1117",
  catBg:     "#0a0e1a",
  border:    "rgba(255,255,255,0.06)",
  key:       "#161b22",
  keyBorder: "rgba(255,255,255,0.1)",
  keyNav:    "rgba(59,130,246,0.12)",
  pressed:   "#1e293b",
  accent:    "#3b82f6",
  text:      "#94a3b8",
  textActive:"#e2e8f0",
  catActive: "rgba(59,130,246,0.15)",
} as const;

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

const styles = StyleSheet.create({
  container:     { backgroundColor: COLORS.bg,
                    borderTopWidth: 1, borderTopColor: COLORS.border },

  catRow:        { flexDirection: "row", backgroundColor: COLORS.catBg,
                    borderBottomWidth: 1, borderBottomColor: COLORS.border,
                    paddingHorizontal: 8, gap: 2 },
  catBtn:        { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 4, marginVertical: 3 },
  catBtnActive:  { backgroundColor: COLORS.catActive },
  catLabel:      { fontSize: 10, color: COLORS.text, fontFamily: MONO },
  catLabelActive:{ color: COLORS.accent },

  keysScroll:    { maxHeight: 44 },
  keysContent:   { paddingHorizontal: 8, paddingVertical: 6, gap: 5, alignItems: "center" },

  key:           { height: 32, minWidth: 32, paddingHorizontal: 10,
                    backgroundColor: COLORS.key,
                    borderWidth: 1, borderColor: COLORS.keyBorder,
                    borderRadius: 6,
                    alignItems: "center", justifyContent: "center",
                    // Shadow — iOS key depth
                    ...Platform.select({
                      ios: {
                        shadowColor: "#000",
                        shadowOffset: { width: 0, height: 1 },
                        shadowOpacity: 0.4,
                        shadowRadius: 1,
                      },
                      android: { elevation: 2 },
                    }),
                  },
  keyWide:       { minWidth: 56 },
  keyNav:        { backgroundColor: COLORS.keyNav,
                    borderColor: "rgba(59,130,246,0.25)" },
  keyPressed:    { backgroundColor: COLORS.pressed },

  keyLabel:      { fontSize: 13, color: COLORS.text, fontFamily: MONO },
  keyNavLabel:   { color: COLORS.accent },
  keyDisabled:      { opacity: 0.35, borderColor: "rgba(255,255,255,0.05)" },
  keyDisabledLabel: { color: COLORS.text },
});
