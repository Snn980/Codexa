/**
 * src/navigations/RootNavigator.tsx
 *
 * Tema güncellemesi:
 *   • TabBar renkleri useTheme() ile dinamik
 *   • StatusBar barStyle isDark'a göre otomatik
 *   • Tüm sabit hex değerleri kaldırıldı
 */

import React, { useCallback, useEffect, useRef } from 'react';

import { StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  createNavigationContainerRef,
  NavigationContainer,
  type LinkingOptions,
} from '@react-navigation/native';
import { createBottomTabNavigator }   from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import type { TabParamList, ChatStackParamList, EditorStackParamList } from './types';
import type { AppContainer } from '../di/AppContainer';
import { useAppContext } from '@/app/AppContext';
import { useTheme }      from '@/theme';
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
      TerminalTab: 'terminal',
      SettingsTab: 'settings',
    },
  },
};

// ─── Programmatic navigation ──────────────────────────────────────────────────

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
      <ChatStack.Screen name="AIChat">
        {(props) => <AIChatScreen {...props} />}
      </ChatStack.Screen>
      <ChatStack.Screen
        name="ModelDownload"
        options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
      >
        {(props) => <ModelDownloadScreen {...props} container={container!} />}
      </ChatStack.Screen>
    </ChatStack.Navigator>
  );
}

function EditorNavigator({ container }: { container: AppContainer }) {
  return (
    <EditorStack.Navigator screenOptions={{ headerShown: false }}>
      <EditorStack.Screen name="EditorMain">
        {(props) => <EditorMainScreen {...(props as any)} container={container!} />}
      </EditorStack.Screen>
      <EditorStack.Screen name="AIPanel">
        {(props) => <AIPanelScreen {...props} container={container!} />}
      </EditorStack.Screen>
    </EditorStack.Navigator>
  );
}

// ─── RootNavigator ────────────────────────────────────────────────────────────

interface RootNavigatorProps {
  container?:  AppContainer;
  onNavError?: (error: Error, info: React.ErrorInfo) => void;
}

export function RootNavigator({ container, onNavError }: RootNavigatorProps) {
  const navReadyRef        = useRef(false);
  const { top }            = useSafeAreaInsets();
  const { services }       = useAppContext();
  const { colors, isDark } = useTheme();

  // EventBus programatik navigasyon
  useEffect(() => {
    const eventBus = container?.eventBus ?? services.eventBus;
    const unsub = eventBus.on(
      'nav:navigate',
      (payload: { screen: string; params?: unknown }) => {
        safeNavigate(
          payload.screen as keyof TabParamList,
          payload.params as TabParamList[keyof TabParamList],
          (err) => { eventBus.emit('nav:error', { error: err.message }); },
        );
      },
    );
    return unsub;
  }, [container, services.eventBus]);

  const onReady = useCallback(() => { navReadyRef.current = true; }, []);

  return (
    <NavigationErrorBoundary onError={onNavError}>
      <StatusBar
        barStyle={isDark ? 'light-content' : 'dark-content'}
        backgroundColor="transparent"
        translucent
      />
      <NavigationContainer
        ref={navigationRef}
        onReady={onReady}
        linking={LINKING_CONFIG}
      >
        <React.Suspense fallback={<ScreenLoadingFallback />}>
          <Tab.Navigator
            screenOptions={{
              headerShown:             false,
              tabBarStyle:             {
                backgroundColor:  colors.tabBar.bg,
                borderTopColor:   colors.border,
                paddingTop:       4,
              },
              sceneContainerStyle:     { paddingTop: top },
              tabBarActiveTintColor:   colors.tabBar.active,
              tabBarInactiveTintColor: colors.tabBar.inactive,
            }}
          >
            <Tab.Screen name="ChatTab"    options={{ tabBarLabel: 'Chat' }}>
              {() => <ChatNavigator container={container!} />}
            </Tab.Screen>

            <Tab.Screen name="EditorTab"  options={{ tabBarLabel: 'Editor' }}>
              {() => <EditorNavigator container={container!} />}
            </Tab.Screen>

            <Tab.Screen name="ModelsTab"  options={{ tabBarLabel: 'Models' }}>
              {() => (
                <React.Suspense fallback={<ScreenLoadingFallback />}>
                  <ModelsScreen container={container!} />
                </React.Suspense>
              )}
            </Tab.Screen>

            <Tab.Screen name="TerminalTab" options={{ tabBarLabel: 'Terminal' }}>
              {() => (
                <React.Suspense fallback={<ScreenLoadingFallback />}>
                  <TerminalScreen container={container!} />
                </React.Suspense>
              )}
            </Tab.Screen>

            <Tab.Screen name="SettingsTab" options={{ tabBarLabel: 'Settings' }}>
              {() => (
                <React.Suspense fallback={<ScreenLoadingFallback />}>
                  <SettingsScreen container={container!} />
                </React.Suspense>
              )}
            </Tab.Screen>
          </Tab.Navigator>
        </React.Suspense>
      </NavigationContainer>
    </NavigationErrorBoundary>
  );
}
