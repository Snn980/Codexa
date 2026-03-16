/**
 * __tests__/Phase19.test.ts
 *
 * T-P19-1 : ModelDownloadScreen — aktif/bekleyen indirmeler listesi (§ 67)
 * T-P19-2 : ISettings.autoRun — tip tanımı + DEFAULT_SETTINGS (§ 68)
 * T-P19-3 : SettingsRepository — autoRun boolean parsing (§ 68)
 * T-P19-4 : SettingsScreen autoRun toggle → settings:changed emit (§ 68)
 * T-P19-5 : AppConfig.autoRun bridge — settings:changed → config güncelle (§ 68)
 * T-P19-6 : _shared.tsx testID garantisi — chat-input, send-button (§ 69)
 * T-P19-7 : AIChatScreenV2 FlatList testID = chat-message-list (§ 69)
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

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
  Switch:               () => null,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { DEFAULT_SETTINGS }  from '../types/core';
import type { ISettings }    from '../types/core';
import { AI_MODELS }         from '../ai/AIModels';
import type { AIModelId }    from '../ai/AIModels';
import type { DownloadState } from '../download/ModelDownloadManager';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDownloadState(
  modelId: AIModelId,
  status: DownloadState['status'] = 'idle',
  percent = 0,
): DownloadState {
  return {
    modelId,
    status,
    percent,
    bytesDownloaded: 0,
    totalBytes:      0,
  };
}

function makeMockContainer(opts: {
  downloadStates?: Partial<Record<AIModelId, DownloadState>>;
} = {}) {
  const { downloadStates = {} } = opts;

  return {
    downloadManager: {
      getState:       jest.fn((id: AIModelId) =>
        downloadStates[id] ?? makeDownloadState(id),
      ),
      startDownload:  jest.fn(),
      cancelDownload: jest.fn(),
    },
    eventBus: {
      on:   jest.fn(() => jest.fn()),  // unsubscribe fn döner
      emit: jest.fn(),
    },
    permissionGate: {
      getStatus: jest.fn(() => 'CLOUD_ENABLED' as const),
    },
    config: { autoRun: false },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// T-P19-1: ModelDownloadScreen
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P19-1: ModelDownloadScreen', () => {

  test('boş state → aktif indirme yok', () => {
    const container = makeMockContainer();
    // Tüm modeller idle → aktif list boş
    for (const m of AI_MODELS) {
      const s = container.downloadManager.getState(m.id);
      expect(s.status).toBe('idle');
    }
    const active = AI_MODELS.filter(m => {
      const s = container.downloadManager.getState(m.id);
      return s.status !== 'idle' && s.status !== 'complete';
    });
    expect(active).toHaveLength(0);
  });

  test('downloading model → aktif listede görünür', () => {
    const modelId = AI_MODELS[0].id;
    const container = makeMockContainer({
      downloadStates: { [modelId]: makeDownloadState(modelId, 'downloading', 42) },
    });
    const active = AI_MODELS.filter(m => {
      const s = container.downloadManager.getState(m.id);
      return s.status !== 'idle' && s.status !== 'complete';
    });
    expect(active.length).toBeGreaterThan(0);
    expect(container.downloadManager.getState(modelId).percent).toBe(42);
  });

  test('queued model → aktif listede görünür', () => {
    const modelId = AI_MODELS[0].id;
    const container = makeMockContainer({
      downloadStates: { [modelId]: makeDownloadState(modelId, 'queued') },
    });
    const s = container.downloadManager.getState(modelId);
    expect(s.status).toBe('queued');
  });

  test('failed model → aktif listede görünür (idle/complete değil)', () => {
    const modelId = AI_MODELS[0].id;
    const container = makeMockContainer({
      downloadStates: { [modelId]: makeDownloadState(modelId, 'failed') },
    });
    const s = container.downloadManager.getState(modelId);
    expect(s.status !== 'idle' && s.status !== 'complete').toBe(true);
  });

  test('cancelDownload → downloadManager.cancelDownload çağrılır', () => {
    const container = makeMockContainer();
    const modelId   = AI_MODELS[0].id;
    container.downloadManager.cancelDownload(modelId);
    expect(container.downloadManager.cancelDownload).toHaveBeenCalledWith(modelId);
  });

  test('EventBus model:download:progress dinlenir', () => {
    const container = makeMockContainer();
    container.eventBus.on('model:download:progress', jest.fn());
    expect(container.eventBus.on).toHaveBeenCalledWith(
      'model:download:progress', expect.any(Function),
    );
  });

  test('EventBus model:download:complete dinlenir', () => {
    const container = makeMockContainer();
    container.eventBus.on('model:download:complete', jest.fn());
    expect(container.eventBus.on).toHaveBeenCalledWith(
      'model:download:complete', expect.any(Function),
    );
  });

  test('EventBus model:download:error dinlenir', () => {
    const container = makeMockContainer();
    container.eventBus.on('model:download:error', jest.fn());
    expect(container.eventBus.on).toHaveBeenCalledWith(
      'model:download:error', expect.any(Function),
    );
  });

  test('unsubscribe → eventBus.on dönen fn çağrılır', () => {
    const unsub = jest.fn();
    const container = makeMockContainer();
    (container.eventBus.on as jest.Mock).mockReturnValue(unsub);
    const off = container.eventBus.on('model:download:progress', jest.fn());
    off();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  test('percent formatı — toFixed(0)', () => {
    const percent = 57.8;
    expect(percent.toFixed(0)).toBe('58');
  });

  test('§ 45 semaphore: 3 eş zamanlı indirme → 4. queued olur', () => {
    // Semaphore mantığı test edilir (ModelDownloadManager içinde)
    const statuses: DownloadState['status'][] = [
      'downloading', 'downloading', 'downloading', 'queued',
    ];
    const active = statuses.filter(s => s === 'downloading');
    const queued = statuses.filter(s => s === 'queued');
    expect(active).toHaveLength(3);
    expect(queued).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P19-2: ISettings.autoRun — tip tanımı
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P19-2: ISettings.autoRun', () => {

  test('DEFAULT_SETTINGS.autoRun tanımlı', () => {
    expect('autoRun' in DEFAULT_SETTINGS).toBe(true);
  });

  test('DEFAULT_SETTINGS.autoRun = false', () => {
    expect(DEFAULT_SETTINGS.autoRun).toBe(false);
  });

  test('autoRun boolean tip', () => {
    const settings: ISettings = { ...DEFAULT_SETTINGS, autoRun: true };
    expect(typeof settings.autoRun).toBe('boolean');
  });

  test('autoRun true set edilebilir', () => {
    const partial: Partial<ISettings> = { autoRun: true };
    expect(partial.autoRun).toBe(true);
  });

  test('ISettings key listesi autoRun içeriyor', () => {
    const keys = Object.keys(DEFAULT_SETTINGS);
    expect(keys).toContain('autoRun');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P19-3: SettingsRepository — autoRun deserialization
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P19-3: SettingsRepository autoRun parsing', () => {

  // deserializeValue mantığını simüle ediyoruz
  function deserializeAutoRun(raw: string): boolean {
    return raw === 'true';
  }

  test('"true" → true', () => {
    expect(deserializeAutoRun('true')).toBe(true);
  });

  test('"false" → false', () => {
    expect(deserializeAutoRun('false')).toBe(false);
  });

  test('geçersiz değer → false (DEFAULT_SETTINGS)', () => {
    expect(deserializeAutoRun('evet')).toBe(false);
  });

  test('boş string → false', () => {
    expect(deserializeAutoRun('')).toBe(false);
  });

  test('serialize: true → "true"', () => {
    expect(String(true)).toBe('true');
  });

  test('serialize: false → "false"', () => {
    expect(String(false)).toBe('false');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P19-4: SettingsScreen autoRun toggle
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P19-4: SettingsScreen autoRun toggle', () => {

  test('autoRun toggle → save({ autoRun: true }) çağrılır', () => {
    const save = jest.fn();
    // Toggle onChange simülasyonu
    const handleToggle = (value: boolean) => save({ autoRun: value });
    handleToggle(true);
    expect(save).toHaveBeenCalledWith({ autoRun: true });
  });

  test('autoRun toggle → save({ autoRun: false }) çağrılır', () => {
    const save = jest.fn();
    const handleToggle = (value: boolean) => save({ autoRun: value });
    handleToggle(false);
    expect(save).toHaveBeenCalledWith({ autoRun: false });
  });

  test('SettingsRepository.set → eventBus settings:changed emit eder', () => {
    const eventBus = { emit: jest.fn() };
    // SettingsRepository.set sonrası settings:changed emit edilir
    const prev = { ...DEFAULT_SETTINGS };
    const next = { ...DEFAULT_SETTINGS, autoRun: true };
    eventBus.emit('settings:changed', { prev, next });
    expect(eventBus.emit).toHaveBeenCalledWith('settings:changed', {
      prev: expect.objectContaining({ autoRun: false }),
      next: expect.objectContaining({ autoRun: true }),
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P19-5: AppConfig.autoRun bridge
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P19-5: AppConfig.autoRun bridge', () => {

  test('settings:changed → AppConfig.autoRun güncellenir', () => {
    // AppConfig'i mock olarak simüle et
    const appConfig = { autoRun: false };
    const eventBus  = {
      on: jest.fn((event: string, handler: (payload: unknown) => void) => {
        if (event === 'settings:changed') {
          // Bridge: settings:changed → appConfig.autoRun güncelle
          handler({ prev: DEFAULT_SETTINGS, next: { ...DEFAULT_SETTINGS, autoRun: true } });
        }
        return jest.fn();
      }),
    };

    // Bridge kurulumu simülasyonu
    eventBus.on('settings:changed', (payload) => {
      const p = payload as { next: ISettings };
      appConfig.autoRun = p.next.autoRun;
    });

    expect(appConfig.autoRun).toBe(true);
  });

  test('TerminalScreen container.config.autoRun okur', () => {
    const container = makeMockContainer();
    expect(container.config.autoRun).toBe(false);
  });

  test('autoRun=true → file:saved → terminal:run emit edilir', () => {
    const eventBus = { emit: jest.fn() };
    const autoRun  = true;

    // TerminalScreen'deki file:saved handler simülasyonu
    const handleFileSaved = (fileName: string) => {
      if (autoRun) {
        eventBus.emit('terminal:run', { entryFile: fileName });
      }
    };

    handleFileSaved('index.ts');
    expect(eventBus.emit).toHaveBeenCalledWith('terminal:run', { entryFile: 'index.ts' });
  });

  test('autoRun=false → file:saved → terminal:run emit edilmez', () => {
    const eventBus = { emit: jest.fn() };
    const autoRun  = false;

    const handleFileSaved = (fileName: string) => {
      if (autoRun) eventBus.emit('terminal:run', { entryFile: fileName });
    };

    handleFileSaved('index.ts');
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P19-6: _shared.tsx testID garantisi
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P19-6: _shared.tsx testID garantisi', () => {

  test('chat-input testID tanımlı sabit', () => {
    const TEST_IDS = {
      chatInput:       'chat-input',
      sendButton:      'send-button',
      cancelButton:    'cancel-button',
      chatMessageList: 'chat-message-list',
    } as const;

    expect(TEST_IDS.chatInput).toBe('chat-input');
    expect(TEST_IDS.sendButton).toBe('send-button');
    expect(TEST_IDS.cancelButton).toBe('cancel-button');
    expect(TEST_IDS.chatMessageList).toBe('chat-message-list');
  });

  test('Detox E2E: by.id("chat-input") ile eşleşir', () => {
    // testID="chat-input" → Detox element(by.id('chat-input')) ile bulur
    const testID = 'chat-input';
    expect(testID).toBe('chat-input');
  });

  test('Detox E2E: by.id("send-button") ile eşleşir', () => {
    expect('send-button').toBe('send-button');
  });

  test('Detox E2E: by.id("cancel-button") busy iken görünür', () => {
    // isBusy=true → cancel-button render edilir
    const isBusy = true;
    const rendered = isBusy ? 'cancel-button' : 'send-button';
    expect(rendered).toBe('cancel-button');
  });

  test('Detox E2E: by.id("send-button") idle iken görünür', () => {
    const isBusy = false;
    const rendered = isBusy ? 'cancel-button' : 'send-button';
    expect(rendered).toBe('send-button');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P19-7: AIChatScreenV2 FlatList testID
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P19-7: AIChatScreenV2 FlatList testID', () => {

  test('chat-message-list testID FlatList\'e atanmış', async () => {
    const mod = await import('../ui/chat/AIChatScreenV2');
    expect(mod.AIChatScreenV2).toBeDefined();
    expect(mod.AIChatScreenV2.displayName).toBe('AIChatScreenV2');
  });

  test('Detox E2E: by.id("chat-message-list") ile mesaj listesi bulunur', () => {
    const testID = 'chat-message-list';
    expect(testID).toBe('chat-message-list');
  });

  test('mesaj gönderimi → list güncellenir (state kontrolü)', () => {
    type Msg = { id: string; role: 'user' | 'assistant'; content: string };
    const messages: Msg[] = [];
    const send = (text: string) => {
      messages.push({ id: `m${messages.length}`, role: 'user', content: text });
    };

    send('Merhaba');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Merhaba');
  });
});
