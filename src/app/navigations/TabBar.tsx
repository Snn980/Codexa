/**
 * @file     TabBar.tsx
 * @module   app/navigation
 * @version  1.0.0
 * @since    Phase 1 — App Shell
 *
 * @description
 *   Özel alt navigasyon çubuğu.
 *
 *   Varsayılan React Navigation tab bar'ı yerine kullanılır.
 *   IDE'ye özgü göstergeler:
 *     • Editor tab'ı — kaç dosya dirty olduğunu badge ile gösterir
 *     • Terminal tab'ı — çalışan process badge'i (Phase 2)
 *     • Aktif tab — mavi alt çizgi vurgusu
 *
 *   EventBus entegrasyonu:
 *     "file:dirty" → dirty sayısını günceller → Editor badge
 *     "file:saved" → dirty sayısını azaltır
 *
 * @example — AppNavigator'dan kullanım
 *   <Tab.Navigator tabBar={(props) => <TabBar {...props} />}>
 */

import React, { useEffect, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";

import { useAppContext } from "@/app/App";
import type { RootTabParamList } from "@/app/navigation/AppNavigator";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Tab tanımları
// ─────────────────────────────────────────────────────────────────────────────

type TabName = keyof RootTabParamList;

interface TabDef {
  name:    TabName;
  label:   string;
  icon:    string;   // unicode / emoji — Phase 2'de vector icon ile değiştirilir
  iconActive: string;
}

const TABS: TabDef[] = [
  { name: "Projects", label: "Projeler",  icon: "⊞",  iconActive: "⊞" },
  { name: "Editor",   label: "Editör",    icon: "◈",  iconActive: "◈" },
  { name: "Terminal", label: "Terminal",  icon: "⌘",  iconActive: "⌘" },
  { name: "Settings", label: "Ayarlar",   icon: "⚙",  iconActive: "⚙" },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// § 2. TabBar bileşeni
// ─────────────────────────────────────────────────────────────────────────────

export function TabBar({ state, navigation }: BottomTabBarProps): React.ReactElement {
  const insets              = useSafeAreaInsets();
  const { services }        = useAppContext();
  // Fix #4: Set<fileId> — aynı dosya için tekrar eden event'lerde sayaç kaymaz
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());

  // ── EventBus → dirty badge ──────────────────────────────────────
  useEffect(() => {
    const { eventBus } = services;

    const unsubDirty = eventBus.on("file:dirty", ({ fileId, isDirty }) => {
      setDirtyFiles(prev => {
        const next = new Set(prev);
        isDirty ? next.add(fileId) : next.delete(fileId);
        return next;
      });
    });

    const unsubSaved = eventBus.on("file:saved", ({ file }) => {
      setDirtyFiles(prev => {
        const next = new Set(prev);
        next.delete(file.id);
        return next;
      });
    });

    return () => {
      unsubDirty();
      unsubSaved();
    };
  }, [services]);

  const paddingBottom = Math.max(insets.bottom, 8);

  return (
    <View style={[styles.container, { paddingBottom }]}>
      {/* Üst kenarlık — ince separator */}
      <View style={styles.topBorder} />

      <View style={styles.row}>
        {TABS.map((tab, index) => {
          const isFocused = state.index === index;
          const badge     = getBadge(tab.name, dirtyFiles.size);

          const onPress = (): void => {
            const event = navigation.emit({
              type:   "tabPress",
              target: state.routes[index]?.key ?? "",
              canPreventDefault: true,
            });

            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(tab.name);
            }
          };

          return (
            <Pressable
              key={tab.name}
              onPress={onPress}
              style={({ pressed }) => [
                styles.tabItem,
                pressed && styles.tabItemPressed,
              ]}
              accessibilityRole="tab"
              accessibilityState={{ selected: isFocused }}
              accessibilityLabel={tab.label}
            >
              {/* Aktif göstergesi — üst çizgi */}
              <View style={[
                styles.activeIndicator,
                isFocused && styles.activeIndicatorVisible,
              ]} />

              {/* İkon + badge kapsayıcısı */}
              <View style={styles.iconWrapper}>
                <Text style={[
                  styles.icon,
                  isFocused ? styles.iconActive : styles.iconInactive,
                ]}>
                  {isFocused ? tab.iconActive : tab.icon}
                </Text>

                {/* Dirty / process badge */}
                {badge > 0 && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>
                      {badge > 9 ? "9+" : String(badge)}
                    </Text>
                  </View>
                )}
              </View>

              {/* Etiket */}
              <Text style={[
                styles.label,
                isFocused ? styles.labelActive : styles.labelInactive,
              ]}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. Yardımcılar
// ─────────────────────────────────────────────────────────────────────────────

function getBadge(tabName: TabName, dirtyCount: number): number {
  switch (tabName) {
    case "Editor":   return dirtyCount;
    case "Terminal": return 0; // Phase 2: çalışan process sayısı
    default:         return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Stiller
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = {
  bg:          "#0d1117",
  border:      "rgba(255,255,255,0.06)",
  active:      "#3b82f6",
  inactive:    "#334155",
  labelActive: "#93c5fd",
  labelMuted:  "#334155",
  badge:       "#f87171",
  badgeText:   "#fff",
  pressed:     "rgba(255,255,255,0.04)",
} as const;

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.bg,
  },
  topBorder: {
    height:          1,
    backgroundColor: COLORS.border,
  },
  row: {
    flexDirection: "row",
    paddingTop:    4,
  },
  tabItem: {
    flex:           1,
    alignItems:     "center",
    justifyContent: "center",
    paddingVertical: 6,
    gap:            2,
  },
  tabItemPressed: {
    backgroundColor: COLORS.pressed,
  },
  activeIndicator: {
    position:        "absolute",
    top:             0,
    left:            "25%",   // DimensionValue — RN 0.43+ string destekler, tip hack gereksiz
    right:           "25%",
    height:          2,
    borderRadius:    1,
    backgroundColor: "transparent",
  },
  activeIndicatorVisible: {
    backgroundColor: COLORS.active,
  },
  iconWrapper: {
    position: "relative",
    width:    28,
    height:   24,
    alignItems:     "center",
    justifyContent: "center",
  },
  icon: {
    fontSize:   16,
    lineHeight: 20,
  },
  iconActive: {
    color: COLORS.active,
  },
  iconInactive: {
    color: COLORS.inactive,
  },
  badge: {
    position:        "absolute",
    top:             -4,
    right:           -6,
    minWidth:        14,
    height:          14,
    borderRadius:    7,
    backgroundColor: COLORS.badge,
    alignItems:      "center",
    justifyContent:  "center",
    paddingHorizontal: 2,
  },
  badgeText: {
    fontSize:   8,
    color:      COLORS.badgeText,
    fontWeight: "700",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  label: {
    fontSize:    9,
    fontFamily:  Platform.OS === "ios" ? "Menlo" : "monospace",
    letterSpacing: 0.3,
  },
  labelActive: {
    color: COLORS.labelActive,
  },
  labelInactive: {
    color: COLORS.labelMuted,
  },
});
