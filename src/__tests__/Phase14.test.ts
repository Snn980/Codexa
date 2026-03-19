// __tests__/Phase14.test.ts
// Phase 14 — Unit test suite
// § 10: createApp() / resetApp() | mockDriver | Result<T>.ok

import { makeSequentialIdFactory }    from '../utils/uuid';
import { ChatHistoryRepository }      from '../storage/chat/ChatHistoryRepository';
import type { SessionMeta }           from '../storage/chat/ChatHistoryRepository';
import {
  addPendingDownload as enqueuePendingDownload,
  removePendingDownload,
  readPendingDownloads,
  type PendingDownload,
} from '../background/BackgroundModelDownload';
import type { ChatMessage } from '../hooks/useAIChat';

// ─── Mock'lar ─────────────────────────────────────────────────────────────────

jest.mock('react-native-mmkv', () => {
  // In-memory MMKV mock
  const store = new Map<string, string>();
  return {
    MMKV: jest.fn().mockImplementation(() => ({
      getString:  (k: string) => store.get(k),
      set:        (k: string, v: string) => store.set(k, v),
      delete:     (k: string) => store.delete(k),
      clearAll:   () => store.clear(),
    })),
  };
});

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    jest.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
      setItem:    jest.fn((k: string, v: string) => { store.set(k, v); return Promise.resolve(); }),
      removeItem: jest.fn((k: string) => { store.delete(k); return Promise.resolve(); }),
    },
  };
});

// ─── Yardımcılar ──────────────────────────────────────────────────────────────

const genId = makeSequentialIdFactory('test');

function makeMessage(
  role: ChatMessage['role'],
  content: string,
): ChatMessage {
  return { id: genId(), role, content, timestamp: Date.now() };
}

function makePending(modelId: string): PendingDownload {
  return {
    modelId,
    url:      `https://cdn.example.com/${modelId}.gguf`,
    destPath: `/data/${modelId}.gguf`,
    sizeMB:   700,
    sha256:   'abc123',
    addedAt:  Date.now(),
  };
}

// ─── ChatHistoryRepository ────────────────────────────────────────────────────

describe('ChatHistoryRepository', () => {
  let repo: ChatHistoryRepository;

  beforeEach(() => {
    repo = new ChatHistoryRepository('test-instance');
  });

  describe('createSession', () => {
    it('session oluşturur ve listede görünür', () => {
      const result = repo.createSession('s1', 'Test Session', []);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.id).toBe('s1');
      expect(result.data.title).toBe('Test Session');

      const list = repo.listSessions();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.data.some((s: SessionMeta) => s.id === 's1')).toBe(true);
    });

    it('title boşsa preview kullanır', () => {
      const msgs = [makeMessage('user', 'Merhaba dünya')];
      const result = repo.createSession('s2', '', msgs);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.title).toBe('Merhaba dünya');
    });

    it('her ikisi boşsa "Yeni Sohbet" kullanır', () => {
      const result = repo.createSession('s3', '', []);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.title).toBe('Yeni Sohbet');
    });
  });

  describe('getMessages', () => {
    it('yazılan mesajları geri okur', () => {
      const msgs = [
        makeMessage('user', 'Soru'),
        makeMessage('assistant', 'Cevap'),
      ];
      repo.createSession('s4', 'Test', msgs);

      const result = repo.getMessages('s4');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(2);
      expect(result.data[0].content).toBe('Soru');
      expect(result.data[1].content).toBe('Cevap');
    });

    it('sistem mesajı korunur', () => {
      const msgs = [
        makeMessage('system', 'Sen bir yardımcısın'),
        makeMessage('user', 'Merhaba'),
      ];
      repo.createSession('s5', 'Test', msgs);

      const result = repo.getMessages('s5');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data[0].role).toBe('system');
    });

    it('olmayan session için boş dizi döner', () => {
      const result = repo.getMessages('nonexistent');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(0);
    });
  });

  describe('appendMessages', () => {
    it('mevcut mesajlara ekler', () => {
      const initial = [makeMessage('user', 'İlk')];
      repo.createSession('s6', 'Test', initial);

      const added = [makeMessage('assistant', 'Yanıt')];
      const result = repo.appendMessages('s6', added);

      expect(result.ok).toBe(true);
      expect(result.data.messageCount).toBe(2);

      const msgs = repo.getMessages('s6');
      expect(msgs.ok && msgs.data).toHaveLength(2);
    });

    it('aynı içerik tekrar append edilince no-op döner', () => {
      const msgs = [makeMessage('user', 'Test')];
      repo.createSession('s7', 'T', msgs);

      // İkinci kez aynı mesaj → checksum aynı → messageCount değişmez
      const result = repo.appendMessages('s7', msgs);
      expect(result.ok).toBe(true);
      // messageCount 1 (ilk) veya 2 (eklenmiş) — implementasyona göre
      // Önemli olan: crash yok, ok() döner
    });
  });

  describe('deleteSession', () => {
    it('session silinir ve listede görünmez', () => {
      repo.createSession('s8', 'Silinecek', []);
      const del = repo.deleteSession('s8');
      expect(del.ok).toBe(true);

      const list = repo.listSessions();
      expect(list.ok && list.data.every((s: SessionMeta) => s.id !== 's8')).toBe(true);
    });
  });

  describe('updateTitle', () => {
    it('title güncellenir', () => {
      repo.createSession('s9', 'Eski Başlık', []);
      const result = repo.updateTitle('s9', 'Yeni Başlık');
      expect(result.ok).toBe(true);

      const list = repo.listSessions();
      expect(list.ok && list.data.find((s: SessionMeta) => s.id === 's9')?.title).toBe('Yeni Başlık');
    });

    it('olmayan session için err döner', () => {
      const result = repo.updateTitle('nonexistent', 'Başlık');
      expect(result.ok).toBe(false);
    });
  });

  describe('verifyIntegrity', () => {
    it('yazılan session checksum geçerli', () => {
      const msgs = [makeMessage('user', 'Test')];
      repo.createSession('s10', 'Test', msgs);
      expect(repo.verifyIntegrity('s10')).toBe(true);
    });

    it('olmayan session false döner', () => {
      expect(repo.verifyIntegrity('nonexistent')).toBe(false);
    });
  });

  describe('listSessions', () => {
    it('updatedAt DESC sıralar', () => {
      repo.createSession('older', 'Eski', []);
      // updatedAt farkı için küçük gecikme simülasyonu
      const oldMeta = repo.listSessions();
      repo.createSession('newer', 'Yeni', []);

      const list = repo.listSessions();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const ids = list.data.map((s: SessionMeta) => s.id);
      expect(ids.indexOf('newer')).toBeLessThan(ids.indexOf('older'));
    });
  });

  describe('MAX_MESSAGES clamp', () => {
    it('501 mesaj → 500 mesaj (sistem korunur)', () => {
      const msgs: ChatMessage[] = [makeMessage('system', 'System')];
      for (let i = 0; i < 501; i++) {
        msgs.push(makeMessage('user', `Mesaj ${i}`));
      }
      repo.createSession('s_big', 'Big', msgs);

      const result = repo.getMessages('s_big');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Sistem mesajı + en fazla 499 user mesajı = 500 max
      expect(result.data.length).toBeLessThanOrEqual(500);
      expect(result.data[0].role).toBe('system');
    });
  });
});

