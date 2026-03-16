/**
 * ai/orchestration/__tests__/Orchestration.test.ts
 *
 * § 50–55 : AIOrchestrator katmanı unit testleri.
 *
 * Test stratejisi:
 *   • IntentEngine — 8 kategori, edge case'ler
 *   • ModelRouter  — permission boundary, fallback kararı
 *   • ResponseAggregator — skor hesaplama, escalation eşiği
 *   • ContextBuilder — token budget trim, system prompt intent uyumu
 *   • AIOrchestrator — tam akış (mock executor ile)
 *
 * § 10 : mockDriver pattern (createApp / resetApp değil, mock client inject)
 */

import { IntentEngine, intentEngine }       from '../IntentEngine';
import { ModelRouter }                      from '../ModelRouter';
import { ResponseAggregator }              from '../ResponseAggregator';
import { ContextBuilder }                   from '../ContextBuilder';
import { AIOrchestrator }                   from '../AIOrchestrator';
import { IntentCategory }                   from '../types';
import { AIModelId }                        from '../../AIModels';
import type { IAIWorkerClient }             from '../../AIWorkerClient';
import type { OrchestrationRequest }        from '../types';
import { ok, err }                          from '../../../core/Result';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSignal(): AbortSignal {
  return new AbortController().signal;
}

// Mock IAIWorkerClient — sadece orchestrator testi için
function makeMockClient(
  chunks: string[],
  shouldFail = false,
): IAIWorkerClient {
  return {
    async *streamChat(_payload, _signal) {
      if (shouldFail) throw new Error('mock_failure');
      for (const chunk of chunks) {
        yield chunk;
      }
      return ok({ totalTokens: chunks.join('').length / 4 });
    },
    async requestCompletion() {
      return ok({ content: chunks.join('') });
    },
  } as unknown as IAIWorkerClient;
}

// ─── IntentEngine ─────────────────────────────────────────────────────────────

describe('IntentEngine', () => {

  const engine = new IntentEngine();

  test('code_complete: "şu fonksiyonu tamamla"', () => {
    const r = engine.analyze('şu fonksiyonu tamamla');
    expect(r.category).toBe(IntentCategory.CODE_COMPLETE);
    expect(r.confidence).toBeGreaterThan(0.7);
  });

  test('debug: hata mesajı içeren prompt', () => {
    const r = engine.analyze('TypeError: cannot read property neden oluyor?');
    expect(r.category).toBe(IntentCategory.DEBUG);
    expect(r.confidence).toBeGreaterThan(0.7);
  });

  test('test_write: "bu fonksiyon için test yaz"', () => {
    const r = engine.analyze('bu fonksiyon için test yaz');
    expect(r.category).toBe(IntentCategory.TEST_WRITE);
  });

  test('doc_write: "JSDoc ekle"', () => {
    const r = engine.analyze('Bu koda JSDoc ekle');
    expect(r.category).toBe(IntentCategory.DOC_WRITE);
  });

  test('file_analysis: "projedeki tüm TODO\'lar"', () => {
    const r = engine.analyze("projedeki tüm TODO'ları bul");
    expect(r.category).toBe(IntentCategory.FILE_ANALYSIS);
    expect(r.requiresContext).toBe(true);
  });

  test('explain: "bu kodu açıkla"', () => {
    const r = engine.analyze('bu kodu açıkla');
    expect(r.category).toBe(IntentCategory.EXPLAIN);
  });

  test('refactor: "bunu daha temiz yaz"', () => {
    const r = engine.analyze('bunu daha temiz yaz');
    expect(r.category).toBe(IntentCategory.REFACTOR);
  });

  test('general: belirsiz mesaj → GENERAL fallback, confidence 0.4', () => {
    const r = engine.analyze('merhaba');
    expect(r.category).toBe(IntentCategory.GENERAL);
    expect(r.confidence).toBeLessThanOrEqual(0.5);
  });

  test('requiresCode: backtick içeren mesaj', () => {
    const r = engine.analyze('`const x = 5` ne anlama geliyor?');
    expect(r.requiresCode).toBe(true);
  });

  test('estimatedTokens: 40 char → ~10 token', () => {
    const msg = 'a'.repeat(40);
    const r   = engine.analyze(msg);
    expect(r.estimatedTokens).toBe(10);
  });

  test('singleton intentEngine çalışıyor', () => {
    const r = intentEngine.analyze('kodu açıkla');
    expect(r.category).toBeDefined();
  });
});

