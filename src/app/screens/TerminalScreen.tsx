/**
 * @file     TerminalScreen.tsx
 * @module   app/screens
 * @version  2.0.0
 * @since    Phase 1 — App Shell
 *
 * @description
 *   Terminal / konsol ekranı — EventBus tabanlı runtime çıktısı.
 *
 *   NOT: Canonical implementasyon src/screens/TerminalScreen.tsx'te
 *   (RingBuffer + ConsoleStream + VirtualList). Bu bileşen AppNavigator
 *   (app/navigations) için kullanılan eski tab navigator yolunu destekler.
 *
 *   EventBus entegrasyonu:
 *     "runtime:started"   → çalışıyor göstergesi
 *     "runtime:finished"  → süre badge
 *     "runtime:error"     → kırmızı hata satırı
 *     "runtime:output"    → stdout/stderr satırı ekle
 *
 *   Mevcut özellikler:
 *     • EventBus runtime olayları
 *     • Çalıştır butonu (terminal:run EventBus event)
 *     • Temizle butonu
 *     • stdout / stderr / system satır renklendirme
 *     • 10K satır ring buffer (in-memory)
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppContext } from "@/app/App";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Konsol satırı tipi
// ─────────────────────────────────────────────────────────────────────────────

type LineStream = "stdout" | "stderr" | "system";

interface ConsoleLine {
  id:        number;
  text:      string;
  stream:    LineStream;
  timestamp: number;
}

const INITIAL_LINES: ConsoleLine[] = [
  { id: 0, text: "mobile-ai-ide terminal v0.1",                stream: "system", timestamp: Date.now() },
  { id: 1, text: "QuickJS sandbox hazır.",                      stream: "system", timestamp: Date.now() },
  { id: 2, text: "─".repeat(48),                               stream: "system", timestamp: Date.now() },
];

export function TerminalScreen(): React.ReactElement {
  const insets       = useSafeAreaInsets();
  const { services } = useAppContext();
  const { eventBus } = services;

  const [lines,     setLines]     = useState<ConsoleLine[]>(INITIAL_LINES);
  const [running,   setRunning]   = useState(false);
  const [duration,  setDuration]  = useState<number | null>(null);
  const listRef     = useRef<FlatList<ConsoleLine>>(null);
  // Fix #9: module-level _lineId → ref — hot reload'da ID çakışması olmaz
  const lineIdRef   = useRef(INITIAL_LINES.length);

  const makeLine = useCallback((text: string, stream: LineStream = "stdout"): ConsoleLine => ({
    id: lineIdRef.current++,
    text,
    stream,
    timestamp: Date.now(),
  }), []);

  // ── EventBus — Phase 2 runtime olayları ─────────────────────────
  useEffect(() => {
    const u1 = eventBus.on("runtime:started", () => {
      setRunning(true);
      setDuration(null);
      setLines(prev => [...prev, makeLine("▶ Çalıştırılıyor…", "system")]);
    });

    const u2 = eventBus.on("runtime:finished", ({ durationMs }) => {
      setRunning(false);
      setDuration(durationMs);
      setLines(prev => [
        ...prev,
        makeLine(`✓ Tamamlandı — ${durationMs}ms`, "system"),
      ]);
    });

    const u3 = eventBus.on("runtime:error", ({ error }) => {
      setRunning(false);
      setLines(prev => [...prev, makeLine(`✗ ${error.message}`, "stderr")]);
    });

    const u4 = eventBus.on("runtime:output", ({ line, stream }) => {
      setLines(prev => {
        // RingBuffer sınırı — 10K satır (Phase 2'de RingBuffer.ts yapacak)
        const next = [...prev, makeLine(line, stream)];
        return next.length > 10_000 ? next.slice(-10_000) : next;
      });
    });

    return () => { u1(); u2(); u3(); u4(); };
  }, [eventBus]);

  // Fix #16: onContentSizeChange ile scroll — setTimeout magic number güvensiz
  // (yavaş cihazlarda 50ms yetmeyebilir, FlatList event'i her zaman doğru zamanlar)

  // ── Temizle ────────────────────────────────────────────────────
  const handleClear = useCallback(() => {
    setLines([makeLine("─ Temizlendi ─", "system")]);
    setDuration(null);
  }, []);

  // ── Çalıştır ───────────────────────────────────────────────
  const handleRun = useCallback(() => {
    // terminal:run → src/screens/TerminalScreen.tsx useTerminalRuntime işler
    eventBus.emit("terminal:run" as never, {});
    setLines(prev => [...prev, makeLine("▶ Çalıştırılıyor…", "system")]);
  }, [eventBus, makeLine]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Toolbar */}
      <View style={styles.toolbar}>
        <Text style={styles.toolbarTitle}>Terminal</Text>

        <View style={styles.toolbarRight}>
          {/* Süre badge */}
          {duration !== null && (
            <View style={styles.durationBadge}>
              <Text style={styles.durationText}>{duration}ms</Text>
            </View>
          )}

          {/* Çalışıyor göstergesi */}
          {running && (
            <View style={styles.runningBadge}>
              <Text style={styles.runningText}>⚡ Çalışıyor</Text>
            </View>
          )}

          {/* Temizle */}
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={handleClear}
            accessibilityLabel="Terminali temizle"
          >
            <Text style={styles.iconBtnText}>⊘</Text>
          </TouchableOpacity>

          {/* Çalıştır */}
          <TouchableOpacity
            style={[styles.runBtn, running && styles.runBtnActive]}
            onPress={handleRun}
            disabled={running}
            accessibilityLabel="Kodu çalıştır"
          >
            <Text style={styles.runBtnText}>▶ Çalıştır</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Konsol çıktısı */}
      <FlatList
        ref={listRef}
        data={lines}
        keyExtractor={(l) => String(l.id)}
        renderItem={({ item }) => <ConsoleLineItem line={item} />}
        style={styles.output}
        contentContainerStyle={styles.outputContent}
        // Fix #16: onContentSizeChange — setTimeout(50ms) yerine güvenilir scroll
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        removeClippedSubviews
        maxToRenderPerBatch={50}
        windowSize={10}
      />

      {/* Alt bilgi */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>
          QuickJS · Sandbox · 128MB · 10s timeout
        </Text>
        <Text style={styles.footerPhase}>v1.0</Text>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. ConsoleLineItem
// ─────────────────────────────────────────────────────────────────────────────

function ConsoleLineItem({ line }: { line: ConsoleLine }): React.ReactElement {
  return (
    <View style={styles.lineRow}>
      {/* Stream prefix */}
      <Text style={[styles.linePrefix, LINE_COLORS[line.stream]]}>
        {STREAM_PREFIX[line.stream]}
      </Text>
      <Text
        style={[styles.lineText, LINE_COLORS[line.stream]]}
        selectable
      >
        {line.text}
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Sabitler
// ─────────────────────────────────────────────────────────────────────────────

const STREAM_PREFIX: Record<LineStream, string> = {
  stdout: "",
  stderr: "✗ ",
  system: "  ",
};

const LINE_COLORS: Record<LineStream, object> = {
  stdout: { color: "#e2e8f0" },
  stderr: { color: "#f87171" },
  system: { color: "#334155" },
};

// ─────────────────────────────────────────────────────────────────────────────
// § 5. Stiller
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = {
  bg:      "#0a0e1a",
  surface: "#0d1117",
  border:  "rgba(255,255,255,0.06)",
  accent:  "#3b82f6",
  green:   "#34d399",
  yellow:  "#fbbf24",
  muted:   "#334155",
} as const;

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

const styles = StyleSheet.create({
  container:      { flex: 1, backgroundColor: COLORS.bg },

  toolbar:        { flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                     paddingHorizontal: 12, paddingVertical: 8,
                     borderBottomWidth: 1, borderBottomColor: COLORS.border,
                     backgroundColor: COLORS.surface },
  toolbarTitle:   { fontSize: 12, fontWeight: "700", color: "#94a3b8", fontFamily: MONO },
  toolbarRight:   { flexDirection: "row", alignItems: "center", gap: 8 },

  durationBadge:  { paddingHorizontal: 8, paddingVertical: 3,
                     backgroundColor: "rgba(52,211,153,0.1)",
                     borderRadius: 4, borderWidth: 1, borderColor: "rgba(52,211,153,0.3)" },
  durationText:   { fontSize: 10, color: COLORS.green, fontFamily: MONO },

  runningBadge:   { paddingHorizontal: 8, paddingVertical: 3,
                     backgroundColor: "rgba(251,191,36,0.1)",
                     borderRadius: 4, borderWidth: 1, borderColor: "rgba(251,191,36,0.3)" },
  runningText:    { fontSize: 10, color: COLORS.yellow, fontFamily: MONO },

  iconBtn:        { padding: 6 },
  iconBtnText:    { fontSize: 14, color: COLORS.muted },

  runBtn:         { paddingHorizontal: 12, paddingVertical: 6,
                     backgroundColor: COLORS.accent, borderRadius: 6 },
  runBtnActive:   { opacity: 0.5 },
  runBtnText:     { fontSize: 11, color: "#fff", fontWeight: "600", fontFamily: MONO },

  output:         { flex: 1 },
  outputContent:  { padding: 10, paddingBottom: 4 },
  lineRow:        { flexDirection: "row", gap: 4, paddingVertical: 1 },
  linePrefix:     { fontSize: 12, fontFamily: MONO, lineHeight: 20, width: 16 },
  lineText:       { fontSize: 12, fontFamily: MONO, lineHeight: 20, flex: 1, flexWrap: "wrap" },

  footer:         { flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                     paddingHorizontal: 12, paddingVertical: 5,
                     borderTopWidth: 1, borderTopColor: COLORS.border },
  footerText:     { fontSize: 9, color: COLORS.muted, fontFamily: MONO },
  footerPhase:    { fontSize: 9, color: "rgba(99,102,241,0.4)", fontFamily: MONO },
});
