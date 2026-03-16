/**
 * ui/completion/CodeCompletionOverlay.tsx — Inline completion önerileri
 *
 * § 8  : React.memo, useRef
 * Kullanım: Editor componentinin üzerinde absolute pozisyonlanır
 * Tab → ilk öneriyi kabul et
 * ↑/↓ → navigasyon (harici controlled)
 * Escape / devam yazma → dismiss
 */

import React, { memo, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from "react-native";

import type { CompletionSuggestion } from "../../hooks/useCodeCompletion";
import type { CompletionStatus } from "../../hooks/useCodeCompletion";

// ─── Tek öneri satırı ────────────────────────────────────────────────────────

interface SuggestionRowProps {
  suggestion: CompletionSuggestion;
  index: number;
  isFirst: boolean;
  onAccept: (s: CompletionSuggestion) => void;
}

const SuggestionRow = memo(({ suggestion, index, isFirst, onAccept }: SuggestionRowProps) => {
  const handlePress = useCallback(() => onAccept(suggestion), [suggestion, onAccept]);

  return (
    <TouchableOpacity
      style={[styles.suggestionRow, isFirst && styles.suggestionRowFirst]}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Öneri ${index + 1}: ${suggestion.text}`}
    >
      {/* Tab göstergesi (ilk öneri) */}
      {isFirst && (
        <View style={styles.tabBadge}>
          <Text style={styles.tabBadgeText}>Tab</Text>
        </View>
      )}

      {/* Kod metni */}
      <Text style={styles.suggestionText} numberOfLines={1}>
        {suggestion.text}
      </Text>

      {/* Kabul et oku */}
      <Text style={styles.acceptArrow}>→</Text>
    </TouchableOpacity>
  );
});
SuggestionRow.displayName = "SuggestionRow";

// ─── CodeCompletionOverlay ───────────────────────────────────────────────────

export interface CodeCompletionOverlayProps {
  suggestions: CompletionSuggestion[];
  status: CompletionStatus;
  isVisible: boolean;
  /** Absolute pozisyon — cursor'ın altı */
  top: number;
  left: number;
  maxWidth?: number;
  onAccept: (suggestion: CompletionSuggestion) => void;
  onDismiss: () => void;
}

export const CodeCompletionOverlay = memo(({
  suggestions,
  status,
  isVisible,
  top,
  left,
  maxWidth = 320,
  onAccept,
  onDismiss,
}: CodeCompletionOverlayProps) => {
  if (!isVisible) return null;
  if (status === "idle" || status === "error") return null;

  return (
    <View style={[styles.container, { top, left, maxWidth }]} pointerEvents="box-none">
      {/* Yükleniyor durumu */}
      {status === "loading" && (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="small" color="#7c7cff" />
          <Text style={styles.loadingText}>Tamamlanıyor…</Text>
        </View>
      )}

      {/* Öneri listesi */}
      {status === "ready" && suggestions.length > 0 && (
        <View style={styles.suggestionBox}>
          {/* Başlık + dismiss */}
          <View style={styles.header}>
            <Text style={styles.headerLabel}>AI Önerisi</Text>
            <TouchableOpacity
              onPress={onDismiss}
              style={styles.dismissBtn}
              accessibilityLabel="Öneriyi kapat"
            >
              <Text style={styles.dismissBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.scrollArea}
            bounces={false}
            keyboardShouldPersistTaps="handled"
          >
            {suggestions.map((s, i) => (
              <SuggestionRow
                key={s.id}
                suggestion={s}
                index={i}
                isFirst={i === 0}
                onAccept={onAccept}
              />
            ))}
          </ScrollView>

          {/* Alt bilgi */}
          <View style={styles.footer}>
            <Text style={styles.footerText}>Esc ile kapat</Text>
          </View>
        </View>
      )}
    </View>
  );
});
CodeCompletionOverlay.displayName = "CodeCompletionOverlay";

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    zIndex: 1000,
  },
  loadingBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1e1e2e",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "#313244",
    gap: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  loadingText: {
    color: "#7c7cff",
    fontSize: 12,
    fontFamily: "monospace",
  },
  suggestionBox: {
    backgroundColor: "#1e1e2e",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#313244",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 10,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#313244",
    backgroundColor: "#181825",
  },
  headerLabel: {
    color: "#7c7cff",
    fontSize: 10,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  dismissBtn: { padding: 2 },
  dismissBtnText: { color: "#45475a", fontSize: 12 },
  scrollArea: { maxHeight: 160 },
  suggestionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: "#181825",
    gap: 8,
  },
  suggestionRowFirst: {
    borderTopWidth: 0,
    backgroundColor: "#252535",
  },
  tabBadge: {
    backgroundColor: "#2a2a4a",
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#4f46e5",
  },
  tabBadgeText: {
    color: "#7c7cff",
    fontSize: 9,
    fontWeight: "700",
    fontFamily: "monospace",
  },
  suggestionText: {
    flex: 1,
    color: "#cdd6f4",
    fontSize: 13,
    fontFamily: "monospace",
  },
  acceptArrow: {
    color: "#45475a",
    fontSize: 12,
  },
  footer: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderTopWidth: 1,
    borderTopColor: "#181825",
    backgroundColor: "#181825",
  },
  footerText: {
    color: "#45475a",
    fontSize: 10,
    fontFamily: "monospace",
  },
});
