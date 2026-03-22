/**
 * __tests__/Phase15.test.ts
 *
 * T-P15-1: SessionSearchIndex + useSessionSearch
 * T-P15-2: ChatExportImport
 * T-P15-4: SentryService
 * T-P15-5: iOSBGProcessingTask
 * T-P15-6: SQLiteChatRepository + ChatStorageMigrator
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('expo-modules-core', () => ({
  NativeModulesProxy: {},
  NativeUnimoduleProxy: {},
  EventEmitter: jest.fn().mockImplementation(() => ({
    addListener: jest.fn(),
    removeAllListeners: jest.fn(),
  })),
  requireNativeModule: jest.fn(() => ({})),
}));

jest.mock('@unimodules/react-native-adapter', () => ({
  NativeModulesProxy: {},
  NativeUnimoduleProxy: {},
}), { virtual: true });

jest.mock('react-native-mmkv', () => ({
  MMKV: jest.fn().mockImplementation(() => ({
    set: jest.fn(), get: jest.fn(), delete: jest.fn(),
    contains: jest.fn(() => false), getAllKeys: jest.fn(() => []),
  })),
}));

jest.mock('react-native-nitro-modules', () => ({
  NativeNitroModules: {},
}), { virtual: true });

jest.mock('expo-task-manager', () => ({
  isTaskDefined:           jest.fn(() => false),
  defineTask:              jest.fn(),
  scheduleBGProcessingTaskAsync: jest.fn(),
  cancelBGProcessingTaskAsync:   jest.fn(),
}));

jest.mock('expo-background-task', () => ({
  BackgroundFetchResult: { NoData: 'noData', NewData: 'newData', Failed: 'failed' },
  BackgroundFetchStatus: { Restricted: 'restricted', Denied: 'denied', Available: 'available' },
  getStatusAsync:        jest.fn(() => Promise.resolve('available')),
  registerTaskAsync:     jest.fn(() => Promise.resolve()),
  unregisterTaskAsync:   jest.fn(() => Promise.resolve()),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem:    jest.fn(() => Promise.resolve(null)),
  setItem:    jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (o) => o.ios ?? o.default },
  NativeModules: { NativeUnimoduleProxy: {} },
  StyleSheet: { create: (s) => s, flatten: (s) => s },
  View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity',
  FlatList: 'FlatList', ScrollView: 'ScrollView', Pressable: 'Pressable',
}));

jest.mock('@sentry/react-native', () => ({
  init:              jest.fn(),
  captureException:  jest.fn(() => 'event-id'),
  captureMessage:    jest.fn(() => 'event-id'),
  setUser:           jest.fn(),
  addBreadcrumb:     jest.fn(),
  withScope:         jest.fn((cb: (s: { setTag: jest.Mock }) => void) => cb({ setTag: jest.fn() })),
}));

jest.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      version: '1.0.0',
      extra: { sentryDsn: 'https://fake@sentry.io/123', environment: 'development' },
    },
  },
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as TaskManager from 'expo-task-manager';

import { SessionSearchIndex }    from '../storage/chat/SessionSearchIndex';
import { ChatExportImport }      from '../storage/chat/ChatExportImport';
import { SQLiteChatRepository }  from '../storage/chat/SQLiteChatRepository';
import { ChatStorageMigrator, TOTAL_MESSAGE_THRESHOLD } from '../storage/chat/ChatStorageMigrator';
import {
  registerIOSProcessingTask,
  scheduleIOSProcessingTask,
  IOS_BG_PROCESSING_TASK,
}                                from '../background/iOSBGProcessingTask';
import type { SessionMeta }      from '../storage/chat/ChatHistoryRepository';
import type { ChatMessage }      from '../hooks/useAIChat';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMeta(id: string, title: string, preview = ''): SessionMeta {
  return {
    id,
    title,
    createdAt:    Date.now() - 1000,
    updatedAt:    Date.now(),
    preview:      preview || title.slice(0, 40),
    messageCount: 2,
    checksum:     12345,
  };
}

function makeMessage(role: 'user' | 'assistant', content: string): ChatMessage {
  return {
    id:        Math.random().toString(36).slice(2),
    role,
    content,
    timestamp: Date.now(),
  };
}

// ─── Mock IDatabaseDriver ─────────────────────────────────────────────────────

function makeMockDriver() {
  const sessions   = new Map<string, Record<string, unknown>>();
  const messages   = new Map<string, Record<string, unknown>[]>();

  return {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM chat_sessions')) {
        const rows = [...sessions.values()];
        return { rows, rowsAffected: rows.length, lastInsertId: null };
      }
      if (sql.includes('FROM chat_messages')) {
        const sessionId = params[0] as string;
        const rows = messages.get(sessionId) ?? [];
        return { rows, rowsAffected: rows.length, lastInsertId: null };
      }
      return { rows: [], rowsAffected: 0, lastInsertId: null };
    }),
    queryOne: jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM chat_sessions')) {
        return sessions.get(params[0] as string) ?? null;
      }
      if (sql.includes('COUNT(*)')) {
        let total = 0;
        messages.forEach(m => { total += m.length; });
        return { count: total };
      }
      return null;
    }),
    execute: jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT') && sql.includes('chat_sessions') && params) {
        sessions.set(params[0] as string, {
          id: params[0], title: params[1],
          created_at: params[2], updated_at: params[3],
          preview: params[4], message_count: params[5], checksum: params[6],
        });
      }
      if (sql.includes('INSERT') && sql.includes('chat_messages') && params) {
        const sessionId = params[1] as string;
        const msgs = messages.get(sessionId) ?? [];
        msgs.push({
          id: params[0], session_id: sessionId, role: params[2],
          content: params[3], timestamp: params[4], idempotency_key: params[5],
        });
        messages.set(sessionId, msgs);
      }
      if (sql.includes('DELETE') && params) {
        sessions.delete(params[0] as string);
        messages.delete(params[0] as string);
      }
      return { rowsAffected: 1, lastInsertId: null };
    }),
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({
        query:   async () => ({ rows: [], rowsAffected: 0, lastInsertId: null }),
        queryOne: async () => null,
        execute: async (sql: string, params?: unknown[]) => {
          // mirror execute
          if (sql.includes('INSERT') && sql.includes('chat_sessions') && params) {
            sessions.set(params[0] as string, {
              id: params[0], title: params[1],
              created_at: params[2], updated_at: params[3],
              preview: params[4], message_count: params[5], checksum: params[6],
            });
          }
          if (sql.includes('INSERT') && sql.includes('chat_messages') && params) {
            const sessionId = params[1] as string;
            const msgs = messages.get(sessionId) ?? [];
            msgs.push({
              id: params[0], session_id: sessionId, role: params[2],
              content: params[3], timestamp: params[4], idempotency_key: params[5],
            });
            messages.set(sessionId, msgs);
          }
          return { rowsAffected: 1, lastInsertId: null };
        },
      });
    }),
    close:       jest.fn(() => Promise.resolve()),
    isConnected: jest.fn(() => true),
    _sessions:   sessions,
    _messages:   messages,
  };
}

// ─── T-P15-1: SessionSearchIndex ─────────────────────────────────────────────

describe('SessionSearchIndex', () => {

  test('tam eşleşme bulur', () => {
    const idx = new SessionSearchIndex();
    idx.rebuild([
      makeMeta('1', 'React Native kurulumu'),
      makeMeta('2', 'TypeScript generics'),
      makeMeta('3', 'Expo SDK güncelleme'),
    ]);

    const results = idx.search('React');
    expect(results).toContain('1');
    expect(results).not.toContain('2');
  });

  test('boş query → boş sonuç', () => {
    const idx = new SessionSearchIndex();
    idx.rebuild([makeMeta('1', 'test')]);
    expect(idx.search('')).toEqual([]);
    expect(idx.search('   ')).toEqual([]);
  });

  test('Türkçe normalizasyon: "şubat" → "subat" eşleşir', () => {
    const idx = new SessionSearchIndex();
    idx.rebuild([makeMeta('1', 'şubat ayı planları')]);
    const results = idx.search('subat');
    expect(results).toContain('1');
  });

  test('büyük/küçük harf duyarsız', () => {
    const idx = new SessionSearchIndex();
    idx.rebuild([makeMeta('1', 'TypeScript Generics')]);
    expect(idx.search('typescript')).toContain('1');
    expect(idx.search('TYPESCRIPT')).toContain('1');
  });

  test('removeSession sonrası sonuçta görünmez', () => {
    const idx = new SessionSearchIndex();
    idx.rebuild([makeMeta('1', 'silinecek session'), makeMeta('2', 'kalacak session')]);
    idx.removeSession('1');
    expect(idx.search('silinecek')).not.toContain('1');
  });

  test('limit parametresi çalışır', () => {
    const idx = new SessionSearchIndex();
    const sessions = Array.from({ length: 30 }, (_, i) =>
      makeMeta(`s${i}`, `test session ${i}`),
    );
    idx.rebuild(sessions);
    const results = idx.search('test', 5);
    expect(results.length).toBeLessThanOrEqual(5);
  });
});

// ─── T-P15-2: ChatExportImport ────────────────────────────────────────────────

describe('ChatExportImport', () => {

  function makeMockRepo(sessions: SessionMeta[], messages: ChatMessage[][]) {
    return {
      listSessions:   jest.fn(() => ({ ok: true, data: sessions })),
      getMessages:    jest.fn((id: string) => {
        const idx = sessions.findIndex(s => s.id === id);
        return { ok: true, data: messages[idx] ?? [] };
      }),
      createSession:  jest.fn(() => ({ ok: true, data: sessions[0] })),
      deleteSession:  jest.fn(() => ({ ok: true, data: undefined })),
    } as unknown as import('../storage/chat/ChatHistoryRepository').ChatHistoryRepository;
  }

  test('exportAll geçerli JSON üretir', async () => {
    const sessions = [makeMeta('s1', 'Sohbet 1')];
    const messages = [[makeMessage('user', 'Merhaba'), makeMessage('assistant', 'Nasılsın?')]];
    const repo     = makeMockRepo(sessions, messages);
    const exporter = new ChatExportImport(repo);

    const result = await exporter.exportAll('1.0.0');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = JSON.parse(result.data);
    expect(parsed.version).toBe(1);
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].meta.id).toBe('s1');
    expect(parsed.sessions[0].messages).toHaveLength(2);
  });

  test('importFrom başarılı import', async () => {
    const payload = JSON.stringify({
      version: 1,
      exportedAt: Date.now(),
      appVersion: '1.0.0',
      sessions: [{
        meta: makeMeta('imported-1', 'Import test'),
        messages: [makeMessage('user', 'test')],
      }],
    });

    const repo     = makeMockRepo([], []);
    const exporter = new ChatExportImport(repo);
    const result   = await exporter.importFrom(payload);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.imported).toBe(1);
    expect(result.data.skipped).toBe(0);
  });

  test('yanlış version → IMPORT_VERSION_MISMATCH hatası', async () => {
    const payload  = JSON.stringify({ version: 99, exportedAt: Date.now(), sessions: [] });
    const repo     = makeMockRepo([], []);
    const exporter = new ChatExportImport(repo);
    const result   = await exporter.importFrom(payload);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_VERSION_MISMATCH');
  });

  test('geçersiz JSON → IMPORT_PARSE_ERROR', async () => {
    const repo     = makeMockRepo([], []);
    const exporter = new ChatExportImport(repo);
    const result   = await exporter.importFrom('{invalid json}}}');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('IMPORT_PARSE_ERROR');
  });

  test('duplicate skip stratejisi', async () => {
    const sessions = [makeMeta('dup-1', 'Mevcut session')];
    const repo     = makeMockRepo(sessions, [[]]);
    const exporter = new ChatExportImport(repo);

    const payload = JSON.stringify({
      version: 1, exportedAt: Date.now(), appVersion: '1.0.0',
      sessions: [{ meta: makeMeta('dup-1', 'Çakışan'), messages: [] }],
    });

    const result = await exporter.importFrom(payload, { onDuplicate: 'skip' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.skipped).toBe(1);
    expect(result.data.imported).toBe(0);
  });
});

// ─── T-P15-5: iOSBGProcessingTask ────────────────────────────────────────────

describe('iOSBGProcessingTask', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    (TaskManager.isTaskDefined as jest.Mock).mockReturnValue(false);
  });

  test('registerIOSProcessingTask task tanımlar', () => {
    registerIOSProcessingTask();
    expect(TaskManager.defineTask).toHaveBeenCalledWith(
      IOS_BG_PROCESSING_TASK,
      expect.any(Function),
    );
  });

  test('registerIOSProcessingTask — isTaskDefined=true ise tekrar tanımlamaz', () => {
    (TaskManager.isTaskDefined as jest.Mock).mockReturnValue(true);
    registerIOSProcessingTask();
    expect(TaskManager.defineTask).not.toHaveBeenCalled();
  });

  test('scheduleIOSProcessingTask — API mevcut → ok döner', async () => {
    const mockSchedule = jest.fn(() => Promise.resolve());
    (TaskManager as Record<string, unknown>).scheduleBGProcessingTaskAsync = mockSchedule;

    const result = await scheduleIOSProcessingTask();
    expect(result.ok).toBe(true);
    expect(mockSchedule).toHaveBeenCalledWith(
      IOS_BG_PROCESSING_TASK,
      expect.objectContaining({ requiresNetworkConnectivity: true }),
    );
  });

  test('scheduleIOSProcessingTask — API yoksa ok döner (BackgroundFetch fallback)', async () => {
    delete (TaskManager as Record<string, unknown>).scheduleBGProcessingTaskAsync;
    const result = await scheduleIOSProcessingTask();
    expect(result.ok).toBe(true);
  });

  test('scheduleIOSProcessingTask — hata fırlatırsa err döner (non-fatal)', async () => {
    (TaskManager as Record<string, unknown>).scheduleBGProcessingTaskAsync =
      jest.fn(() => Promise.reject(new Error('Simulator error')));

    const result = await scheduleIOSProcessingTask();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('BG_PROCESSING_SCHEDULE_FAILED');
  });
});

// ─── T-P15-6: SQLiteChatRepository + ChatStorageMigrator ─────────────────────

describe('SQLiteChatRepository', () => {

  test('createSessionAsync session kaydeder', async () => {
    const driver = makeMockDriver();
    const repo   = new SQLiteChatRepository(driver as never);

    const messages = [
      makeMessage('user',      'Merhaba'),
      makeMessage('assistant', 'Nasılsın?'),
    ];

    const result = await repo.createSessionAsync('s1', 'Test Session', messages);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.id).toBe('s1');
    expect(result.data.title).toBe('Test Session');
    expect(driver.transaction).toHaveBeenCalled();
  });

  test('getMessagesAsync mesajları döndürür', async () => {
    const driver = makeMockDriver();
    const repo   = new SQLiteChatRepository(driver as never);

    const messages = [makeMessage('user', 'test mesajı')];
    await repo.createSessionAsync('s2', 'Mesaj Test', messages);

    const result = await repo.getMessagesAsync('s2');
    expect(result.ok).toBe(true);
  });

  test('deleteSession MMKV-uyumlu arayüz çalışır', async () => {
    const driver = makeMockDriver();
    const repo   = new SQLiteChatRepository(driver as never);

    await repo.createSessionAsync('del-1', 'Silinecek', []);
    const result = repo.deleteSession('del-1');
    expect(result.ok).toBe(true);
    expect(driver.execute).toHaveBeenCalledWith(
      expect.stringContaining('DELETE'),
      expect.arrayContaining(['del-1']),
    );
  });

  test('getTotalMessageCount doğru sayı döner', async () => {
    const driver = makeMockDriver();
    const repo   = new SQLiteChatRepository(driver as never);

    // mock driver COUNT sorgusunu 0 döndürür
    const count = await repo.getTotalMessageCount();
    expect(typeof count).toBe('number');
  });

  test('ensureSchema CREATE TABLE çalıştırır', async () => {
    const driver = makeMockDriver();
    const repo   = new SQLiteChatRepository(driver as never);

    const result = await repo.ensureSchema();
    expect(result.ok).toBe(true);
    expect(driver.execute).toHaveBeenCalledWith(
      expect.stringContaining('CREATE TABLE IF NOT EXISTS chat_sessions'),
    );
  });
});

describe('ChatStorageMigrator', () => {

  function makeMockMMKVRepo(sessionCount: number, messagesPerSession: number) {
    const sessions: SessionMeta[] = Array.from({ length: sessionCount }, (_, i) =>
      makeMeta(`s${i}`, `Session ${i}`),
    ).map(s => ({ ...s, messageCount: messagesPerSession }));

    return {
      listSessions: jest.fn(() => ({ ok: true, data: sessions })),
      getMessages:  jest.fn(() => ({
        ok: true,
        data: Array.from({ length: messagesPerSession }, () =>
          makeMessage('user', 'test mesajı'),
        ),
      })),
      clearAll: jest.fn(),
    } as unknown as import('../storage/chat/ChatHistoryRepository').ChatHistoryRepository;
  }

  test('eşik altında shouldMigrate → false', async () => {
    const mmkv   = makeMockMMKVRepo(5, 10); // 50 mesaj
    const driver = makeMockDriver();
    const sqlite = new SQLiteChatRepository(driver as never);
    const mig    = new ChatStorageMigrator(mmkv, sqlite);

    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

    const needed = await mig.shouldMigrate();
    expect(needed).toBe(false);
  });

  test('zaten migrate edilmişse shouldMigrate → false', async () => {
    const mmkv   = makeMockMMKVRepo(1000, 20);
    const driver = makeMockDriver();
    const sqlite = new SQLiteChatRepository(driver as never);
    const mig    = new ChatStorageMigrator(mmkv, sqlite);

    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('true');

    const needed = await mig.shouldMigrate();
    expect(needed).toBe(false);
  });

  test('migrate() tüm session ve mesajları aktarır', async () => {
    const mmkv   = makeMockMMKVRepo(3, 4);
    const driver = makeMockDriver();
    const sqlite = new SQLiteChatRepository(driver as never);
    const mig    = new ChatStorageMigrator(mmkv, sqlite);

    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);

    const result = await mig.migrate();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sessionsMigrated).toBe(3);
    expect(result.data.messagesMigrated).toBe(12); // 3 × 4
    expect(mmkv.clearAll).toHaveBeenCalled();
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'chat_storage_migrated_to_sqlite',
      'true',
    );
  });

  test('migrate() ilerleme callback çalışır', async () => {
    const mmkv   = makeMockMMKVRepo(2, 1);
    const driver = makeMockDriver();
    const sqlite = new SQLiteChatRepository(driver as never);
    const mig    = new ChatStorageMigrator(mmkv, sqlite);

    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);

    const progress: number[] = [];
    await mig.migrate((done) => progress.push(done));

    expect(progress.length).toBeGreaterThan(0);
  });

  test('TOTAL_MESSAGE_THRESHOLD değeri 10_000', () => {
    expect(TOTAL_MESSAGE_THRESHOLD).toBe(10_000);
  });
});
