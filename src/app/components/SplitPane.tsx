/**
 * @file     SplitPane.tsx
 * @module   app/components
 * @version  1.0.0
 * @since    Phase 1 — App Shell
 *
 * @description
 *   Editör + Terminal bölünmüş görünüm bileşeni.
 *
 *   Özellikler:
 *     • Dikey bölünme — üst: editör, alt: terminal
 *     • Sürüklenebilir ayraç (PanResponder)
 *     • Çökürme / genişletme butonu
 *     • Minimum / maksimum yükseklik sınırları
 *     • Konum hafıza (mount sırasında son pozisyon)
 *
 *   Kullanım:
 *     EditorScreen tam ekran görünümünde kullanılır.
 *     Terminal Phase 2'de etkin olduğunda SplitPane otomatik açılır.
 *
 *   Phase 2 entegrasyonu:
 *     "runtime:started"  → terminal pane otomatik açılır
 *     "runtime:finished" → isteğe bağlı collapse (ayar ile kontrol edilir)
 *
 * @example
 *   <SplitPane
 *     top={<EditorPane />}
 *     bottom={<TerminalPane />}
 *     initialRatio={0.65}
 *   />
 */

import React, {
  useCallback,
  useRef,
  useState,
} from "react";
import {
  LayoutChangeEvent,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Props
// ─────────────────────────────────────────────────────────────────────────────

interface SplitPaneProps {
  /** Üst bölme içeriği (editör) */
  top:            React.ReactNode;
  /** Alt bölme içeriği (terminal) */
  bottom:         React.ReactNode;
  /** Başlangıç oranı — üst bölmenin yükseklik oranı (0.0–1.0) */
  initialRatio?:  number;
  /** Alt bölme minimum yükseklik (px) */
  minBottom?:     number;
  /** Alt bölme maksimum yükseklik (px) */
  maxBottom?:     number;
  /** Alt bölme başlangıçta kapalı mı? */
  bottomCollapsed?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Sabitler
// ─────────────────────────────────────────────────────────────────────────────

const DIVIDER_HEIGHT   = 28;   // px — dokunma alanı
const DEFAULT_RATIO    = 0.65; // üst bölme varsayılan oranı
const MIN_BOTTOM_PX    = 80;
const COLLAPSED_HEIGHT = DIVIDER_HEIGHT;

// ─────────────────────────────────────────────────────────────────────────────
// § 3. SplitPane
// ─────────────────────────────────────────────────────────────────────────────

export function SplitPane({
  top,
  bottom,
  initialRatio    = DEFAULT_RATIO,
  minBottom       = MIN_BOTTOM_PX,
  maxBottom,
  bottomCollapsed = false,
}: SplitPaneProps): React.ReactElement {
  const [totalHeight,  setTotalHeight]  = useState(0);
  const [ratio,        setRatio]        = useState(initialRatio);
  const [collapsed,    setCollapsed]    = useState(bottomCollapsed);
  const [isDragging,   setIsDragging]   = useState(false);

  const ratioRef        = useRef(ratio);
  const totalHeightRef  = useRef(totalHeight);
  // Fix #1: prop ref'leri — PanResponder stale closure'ı önler
  const minBottomRef    = useRef(minBottom);
  const maxBottomRef    = useRef(maxBottom);

  ratioRef.current       = ratio;
  totalHeightRef.current = totalHeight;
  minBottomRef.current   = minBottom;
  maxBottomRef.current   = maxBottom;

  // ── Layout ─────────────────────────────────────────────────────
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setTotalHeight(e.nativeEvent.layout.height);
  }, []);

  // ── PanResponder — divider sürükleme ───────────────────────────
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) =>
        Math.abs(gestureState.dy) > 2,

      onPanResponderGrant: () => {
        setIsDragging(true);
      },

      onPanResponderMove: (_, gestureState) => {
        const total = totalHeightRef.current;
        if (total === 0) return;

        const newTopHeight = total * ratioRef.current + gestureState.dy;
        const newBottomHeight = total - newTopHeight - DIVIDER_HEIGHT;

        // Fix #1: ref'ten oku — mount anındaki prop değil, güncel değer
        const minB = minBottomRef.current;
        const maxB = maxBottomRef.current ?? total * 0.8;

        if (newBottomHeight < minB || newBottomHeight > maxB) return;

        const newRatio = newTopHeight / total;
        setRatio(Math.min(Math.max(newRatio, 0.1), 0.9));
      },

      onPanResponderRelease: () => {
        setIsDragging(false);
      },
    }),
  ).current;

  // ── Yükseklik hesapla ──────────────────────────────────────────
  const topHeight = collapsed
    ? totalHeight - COLLAPSED_HEIGHT
    : totalHeight * ratio - DIVIDER_HEIGHT / 2;

  const bottomHeight = collapsed
    ? 0
    : totalHeight * (1 - ratio) - DIVIDER_HEIGHT / 2;

  // Fix #18: ilk layout frame'den önce görünmez container döndür
  // topHeight/bottomHeight negatif hesaplanmasını engeller
  if (totalHeight === 0) {
    return <View style={styles.container} onLayout={onLayout} />;
  }

  return (
    <View style={styles.container} onLayout={onLayout}>
      {/* Üst — editör */}
      <View style={[styles.pane, { height: Math.max(0, topHeight) }]}>
        {top}
      </View>

      {/* Ayraç */}
      <View
        style={[styles.divider, isDragging && styles.dividerActive]}
        {...(collapsed ? {} : panResponder.panHandlers)}
      >
        {/* Sürükleme tutamacı */}
        <View style={styles.handle} />

        {/* Sağ köşe butonları */}
        <View style={styles.dividerRight}>
          {/* Çökür / Genişlet */}
          <Pressable
            onPress={() => setCollapsed(v => !v)}
            style={styles.collapseBtn}
            accessibilityLabel={collapsed ? "Terminali aç" : "Terminali kapat"}
          >
            <Text style={styles.collapseBtnText}>
              {collapsed ? "▲ Terminal" : "▼"}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Alt — terminal */}
      {!collapsed && (
        <View style={[styles.pane, { height: Math.max(0, bottomHeight) }]}>
          {bottom}
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Stiller
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = {
  bg:           "#0a0e1a",
  divider:      "#0d1117",
  dividerHover: "#161b22",
  border:       "rgba(255,255,255,0.06)",
  handle:       "rgba(255,255,255,0.12)",
  text:         "#334155",
  accent:       "#3b82f6",
} as const;

const styles = StyleSheet.create({
  container: {
    flex:            1,
    backgroundColor: COLORS.bg,
  },
  pane: {
    overflow: "hidden",
  },
  divider: {
    height:          DIVIDER_HEIGHT,
    backgroundColor: COLORS.divider,
    borderTopWidth:  1,
    borderTopColor:  COLORS.border,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    flexDirection:   "row",
    alignItems:      "center",
    justifyContent:  "center",
    // Web-only cursor style; cast to any to avoid RN StyleSheet type mismatch on web platform
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cursor:          Platform.OS === "web" ? ("ns-resize" as any) : undefined,
  },
  dividerActive: {
    backgroundColor: COLORS.dividerHover,
  },
  handle: {
    width:           48,
    height:          4,
    borderRadius:    2,
    backgroundColor: COLORS.handle,
  },
  dividerRight: {
    position:  "absolute",
    right:     8,
    flexDirection: "row",
    alignItems:    "center",
    gap:       8,
  },
  collapseBtn: {
    paddingHorizontal: 10,
    paddingVertical:   4,
    borderRadius:      4,
    borderWidth:       1,
    borderColor:       COLORS.border,
  },
  collapseBtnText: {
    fontSize:   9,
    color:      COLORS.text,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
});
