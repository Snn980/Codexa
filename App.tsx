/**
 * @file     App.tsx
 * @module   app
 * @version  1.0.0
 * @since    Phase 1 — App Shell
 *
 * @description
 *   Uygulama kök bileşeni.
 *
 *   Sorumluluklar:
 *     1. AppContainer.initialize() — uygulama başlatma + hata ekranı
 *     2. AppContext              — servisleri React ağacına enjekte eder
 *     3. AppState listener       — background/inactive → otomatik kayıt tetikler
 *     4. AppNavigator            — hazır olduğunda render edilir
 *
 *   Yaşam döngüsü:
 *     mount → initialize() → "ready" | "error"
 *     background → eventBus.emit("app:background") — FileService debounce flush
 *     foreground → eventBus.emit("app:foreground")
 *     unmount    → getApp().dispose()
 *
 * @example — React Native entry (index.js)
 *   import { registerRootComponent } from "expo";
 *   import App from "@/app/App";
 *   registerRootComponent(App);
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  AppState,
  AppStateStatus,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

import AsyncStorage  from '@react-native-async-storage/async-storage';

import { getApp }          from '@/index';
import { Database }        from '@/storage/Database';
import type { AppServices } from '@/index';
import { appContainer }    from '@/app/AppContainer';
import { RootNavigator }   from '@/navigations/RootNavigator';
import { sentryService }   from '@/monitoring/SentryService';

// ─────────────────────────────────────────────────────────────────────────────
// § 1. AppContext
// ─────────────────────────────────────────────────────────────────────────────

interface AppContextValue {
  readonly services: AppServices;
}

const AppContext = createContext<AppContextValue | null>(null);

/**
 * Servis kümesine React ağacından erişim sağlar.
 * AppContext dışında kullanılırsa throw fırlatır.
 *
 * @example
 *   const { services } = useAppContext();
 *   const { projectService, eventBus } = services;
 */
export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error(
      "[useAppContext] AppContext bulunamadı. Bileşen <App /> altında olmalı.",
    );
  }
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Başlatma durumları
// ─────────────────────────────────────────────────────────────────────────────

type BootState =
  | { phase: "booting" }
  | { phase: "ready";   services: AppServices }
  | { phase: "error";   message: string };

// ─────────────────────────────────────────────────────────────────────────────
// § 3. App — kök bileşen
// ─────────────────────────────────────────────────────────────────────────────

// RootNavigator doğrudan import edilir (§ 32 — NavigationErrorBoundary, safeNavigate, deep link)

