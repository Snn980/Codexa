/**
 * @file     AppNavigator.tsx
 * @module   app/navigation
 * @version  1.0.0
 * @since    Phase 1 — App Shell
 *
 * @description
 *   React Navigation v7 — NavigationContainer + Bottom Tab + Stack yapısı.
 *
 *   Tab yapısı:
 *     Projects  — proje listesi + yeni proje
 *     Editor    — dosya editörü + sekmeler
 *     Terminal  — konsol çıktısı (Phase 2 placeholder)
 *     Settings  — ayarlar
 *
 *   EventBus entegrasyonu:
 *     "editor:tab:opened"  → Editor tab'ına navigate et
 *     "project:opened"     → Projects stack'ini sıfırla
 *
 *   Tasarım kararı:
 *     TabBar özel bileşen (TabBar.tsx) — varsayılan RN tab bar'ı gizlenir.
 *     Bu sayede IDE'ye özgü tab gösterimi (dirty flag, badge) mümkün olur.
 *
 * Bağımlılıklar:
 *   @react-navigation/native          ^7.x
 *   @react-navigation/bottom-tabs     ^7.x
 *   @react-navigation/native-stack    ^7.x
 *   react-native-screens              ^4.x   (native-stack için)
 *   react-native-safe-area-context    ^5.x
 */

import React, { useEffect, useRef } from "react";
import { NavigationContainer, useNavigationContainerRef } from "@react-navigation/native";
import { createBottomTabNavigator }  from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider }           from "react-native-safe-area-context";

import { useAppContext }     from "@/app/App";
import { TabBar }            from "@/app/navigations/TabBar";
import { ProjectsScreen }    from "@/app/screens/ProjectsScreen";
import { EditorScreen }      from "@/app/screens/EditorScreen";
import { TerminalScreen }    from "@/app/screens/TerminalScreen";
import { SettingsScreen }    from "@/app/screens/SettingsScreen";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Navigasyon tip tanımları
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Root Bottom Tab parametreleri.
 * Her tab kendi stack'ini yönetir.
 */
export type RootTabParamList = {
  Projects: undefined;
  Editor:   undefined;
  Terminal: undefined;
  Settings: undefined;
};

/**
 * Projects stack — liste
 * Fix #5: NewProject tip tanımından kaldırıldı — screen olarak kayıtlı değildi.
 * Modal yöntemi (setShowNew) kullanıldığı için navigate() çağrısı yok;
 * ileriye dönük navigate() eklenirse buraya Screen eklenmeli.
 */
export type ProjectsStackParamList = {
  ProjectList: undefined;
};

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Navigator örnekleri
// ─────────────────────────────────────────────────────────────────────────────

const Tab   = createBottomTabNavigator<RootTabParamList>();
const Stack = createNativeStackNavigator<ProjectsStackParamList>();

// ─────────────────────────────────────────────────────────────────────────────
// § 3. Projects Stack — iç navigator
// ─────────────────────────────────────────────────────────────────────────────

function ProjectsStack(): React.ReactElement {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown:     false,
        animation:       "slide_from_right",
        contentStyle:    { backgroundColor: COLORS.bg },
      }}
    >
      <Stack.Screen name="ProjectList" component={ProjectsScreen} />
    </Stack.Navigator>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Root Tab Navigator
// ─────────────────────────────────────────────────────────────────────────────

function RootTabs(): React.ReactElement {
  return (
    <Tab.Navigator
      tabBar={(_props) => <TabBar />}
      screenOptions={{
        headerShown: false,
        lazy:        true,   // Tab render edilene kadar mount etme
      }}
      initialRouteName="Projects"
    >
      <Tab.Screen name="Projects" component={ProjectsStack} />
      <Tab.Screen name="Editor"   component={EditorScreen} />
      <Tab.Screen name="Terminal" component={TerminalScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. AppNavigator — EventBus entegrasyonlu kök navigator
// ─────────────────────────────────────────────────────────────────────────────

export default function AppNavigator(): React.ReactElement {
  const { services }  = useAppContext();
  const navRef        = useNavigationContainerRef<RootTabParamList>();
  const navReadyRef   = useRef(false);

  // ── EventBus → Navigation bağlantısı ───────────────────────────
  useEffect(() => {
    const { eventBus } = services;

    // Dosya açıldığında → Editor tab'ına geç
    const unsubTabOpened = eventBus.on("editor:tab:opened", () => {
      if (navReadyRef.current) {
        navRef.navigate("Editor");
      }
    });

    // Proje açıldığında → Editor tab'ına geç (dosya hemen açılır)
    const unsubProjectOpened = eventBus.on("project:opened", () => {
      if (navReadyRef.current) {
        navRef.navigate("Editor");
      }
    });

    return () => {
      unsubTabOpened();
      unsubProjectOpened();
    };
  }, [services, navRef]);

  return (
    <SafeAreaProvider>
      <NavigationContainer
        ref={navRef}
        theme={NAV_THEME}
        onReady={() => { navReadyRef.current = true; }}
      >
        <RootTabs />
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 6. Tema
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = {
  bg:      "#0a0e1a",
  surface: "#111827",
  border:  "rgba(255,255,255,0.06)",
  text:    "#f1f5f9",
  muted:   "#475569",
} as const;

const NAV_THEME = {
  dark: true,
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' as const },
    medium:  { fontFamily: 'System', fontWeight: '500' as const },
    bold:    { fontFamily: 'System', fontWeight: '700' as const },
    heavy:   { fontFamily: 'System', fontWeight: '800' as const },
  },
  colors: {
    primary:      "#3b82f6",
    background:   COLORS.bg,
    card:         COLORS.surface,
    text:         COLORS.text,
    border:       COLORS.border,
    notification: "#f87171",
  },
} as const;