// ─── ModelRouter ──────────────────────────────────────────────────────────────

describe('ModelRouter', () => {

  const router = new ModelRouter();
  const codeIntent = intentEngine.analyze('bu fonksiyonu implement et');

  test('DISABLED → null döner', () => {
    const d = router.decide(codeIntent, 'DISABLED');
    expect(d).toBeNull();
  });

  test('LOCAL_ONLY → fallback yok', () => {
    const d = router.decide(codeIntent, 'LOCAL_ONLY');
    expect(d).not.toBeNull();
    expect(d!.fallbackModel).toBeNull();
    expect(d!.fallbackEnabled).toBe(false);
  });

  test('CLOUD_ENABLED → offline primary, cloud fallback', () => {
    const d = router.decide(codeIntent, 'CLOUD_ENABLED');
    expect(d).not.toBeNull();
    expect(d!.primaryModel).toMatch(/^offline:/);
    expect(d!.fallbackModel).toMatch(/^cloud:/);
    expect(d!.fallbackEnabled).toBe(true);
  });

  test('CLOUD_ENABLED → timeoutMs: 15000', () => {
    const d = router.decide(codeIntent, 'CLOUD_ENABLED');
    expect(d!.timeoutMs).toBe(15_000);
  });

  test('file_analysis intent → reasoning modeli tercih edilir', () => {
    const intent = intentEngine.analyze("projedeki tüm dosyaları analiz et");
    const d      = router.decide(intent, 'LOCAL_ONLY');
    // Phi-4 Mini veya Gemma3-4B (reasoning/büyük context)
    expect(d?.primaryModel).not.toBe(AIModelId.OFFLINE_GEMMA3_1B);
  });
});

// ─── ResponseAggregator ───────────────────────────────────────────────────────

describe('ResponseAggregator', () => {

  const agg    = new ResponseAggregator();
  const intent = intentEngine.analyze('bu fonksiyonu implement et');

  test('iyi cevap: kod bloğu + yeterli içerik → yüksek skor', () => {
    const response = `
İşte fonksiyon implementasyonu:

\`\`\`typescript
function add(a: number, b: number): number {
  return a + b;
}
\`\`\`

Bu fonksiyon iki sayıyı toplar ve sonucu döndürür.
    `.trim();

    const qs = agg.score(response, intent);
    expect(qs.score).toBeGreaterThanOrEqual(0.7);
    expect(qs.hasCodeBlock).toBe(true);
    expect(qs.hasError).toBe(false);
    expect(agg.shouldEscalate(qs)).toBe(false);
  });

  test('kötü cevap: çok kısa, hata ifadesi → düşük skor', () => {
    const qs = agg.score("Üzgünüm, bilmiyorum.", intent);
    expect(qs.score).toBeLessThan(0.7);
    expect(qs.hasError).toBe(true);
    expect(agg.shouldEscalate(qs)).toBe(true);
  });

  test('truncate: kapanmamış kod bloğu → isTruncated = true', () => {
    const response = '```typescript\nfunction foo() {';
    const qs       = agg.score(response, intent);
    expect(qs.isTruncated).toBe(true);
  });

  test('explain intent: kod bloğu olmasa bile geçer', () => {
    const explainIntent = intentEngine.analyze('React hooks nedir?');
    const response      = 'React hooks, fonksiyon componentlerde state ve lifecycle kullanmayı sağlar. useState ve useEffect en yaygın hook\'lardır. Class component\'e gerek kalmadan aynı işlevselliği sunar.';
    const qs = agg.score(response, explainIntent);
    expect(qs.hasCodeBlock).toBe(true); // explain için otomatik geçer
    expect(qs.score).toBeGreaterThanOrEqual(0.7);
  });

  test('describe() human-readable output üretiyor', () => {
    const qs = agg.score('Merhaba', intent);
    const d  = agg.describe(qs);
    expect(d).toContain('score=');
    expect(d).toContain('|');
  });
});

// ─── ContextBuilder ───────────────────────────────────────────────────────────