export default function App(): React.ReactElement {
  const [boot, setBoot] = useState<BootState>({ phase: "booting" });
  const appStateRef     = useRef<AppStateStatus>(AppState.currentState);

  // ── Başlatma ───────────────────────────────────────────────────
  const initialize = useCallback(async () => {
    setBoot({ phase: "booting" });

    // 0. Sentry — mümkün olan en erken noktada (§ 32, T-P15-4)
    //    DSN yoksa no-op, uygulamayı bloklamaz.
    void sentryService.init();

    // 1. Base services (ProjectService, FileService, DB)
    const result = await getApp().initialize();
    if (!result.ok) {
      setBoot({ phase: "error", message: result.error.message });
      return;
    }

    // 2. AI container (KeyStore, ModelStorage, AIRuntime, AppStateManager)
    //    EventBus base services'den alınır — aynı bus her iki katmanı bağlar.
    try {
      await appContainer.init({
        eventBus:     getApp().services.eventBus,
        asyncStorage: AsyncStorage,
        // § 37.3 (T-P15-6): SQLite driver — migrate eder veya getDriver throws (henüz bağlı değilse)
        dbDriver:     (() => { try { return Database.getInstance().getDriver(); } catch { return undefined; } })(),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'AI container init failed';
      setBoot({ phase: "error", message });
      return;
    }

    setBoot({ phase: "ready", services: getApp().services });
  }, []);

  useEffect(() => {
    void initialize();

    return () => {
      // Unmount — kaynakları serbest bırak (önce AI, sonra base)
      appContainer.dispose();
      void getApp().dispose();
    };
  }, [initialize]);

  // ── AppState — arka plan / ön plan ─────────────────────────────
  useEffect(() => {
    if (boot.phase !== "ready") return;

    const { eventBus } = boot.services;

    const subscription = AppState.addEventListener(
      "change",
      (nextState: AppStateStatus) => {
        const prev = appStateRef.current;
        appStateRef.current = nextState;

        // Ön plana geçiş
        if (
          (prev === "background" || prev === "inactive") &&
          nextState === "active"
        ) {
          eventBus.emit("app:foreground" as never, {} as never);
        }

        // Arka plana geçiş — debounce'daki bekleyen kayıtları flush et
        if (
          prev === "active" &&
          (nextState === "background" || nextState === "inactive")
        ) {
          eventBus.emit("app:background" as never, {} as never);
        }
      },
    );

    return () => subscription.remove();
  }, [boot]);

  // ── Render ─────────────────────────────────────────────────────
  if (boot.phase === "booting") {
    return <BootScreen />;
  }

  if (boot.phase === "error") {
    return <ErrorScreen message={boot.message} onRetry={initialize} />;
  }

  const contextValue: AppContextValue = { services: boot.services };

  return (
    <AppContext.Provider value={contextValue}>
      {/* § 32 — NavigationErrorBoundary, safeNavigate, deep link (RootNavigator) */}
      <AppErrorBoundary onRetry={initialize}>
        <RootNavigator
          container={appContainer}
          onNavError={(error, info) => {
            // § 32: nav:error EventBus'a emit + Sentry (T-P15-4)
            appContainer.eventBus.emit('nav:error', { error: error.message });
            sentryService.captureNavError(error, info);
            if (__DEV__) console.error('[App] nav error:', error, info);
          }}
        />
      </AppErrorBoundary>
    </AppContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. AppErrorBoundary — lazy bileşen hatalarını yakalar
// ─────────────────────────────────────────────────────────────────────────────

// Fix #15: React.lazy + Suspense içindeki hatalar Suspense'te yakalanmaz.
// class ErrorBoundary zorunlu (React hook API ile hata sınırı tanımlanamaz).
// react-error-boundary paketi de kullanılabilir; bağımlılık eklemeden native impl.

interface ErrorBoundaryProps {
  children:  React.ReactNode;
  onRetry:   () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message:  string;
}

class AppErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message = error instanceof Error ? error.message : "Beklenmeyen hata";
    return { hasError: true, message };
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, message: "" });
    this.props.onRetry();
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <ErrorScreen
          message={this.state.message}
          onRetry={this.handleRetry}
        />
      );
    }
    return this.props.children;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. Yardımcı ekranlar
// ─────────────────────────────────────────────────────────────────────────────

function BootScreen(): React.ReactElement {
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={COLORS.accent} />
      <Text style={styles.bootText}>Başlatılıyor…</Text>
    </View>
  );
}

interface ErrorScreenProps {
  message: string;
  onRetry: () => void;
}

function ErrorScreen({ message, onRetry }: ErrorScreenProps): React.ReactElement {
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

// ─────────────────────────────────────────────────────────────────────────────
// § 6. Stiller
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = {
  bg:      "#0a0e1a",
  accent:  "#3b82f6",
  text:    "#f1f5f9",
  muted:   "#475569",
  error:   "#f87171",
  surface: "#1e293b",
} as const;

const styles = StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: COLORS.bg,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
  },
  bootText: {
    fontFamily:  "monospace",
    fontSize:    13,
    color:       COLORS.muted,
    letterSpacing: 0.5,
  },
  errorTitle: {
    fontFamily: "monospace",
    fontSize:   16,
    fontWeight: "700",
    color:      COLORS.error,
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
    marginTop:       16,
    paddingVertical: 10,
    paddingHorizontal: 24,
    backgroundColor: COLORS.accent,
    borderRadius:    8,
  },
  retryText: {
    fontFamily: "monospace",
    fontSize:   13,
    color:      COLORS.text,
    fontWeight: "600",
  },
});
