/**
 * @file     StatusBar.tsx
 * @module   app/components
 * @version  1.0.0
 * @since    Phase 1 — App Shell
 *
 * @description
 *   IDE durum çubuğu — aktif dosya, dirty flag, dil, satır:sütun.
 *
 *   EventBus entegrasyonu:
 *     "editor:content:changed" → satır:sütun güncellenir
 *     "file:dirty"             → dirty göstergesi (● nokta)
 *     "file:saved"             → dirty temizlenir (checkmark geçici)
 *     "editor:tab:focused"     → aktif dosya adı güncellenir
 *     "editor:tab:closed"      → boş durum
 *
 *   Props:
 *     activeFile — EditorScreen'den geçirilir (null = boş)
 *
 *   Gösterge sırası (soldan sağa):
 *     [dirty/saved] [dosya adı]   ···   [dil] [satır:sütun] [encoding]
 */

import React, { useEffect, useState, useRef } from "react";
import {
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { useAppContext }  from "@/app/App";
import type { IFile, CursorPosition } from "@/index";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Props
// ─────────────────────────────────────────────────────────────────────────────

interface StatusBarProps {
  activeFile: IFile | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. StatusBar
// ─────────────────────────────────────────────────────────────────────────────

type SaveState = "clean" | "dirty" | "saved";

export function StatusBar({ activeFile }: StatusBarProps): React.ReactElement {
  const { services }  = useAppContext();
  const { eventBus }  = services;

  const [saveState, setSaveState]   = useState<SaveState>("clean");
  // Fix #19: her iki taraf da 1-indexed başlar (CM6 convention)
  const [cursor,    setCursor]      = useState<CursorPosition>({ line: 1, column: 1 });
  // Fix #2: timer ref'te tutulur — stale closure + setState-on-unmount önlenir
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── EventBus reaktif ────────────────────────────────────────────
  useEffect(() => {
    if (!activeFile) return;

    const u1 = eventBus.on("file:dirty", ({ fileId, isDirty }) => {
      if (fileId !== activeFile.id) return;
      setSaveState(isDirty ? "dirty" : "clean");
    });

    const u2 = eventBus.on("file:saved", ({ file }) => {
      if (file.id !== activeFile.id) return;
      setSaveState("saved");

      // Fix #2: ref — setState-on-unmounted-component riski yok
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaveState("clean"), 2_000);
    });

    const u3 = eventBus.on("editor:content:changed", ({ fileId, cursor: cur }) => {
      if (fileId !== activeFile.id) return;
      setCursor(cur);
    });

    const u4 = eventBus.on("editor:tab:focused", ({ fileId }) => {
      if (fileId !== activeFile.id) {
        setSaveState("clean");
        setCursor({ line: 1, column: 0 });
      }
    });

    return () => {
      u1(); u2(); u3(); u4();
      // Fix #2: ref her zaman güncel — stale closure yok
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventBus, activeFile?.id]);

  // ─────────────────────────────────────────────────────────────────
  return (
    <View style={styles.bar}>
      {/* Sol taraf */}
      <View style={styles.left}>
        {/* Dirty / saved göstergesi */}
        <DirtyIndicator state={saveState} />

        {/* Dosya adı */}
        <Text style={styles.filename} numberOfLines={1}>
          {activeFile ? activeFile.path : "—"}
        </Text>
      </View>

      {/* Sağ taraf */}
      <View style={styles.right}>
        {/* Dil */}
        {activeFile && (
          <Chip
            label={activeFile.type.toUpperCase()}
            color={LANG_COLORS[activeFile.type] ?? COLORS.muted}
          />
        )}

        {/* Satır : Sütun */}
        {activeFile && (
          <Text style={styles.cursor}>
            {cursor.line}:{cursor.column}
          </Text>
        )}

        {/* Encoding */}
        <Text style={styles.encoding}>UTF-8</Text>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. DirtyIndicator
// ─────────────────────────────────────────────────────────────────────────────

function DirtyIndicator({ state }: { state: SaveState }): React.ReactElement | null {
  if (state === "clean") return null;

  if (state === "saved") {
    return <Text style={styles.savedMark}>✓</Text>;
  }

  return <View style={styles.dirtyDot} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Chip
// ─────────────────────────────────────────────────────────────────────────────

function Chip({ label, color }: { label: string; color: string }): React.ReactElement {
  return (
    <View style={[styles.chip, { borderColor: color + "40" }]}>
      <Text style={[styles.chipText, { color }]}>{label}</Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. Sabitler + Stiller
// ─────────────────────────────────────────────────────────────────────────────

const LANG_COLORS: Record<string, string> = {
  javascript: "#facc15",
  typescript: "#3b82f6",
  jsx:        "#61dafb",
  tsx:        "#7c3aed",
  json:       "#fb923c",
  md:         "#94a3b8",
  css:        "#a78bfa",
  html:       "#f87171",
  txt:        "#64748b",
  unknown:    "#475569",
};

const COLORS = {
  bg:      "#060a14",
  border:  "rgba(255,255,255,0.05)",
  text:    "#475569",
  muted:   "#334155",
  dirty:   "#fbbf24",
  saved:   "#34d399",
  accent:  "#3b82f6",
} as const;

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

const styles = StyleSheet.create({
  bar: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 10,
    paddingVertical:   4,
    backgroundColor:   COLORS.bg,
    borderTopWidth:    1,
    borderTopColor:    COLORS.border,
    minHeight:         24,
  },
  left: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           6,
    flex:          1,
    minWidth:      0,
  },
  right: {
    flexDirection: "row",
    alignItems:    "center",
    gap:           8,
    flexShrink:    0,
  },

  dirtyDot: {
    width:           6,
    height:          6,
    borderRadius:    3,
    backgroundColor: COLORS.dirty,
    flexShrink:      0,
  },
  savedMark: {
    fontSize:  11,
    color:     COLORS.saved,
    fontFamily: MONO,
    flexShrink: 0,
  },

  filename: {
    fontSize:    10,
    color:       COLORS.text,
    fontFamily:  MONO,
    flex:        1,
  },

  chip: {
    paddingHorizontal: 6,
    paddingVertical:   1,
    borderRadius:      3,
    borderWidth:       1,
  },
  chipText: {
    fontSize:   9,
    fontFamily: MONO,
    fontWeight: "700",
  },

  cursor: {
    fontSize:   10,
    color:      COLORS.muted,
    fontFamily: MONO,
  },
  encoding: {
    fontSize:   9,
    color:      COLORS.muted,
    fontFamily: MONO,
    opacity:    0.5,
  },
});
