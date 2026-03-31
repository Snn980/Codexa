/**
 * @file  app/screens/BootScreens.tsx
 *
 * Boot ve hata ekranları.
 * App.tsx'teki BootScreen + ErrorScreen buraya taşındı.
 */

import React from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

// ─── Renkler ─────────────────────────────────────────────────────────────────

const COLORS = {
  bg:      "#0a0e1a",
  accent:  "#3b82f6",
  text:    "#f1f5f9",
  muted:   "#475569",
  error:   "#f87171",
  surface: "#1e293b",
} as const;

// ─── BootScreen ──────────────────────────────────────────────────────────────

export function BootScreen(): React.ReactElement {
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={COLORS.accent} />
      <Text style={styles.bootText}>Başlatılıyor…</Text>
    </View>
  );
}

// ─── ErrorScreen ─────────────────────────────────────────────────────────────

interface ErrorScreenProps {
  message: string;
  onRetry: () => void;
}

export function ErrorScreen({ message, onRetry }: ErrorScreenProps): React.ReactElement {
  return (
    <View style={styles.center}>
      <Text style={styles.errorTitle}>Başlatma Hatası</Text>
      <Text style={styles.errorMessage}>{message}</Text>
      <TouchableOpacity style={styles.retryButton} onPress={onRetry}>
        <Text style={styles.retryText}>Tekrar Dene</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Stiller ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  center: {
    flex:            1,
    backgroundColor: COLORS.bg,
    alignItems:      "center",
    justifyContent:  "center",
    gap:             12,
    padding:         24,
  },
  bootText: {
    fontFamily:    "monospace",
    fontSize:      13,
    color:         COLORS.muted,
    letterSpacing: 0.5,
  },
  errorTitle: {
    fontFamily:   "monospace",
    fontSize:     16,
    fontWeight:   "700",
    color:        COLORS.error,
    marginBottom: 4,
  },
  errorMessage: {
    fontFamily: "monospace",
    fontSize:   12,
    color:      COLORS.muted,
    textAlign:  "center",
    lineHeight: 20,
  },
  retryButton: {
    marginTop:         16,
    paddingVertical:   10,
    paddingHorizontal: 24,
    backgroundColor:   COLORS.accent,
    borderRadius:      8,
  },
  retryText: {
    fontFamily: "monospace",
    fontSize:   13,
    color:      COLORS.text,
    fontWeight: "600",
  },
});
