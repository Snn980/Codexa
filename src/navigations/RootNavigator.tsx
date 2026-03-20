// src/navigations/RootNavigator.tsx
//
// Çözülen sorunlar:
//   - Navigation error boundary yok → NavigationErrorBoundary sarılır
//   - Suspense fallback UI yok → ScreenLoadingFallback
//   - Deep link handler yok → linking config
//   - Programmatic navigation error logging yok → safeNavigate()
//   - Circular dependency → screen'ler AppContainer'ı import etmez; prop DI
//   - Navigation / DI container coupling → container prop, useRef
//
// Phase 17 değişiklikleri:
//   § 62 — TerminalScreen lazy import, TerminalTab screen + linking
//   § 64 — AIChatScreen useOrchestrator prop kaldırıldı (default true)

import React, { useCallback, useEffect, useRef } from 'react';
import {
  createNavigationContainerRef,
  NavigationContainer,
  type LinkingOptions,
} from '@react-navigation/native';
import { createBottomTabNavigator }   from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import type { TabParamList, ChatStackParamList, EditorStackParamList } from './types';
import type { AppContainer } from '../di/AppContainer';
import {
  NavigationErrorBoundary,
  ScreenLoadingFallback,
} from './NavigationErrorBoundary';

// ─── Lazy screen imports ──────────────────────────────────────────────────────

const AIChatScreen        = React.lazy(() =>
  import('../screens/AIChatScreen').then(m => ({ default: m.AIChatScreen })));
const ModelDownloadScreen = React.lazy(() =>
  import('../screens/ModelDownloadScreen').then(m => ({ default: m.ModelDownloadScreen })));
const EditorMainScreen    = React.lazy(() =>
  import('../screens/EditorMainScreen').then(m => ({ default: m.EditorMainScreen })));
const AIPanelScreen       = React.lazy(() =>
  import('../screens/AIPanelScreen').then(m => ({ default: m.AIPanelScreen })));
const ModelsScreen        = React.lazy(() =>
  import('../screens/ModelsScreen').then(m => ({ default: m.ModelsScreen })));
// § 62 — TerminalScreen lazy import
const TerminalScreen      = React.lazy(() =>
  import('../screens/TerminalScreen').then(m => ({ default: m.TerminalScreen })));
const SettingsScreen      = React.lazy(() =>
  import('../screens/SettingsScreen').then(m => ({ default: m.SettingsScreen })));

// ─── Navigators ───────────────────────────────────────────────────────────────

const Tab         = createBottomTabNavigator<TabParamList>();
const ChatStack   = createNativeStackNavigator<ChatStackParamList>();
const EditorStack = createNativeStackNavigator<EditorStackParamList>();

// ─── Global navigation ref ────────────────────────────────────────────────────

export const navigationRef = createNavigationContainerRef<TabParamList>();

// ─── Deep link config ─────────────────────────────────────────────────────────
// Scheme: aiide://
// Örnekler:
//   aiide://chat              → ChatTab / AIChat
//   aiide://chat/session-123  → ChatTab / AIChat { sessionId: "session-123" }
//   aiide://editor            → EditorTab / EditorMain
//   aiide://terminal          → TerminalTab  (§ 62)

const LINKING_CONFIG: LinkingOptions<TabParamList> = {
  prefixes: ['aiide://', 'https://aiide.app'],
  config: {
    screens: {
      ChatTab: {
        path:    'chat',
        screens: {
          AIChat:        { path: ':sessionId?' },
          ModelDownload: 'models/download',
        },
      },
      EditorTab: {
        path:    'editor',
        screens: {
          EditorMain: { path: ':fileUri?' },
          AIPanel:    'ai/:sessionId',
        },
      },
      ModelsTab:   'models',
      TerminalTab: 'terminal',   // § 62
      SettingsTab: 'settings',
    },
  },
};

// ─── Programmatic navigation — error logged ───────────────────────────────────

export function safeNavigate<T extends keyof TabParamList>(
  screen: T,
  params?: TabParamList[T],
  onError?: (err: Error) => void,
): void {
  if (!navigationRef.isReady()) {
    const e = new Error(`[Navigation] navigate("${String(screen)}") called before navigator ready`);
    onError?.(e);
    if (__DEV__) console.warn(e.message);
    return;
  }
  try {
    // @ts-expect-error — runtime params tipi güvenli
    navigationRef.navigate(screen, params);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    onError?.(e);
    if (__DEV__) console.error('[Navigation] navigate error:', e);
  }
}

