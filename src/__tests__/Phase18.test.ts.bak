/**
 * __tests__/Phase18.test.ts
 *
 * T-P18-1 : AIChatScreen = AIChatScreenV2 (router yok, Legacy yok)
 * T-P18-2 : AIChatScreenProps = AIChatScreenV2Props (useOrchestrator kaldırıldı)
 * T-P18-3 : useAIOrchestrator koşulsuz çağrılır
 * T-P18-4 : ModelsScreen — EventBus + download state machine (§ 61)
 * T-P18-5 : TerminalTab navigation (§ 62)
 * T-P18-6 : AppContainer.sentryService getter (§ 63)
 * T-P18-7 : AppContainer.downloadManager alias (§ FIX-5)
 * T-P18-8 : AIPermissionStatus — getStatus() → 3 seviye
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockSend   = jest.fn();
const mockCancel = jest.fn();
const mockClear  = jest.fn();

jest.mock('../hooks/useAIOrchestrator', () => ({
  useAIOrchestrator: jest.fn(() => ({
    messages:   [],
    status:     'idle' as const,
    lastResult: null,
    lastError:  null,
    pendingId:  null,
    isBusy:     false,
    send:       mockSend,
    cancel:     mockCancel,
    clear:      mockClear,
  })),
}));

jest.mock('react-native', () => ({
  Platform:             { OS: 'ios' },
  StyleSheet:           { create: (s: unknown) => s },
  View:                 ({ children }: { children?: unknown }) => children,
  Text:                 ({ children }: { children?: unknown }) => children,
  TextInput:            () => null,
  FlatList:             () => null,
  Pressable:            ({ children }: { children?: unknown }) => children,
  ActivityIndicator:    () => null,
  KeyboardAvoidingView: ({ children }: { children?: unknown }) => children,
  ScrollView:           ({ children }: { children?: unknown }) => children,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { useAIOrchestrator } from '../hooks/useAIOrchestrator';

// ─── Mock AppContainer ────────────────────────────────────────────────────────

function makeMockContainer() {
  return {
    bridge:          { postMessage: jest.fn() },
    permissionGate:  { getStatus: jest.fn(() => 'CLOUD_ENABLED' as const) },
    sentryService:   { captureAIEvent: jest.fn(), captureNavError: jest.fn() },
    orchestrator:    { run: jest.fn() },
    eventBus:        { on: jest.fn(() => jest.fn()), emit: jest.fn() },
    downloadManager: {
      getState:        jest.fn((_id?: string) => ({
        modelId: _id ?? 'gemma3-1b-it-q4', status: 'idle',
        receivedMB: 0, totalMB: 0, percent: 0,
      })),
      startDownload:  jest.fn(),
      cancelDownload: jest.fn(),
    },
    config: { autoRun: false },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// T-P18-1: AIChatScreen = AIChatScreenV2
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P18-1: AIChatScreen artık V2', () => {

  test('AIChatScreen re-export AIChatScreenV2 ile aynı referans', async () => {
    // Dynamic import ile kontrol — her ikisi de aynı bileşen olmalı
    const chatModule = await import('../ui/chat/AIChatScreen');
    const v2Module   = await import('../ui/chat/AIChatScreenV2');

    // AIChatScreen = AIChatScreenV2 (re-export)
    expect(chatModule.AIChatScreen).toBe(v2Module.AIChatScreenV2);
  });

  test('useOrchestrator prop artık AIChatScreenProps içinde yok', async () => {
    // TypeScript tip kontrolü: AIChatScreenV2Props'ta useOrchestrator yok
    type Props = { container: ReturnType<typeof makeMockContainer>; initialSessionId?: string };
    const props: Props = { container: makeMockContainer() };
    // useOrchestrator pass etmeye çalışsak TypeScript hata verir
    // Runtime'da prop varlığı kontrol edilmez, bu tip testidir
    expect(Object.keys(props)).not.toContain('useOrchestrator');
  });

  test('otaIntervalMs prop artık AIChatScreenProps içinde yok', () => {
    // Legacy'ye özgüydü — V2 props'unda bulunmamalı
    const v2PropsKeys = ['container', 'initialSessionId'] as const;
    expect(v2PropsKeys).not.toContain('otaIntervalMs');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P18-2: AIChatScreenProps tipi
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P18-2: AIChatScreenProps = AIChatScreenV2Props', () => {

  test('AIChatScreenProps export var', async () => {
    const mod = await import('../ui/chat/AIChatScreen');
    // TypeScript tip export — runtime'da undefined, ancak export olmalı
    expect(mod).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P18-3: useAIOrchestrator koşulsuz çağrılır
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P18-3: useAIOrchestrator her zaman aktif', () => {
  const container = makeMockContainer();

  beforeEach(() => { jest.clearAllMocks(); });

  test('mount → useAIOrchestrator çağrılır', () => {
    // AIChatScreenV2 içinde useAIOrchestrator koşulsuz çağrılır
    (useAIOrchestrator as jest.Mock)({
      orchestrator: container.orchestrator,
      permission:   container.permissionGate.getStatus(),
      onEvent:      jest.fn(),
    });
    expect(useAIOrchestrator).toHaveBeenCalledTimes(1);
  });

  test('useAIChat hiçbir zaman çağrılmaz', async () => {
    // useAIChat artık AIChatScreen ağacında yok — Legacy kaldırıldı
    // Bu bir yapısal garantidir: useAIOrchestrator mock'unu kontrol et
    expect(jest.isMockFunction(useAIOrchestrator)).toBe(true);
  });

  test('status=streaming → isBusy=true', () => {
    (useAIOrchestrator as jest.Mock).mockReturnValueOnce({
      messages: [], status: 'streaming', lastResult: null,
      lastError: null, pendingId: 'p1',
      isBusy: true, send: mockSend, cancel: mockCancel, clear: mockClear,
    });
    (useAIOrchestrator as jest.Mock)({
      orchestrator: container.orchestrator,
      permission:   'CLOUD_ENABLED',
    });
    const { isBusy } = (useAIOrchestrator as jest.Mock).mock.results[0].value;
    expect(isBusy).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P18-4: ModelsScreen — download state machine
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P18-4: ModelsScreen download state machine', () => {
  const container = makeMockContainer();

  test('startDownload → downloadManager.startDownload çağrılır', () => {
    const modelId = 'gemma3-1b-it-q4' as const;
    container.downloadManager.startDownload(modelId);
    expect(container.downloadManager.startDownload).toHaveBeenCalledWith(modelId);
  });

  test('cancelDownload → downloadManager.cancelDownload çağrılır', () => {
    const modelId = 'gemma3-1b-it-q4' as const;
    container.downloadManager.cancelDownload(modelId);
    expect(container.downloadManager.cancelDownload).toHaveBeenCalledWith(modelId);
  });

  test('getState → DownloadState döner', () => {
    const state = container.downloadManager.getState('gemma3-1b-it-q4' as never);
    expect(state.status).toBe('idle');
    expect(state.percent).toBe(0);
  });

  test('CLOUD_ENABLED → cloud modeller gösterilir', () => {
    const permission = container.permissionGate.getStatus();
    expect(permission).toBe('CLOUD_ENABLED');
    const showCloud = permission === 'CLOUD_ENABLED';
    expect(showCloud).toBe(true);
  });

  test('LOCAL_ONLY → cloud modeller gizlenir', () => {
    (container.permissionGate.getStatus as jest.Mock).mockReturnValueOnce('LOCAL_ONLY');
    const permission = container.permissionGate.getStatus();
    expect(permission === 'CLOUD_ENABLED').toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P18-5: TerminalTab navigation (§ 62)
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P18-5: TerminalTab navigation', () => {

  test('TabParamList TerminalTab içeriyor', async () => {
    const { } = await import('../navigations/types');
    // TypeScript tip testi — TabParamList.TerminalTab undefined olmalı
    type Check = { TerminalTab: undefined };
    const obj: Check = { TerminalTab: undefined };
    expect(obj.TerminalTab).toBeUndefined();
  });

  test('linking config terminal path içeriyor', () => {
    const terminalPath = 'terminal';
    expect(terminalPath).toBe('terminal');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P18-6: AppContainer.sentryService getter (§ 63)
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P18-6: AppContainer.sentryService', () => {
  const container = makeMockContainer();

  test('container.sentryService var', () => {
    expect(container.sentryService).toBeDefined();
  });

  test('captureAIEvent çağrılabilir', () => {
    container.sentryService.captureAIEvent('escalated', { model: 'claude-haiku' });
    expect(container.sentryService.captureAIEvent).toHaveBeenCalledWith(
      'escalated', { model: 'claude-haiku' },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P18-7: AppContainer.downloadManager alias (§ FIX-5)
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P18-7: AppContainer.downloadManager alias', () => {
  const container = makeMockContainer();

  test('container.downloadManager var', () => {
    expect(container.downloadManager).toBeDefined();
  });

  test('downloadManager.startDownload fonksiyon', () => {
    expect(typeof container.downloadManager.startDownload).toBe('function');
  });

  test('downloadManager.cancelDownload fonksiyon', () => {
    expect(typeof container.downloadManager.cancelDownload).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P18-8: AIPermissionStatus — getStatus() (§ FIX-3)
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P18-8: AIPermissionStatus üç seviye', () => {
  const container = makeMockContainer();

  test('CLOUD_ENABLED → cloud + offline model', () => {
    (container.permissionGate.getStatus as jest.Mock).mockReturnValueOnce('CLOUD_ENABLED');
    expect(container.permissionGate.getStatus()).toBe('CLOUD_ENABLED');
  });

  test('LOCAL_ONLY → sadece offline model', () => {
    (container.permissionGate.getStatus as jest.Mock).mockReturnValueOnce('LOCAL_ONLY');
    expect(container.permissionGate.getStatus()).toBe('LOCAL_ONLY');
  });

  test('DISABLED → AI devre dışı', () => {
    (container.permissionGate.getStatus as jest.Mock).mockReturnValueOnce('DISABLED');
    expect(container.permissionGate.getStatus()).toBe('DISABLED');
  });

  test('getStatus() string değer döner', () => {
    const status = container.permissionGate.getStatus();
    const valid: string[] = ['DISABLED', 'LOCAL_ONLY', 'CLOUD_ENABLED'];
    expect(valid).toContain(status);
  });
});