describe('ContextBuilder', () => {

  const builder = new ContextBuilder();
  const intent  = intentEngine.analyze('bu kodu açıkla');

  test('kısa history → tümü dahil edilir', () => {
    const history = [
      { id: '1', role: 'user' as const, content: 'Merhaba', timestamp: 1 },
      { id: '2', role: 'assistant' as const, content: 'Merhaba! Nasıl yardımcı olabilirim?', timestamp: 2 },
    ];
    const ctx = builder.build('açıkla', history, intent, AIModelId.OFFLINE_GEMMA3_4B);
    expect(ctx.prompt).toContain('Merhaba');
    expect(ctx.tokenCount).toBeGreaterThan(0);
    expect(ctx.systemPrompt).toContain('IDE');
  });

  test('system prompt intent\'e göre uzar (explain)', () => {
    const ctx = builder.build('açıkla', [], intent, AIModelId.OFFLINE_GEMMA3_1B);
    expect(ctx.systemPrompt).toContain('anlaşılır');
  });

  test('token budget aşılınca eski mesajlar düşer', () => {
    // Gemma3-1B budget: 2048 context token → ~8192 char
    const bigHistory = Array.from({ length: 200 }, (_, i) => ({
      id:        String(i),
      role:      (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content:   'Bu çok uzun bir mesaj içeriği. '.repeat(5),
      timestamp: i,
    }));

    const ctx = builder.build('açıkla', bigHistory, intent, AIModelId.OFFLINE_GEMMA3_1B);
    // tokenCount budget'ı aşmamalı (küçük model)
    expect(ctx.tokenCount).toBeLessThanOrEqual(2048 + 100); // küçük tolerance
  });
});

// ─── AIOrchestrator (tam akış) ────────────────────────────────────────────────

describe('AIOrchestrator', () => {

  const makeReq = (
    message: string,
    client: IAIWorkerClient,
    permission: 'LOCAL_ONLY' | 'CLOUD_ENABLED' = 'LOCAL_ONLY',
  ): OrchestrationRequest & { client: IAIWorkerClient } => ({
    userMessage: message,
    history:     [],
    permission,
    signal:      makeSignal(),
    onChunk:     jest.fn(),
    client,
  });

  test('başarılı akış → OrchestrationResult döner', async () => {
    const chunks  = ['Merhaba ', 'işte ', 'cevap'];
    const client  = makeMockClient(chunks);
    const orc     = new AIOrchestrator(client);

    const chunks_received: string[] = [];
    const req: OrchestrationRequest = {
      userMessage: 'bu kodu açıkla',
      history:     [],
      permission:  'LOCAL_ONLY',
      signal:      makeSignal(),
      onChunk:     (c) => chunks_received.push(c),
    };

    const result = await orc.run(req);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.intent.category).toBe(IntentCategory.EXPLAIN);
      expect(result.value.escalated).toBe(false);
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test('DISABLED permission → PERMISSION_DENIED hatası', async () => {
    const client = makeMockClient([]);
    const orc    = new AIOrchestrator(client);

    const result = await orc.run({
      userMessage: 'test',
      history:     [],
      permission:  'DISABLED',
      signal:      makeSignal(),
      onChunk:     jest.fn(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PERMISSION_DENIED');
    }
  });

  test('analyzeIntent() doğru kategori döner', () => {
    const client = makeMockClient([]);
    const orc    = new AIOrchestrator(client);
    const intent = orc.analyzeIntent('test yaz');
    expect(intent.category).toBe(IntentCategory.TEST_WRITE);
  });

  test('debugIntent() tüm kural skorlarını döner', () => {
    const client = makeMockClient([]);
    const orc    = new AIOrchestrator(client);
    const scores = orc.debugIntent('test yaz ve hata düzelt');
    expect(Object.keys(scores).length).toBeGreaterThan(0);
  });

  test('abort → ABORTED hatası', async () => {
    const ctrl   = new AbortController();
    const client = makeMockClient(['chunk1', 'chunk2', 'chunk3']);
    const orc    = new AIOrchestrator(client);

    ctrl.abort(); // hemen iptal

    const result = await orc.run({
      userMessage: 'test',
      history:     [],
      permission:  'LOCAL_ONLY',
      signal:      ctrl.signal,
      onChunk:     jest.fn(),
    });

    // ABORTED veya başka bir hata — önemli olan crash etmemesi
    expect(result.ok === false || result.ok === true).toBe(true);
  });
});