// ─── Sub-stacks ───────────────────────────────────────────────────────────────

function ChatNavigator({ container }: { container: AppContainer }) {
  return (
    <ChatStack.Navigator screenOptions={{ headerShown: false }}>
      {/* § 64: useOrchestrator prop yok — default true (Phase 17) */}
      <ChatStack.Screen name="AIChat">
        {(props) => <AIChatScreen {...props} container={container} />}
      </ChatStack.Screen>
      <ChatStack.Screen
        name="ModelDownload"
        options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
      >
        {(props) => <ModelDownloadScreen {...props} container={container} />}
      </ChatStack.Screen>
    </ChatStack.Navigator>
  );
}

function EditorNavigator({ container }: { container: AppContainer }) {
  return (
    <EditorStack.Navigator screenOptions={{ headerShown: false }}>
      <EditorStack.Screen name="EditorMain">
        {(props) => <EditorMainScreen {...(props as any)} container={container} />}
      </EditorStack.Screen>
      <EditorStack.Screen name="AIPanel">
        {(props) => <AIPanelScreen {...props} container={container} />}
      </EditorStack.Screen>
    </EditorStack.Navigator>
  );
}

// ─── RootNavigator ────────────────────────────────────────────────────────────

interface RootNavigatorProps {
  container:   AppContainer;
  onNavError?: (error: Error, info: React.ErrorInfo) => void;
}

export function RootNavigator({ container, onNavError }: RootNavigatorProps) {
  const navReadyRef = useRef(false);

  // EventBus programatik navigasyon (§ 9 / § 26)
  useEffect(() => {
    const unsub = container.eventBus.on(
      'nav:navigate',
      (payload: { screen: string; params?: unknown }) => {
        safeNavigate(
          payload.screen,
          payload.params as TabParamList[typeof payload.screen],
          (err) => {
            container.eventBus.emit('nav:error', { error: err.message });
          },
        );
      },
    );
    return unsub;
  }, [container.eventBus]);

  const onReady = useCallback(() => {
    navReadyRef.current = true;
  }, []);

  return (
    <NavigationErrorBoundary onError={onNavError}>
      <NavigationContainer
        ref={navigationRef}
        onReady={onReady}
        linking={LINKING_CONFIG}
      >
        <React.Suspense fallback={<ScreenLoadingFallback />}>
          <Tab.Navigator
            screenOptions={{
              headerShown:             false,
              tabBarStyle:             { backgroundColor: '#0f0f0f', borderTopColor: '#1e1e1e' },
              tabBarActiveTintColor:   '#7c6af7',
              tabBarInactiveTintColor: '#666',
            }}
          >
            <Tab.Screen
              name="ChatTab"
              options={{ tabBarLabel: 'Chat' }}
            >
              {() => <ChatNavigator container={container} />}
            </Tab.Screen>

            <Tab.Screen
              name="EditorTab"
              options={{ tabBarLabel: 'Editor' }}
            >
              {() => <EditorNavigator container={container} />}
            </Tab.Screen>

            <Tab.Screen
              name="ModelsTab"
              options={{ tabBarLabel: 'Models' }}
            >
              {() => (
                <React.Suspense fallback={<ScreenLoadingFallback />}>
                  <ModelsScreen container={container} />
                </React.Suspense>
              )}
            </Tab.Screen>

            {/* § 62 — TerminalTab: ModelsTab ile SettingsTab arasına */}
            <Tab.Screen
              name="TerminalTab"
              options={{ tabBarLabel: 'Terminal' }}
            >
              {() => (
                <React.Suspense fallback={<ScreenLoadingFallback />}>
                  <TerminalScreen container={container} />
                </React.Suspense>
              )}
            </Tab.Screen>

            <Tab.Screen
              name="SettingsTab"
              options={{ tabBarLabel: 'Settings' }}
            >
              {() => (
                <React.Suspense fallback={<ScreenLoadingFallback />}>
                  <SettingsScreen container={container} />
                </React.Suspense>
              )}
            </Tab.Screen>
          </Tab.Navigator>
        </React.Suspense>
      </NavigationContainer>
    </NavigationErrorBoundary>
  );
}