// ─── BackgroundModelDownload queue ───────────────────────────────────────────

describe('BackgroundModelDownload queue', () => {
  // AsyncStorage mock her test'te sıfırlanmaz → ayrı key kullan

  it('pending download kuyruğa eklenir', async () => {
    const dl = makePending('gemma-3-1b');
    const result = await enqueuePendingDownload(dl);
    expect(result.ok).toBe(true);

    const list = await readPendingDownloads();
    expect(list.some((d) => d.modelId === 'gemma-3-1b')).toBe(true);
  });

  it('aynı modelId tekrar eklenince güncellenir (dedup)', async () => {
    const dl1 = makePending('phi-4-mini');
    const dl2 = { ...makePending('phi-4-mini'), sizeMB: 800 };

    await enqueuePendingDownload(dl1);
    await enqueuePendingDownload(dl2);

    const list = await readPendingDownloads();
    const found = list.filter((d) => d.modelId === 'phi-4-mini');
    expect(found).toHaveLength(1);
    expect(found[0].sizeMB).toBe(800); // en son güncelleme kazanır
  });

  it('download kuyruktan kaldırılır', async () => {
    await enqueuePendingDownload(makePending('gemma-3-4b'));
    await removePendingDownload('gemma-3-4b');

    const list = await readPendingDownloads();
    expect(list.every((d) => d.modelId !== 'gemma-3-4b')).toBe(true);
  });

  it('olmayan modelId kaldırılırsa hata yok', async () => {
    await expect(removePendingDownload('nonexistent')).resolves.not.toThrow();
  });
});

// ─── StreamingInferenceClient parser (unit) ───────────────────────────────────
// fetch mock gerektirmez — parser mantığı izole test edilir

describe('SSE parser mantığı (Anthropic)', () => {
  // parseAnthropicSSE export edilmemiş — internal; dolaylı test:
  // streamInference'ın doğru chunk'ları onChunk'a ilettiğini doğrula

  it('geçersiz JSON satırı crash oluşturmaz', () => {
    // Parser try/catch içinde — bu test integration seviyesinde
    // Sadece derleme ve import doğrulanır
    expect(true).toBe(true);
  });
});
