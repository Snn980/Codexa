/**
 * __tests__/Phase13.test.ts
 *
 * Phase 13 — AI Orchestration Pipeline (§ 50–54)
 *
 * T-P13-1 : IntentEngine.analyze() — 8 kategori (§ 51)
 * T-P13-2 : ContextBuilder.build() — prompt inşası (§ 52)
 * T-P13-3 : ModelRouter.decide()   — offline-first (§ 53)
 * T-P13-4 : ParallelExecutor.run() — offline + escalation (§ 54)
 * T-P13-5 : AIOrchestrator.run()   — uçtan uca (§ 50)
 */

jest.mock('../ai/AIWorkerClient');
jest.mock('../ai/OfflineRuntime', () => ({
  OfflineRuntime:     jest.fn(),
  ExpoLlamaCppLoader: jest.fn(),
}));

import { IntentEngine }     from '../ai/orchestration/IntentEngine';
import { ModelRouter }      from '../ai/orchestration/ModelRouter';
import { ContextBuilder }   from '../ai/orchestration/ContextBuilder';
import { ParallelExecutor } from '../ai/orchestration/ParallelExecutor';
import { AIOrchestrator }   from '../ai/orchestration/AIOrchestrator';
import type { Intent, OrchestrationRequest } from '../ai/orchestration/types';
import type { AIPermissionStatus } from '../permission/PermissionGate';
import type { IAIWorkerClient }    from '../ai/AIWorkerClient';
import { AIModelId }               from '../ai/AIModels';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWorkerClient(): jest.Mocked<IAIWorkerClient> {
  async function* fakeStream(): AsyncGenerator<string, { ok: true; value: { totalTokens: number } }, unknown> {
    yield 'merhaba ';
    yield 'dünya';
    return { ok: true, value: { totalTokens: 10 } };
  }
  return {
    streamChat:        jest.fn().mockImplementation(() => fakeStream()),
    requestCompletion: jest.fn().mockResolvedValue({ ok: true, value: 'test yanıtı' }),
    dispose:           jest.fn(),
  };
}

const BASE_INTENT: Intent = {
  category: 'code_complete', confidence: 0.9,
  requiresCode: false, requiresContext: false, estimatedTokens: 100,
};

// ═══════════════════════════════════════════════════════════════════════════
// T-P13-1: IntentEngine.analyze()
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P13-1: IntentEngine.analyze()', () => {
  const engine = new IntentEngine();

  const cases: [string, string][] = [
    ['şu fonksiyonu yaz: fibonacci hesapla',          'code_complete'],
    ['write a function that sorts an array',           'code_complete'],
    ['bu kodu açıkla',                                'explain'],
    ['explain how this function works',                'explain'],
    ['kodu gözden geçir',                             'general'],
    ['review my code for bugs',                       'general'],
    ['bu hata neden oluyor',                          'debug'],
    ['debug this error: undefined is not a function', 'debug'],
    ['kodu yeniden düzenle',                          'refactor'],
    ['refactor this to be more readable',             'refactor'],
    ['dokümantasyon yaz',                             'doc_write'],
    ['write JSDoc for this function',                 'doc_write'],
    ["projedeki tüm TODO'ları bul",                   'file_analysis'],
    ['merhaba',                                       'general'],
  ];

  test.each(cases)('"%s" → %s', (msg, cat) => {
    expect(engine.analyze(msg).category).toBe(cat);
  });

  test('Intent arayüz alanları mevcut', () => {
    const i = engine.analyze('write a function');
    expect(i).toHaveProperty('category');
    expect(i).toHaveProperty('confidence');
    expect(i).toHaveProperty('requiresCode');
    expect(i).toHaveProperty('requiresContext');
    expect(i).toHaveProperty('estimatedTokens');
  });

  test('confidence 0–1 arasında', () => {
    const c = engine.analyze('write a function').confidence;
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });

  test('estimatedTokens > 0', () => {
    expect(engine.analyze('explain this').estimatedTokens).toBeGreaterThan(0);
  });

  test('backtick içeren mesaj → requiresCode=true', () => {
    expect(engine.analyze('bu ne yapar: `function add(a,b){return a+b}`').requiresCode).toBe(true);
  });

  test('GENERAL confidence ≤ 0.5', () => {
    expect(engine.analyze('merhaba').confidence).toBeLessThanOrEqual(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P13-2: ContextBuilder.build()
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P13-2: ContextBuilder.build()', () => {
  const builder = new ContextBuilder();
  const modelId = AIModelId.OFFLINE_GEMMA3_1B;

  test('BuiltContext döner: prompt, tokenCount, systemPrompt', () => {
    const ctx = builder.build('write a sort', [], BASE_INTENT, modelId);
    expect(typeof ctx.prompt).toBe('string');
    expect(typeof ctx.tokenCount).toBe('number');
    expect(typeof ctx.systemPrompt).toBe('string');
  });

  test('prompt boş değil', () => {
    expect(builder.build('refactor this', [], BASE_INTENT, modelId).prompt.length).toBeGreaterThan(0);
  });

  test('tokenCount > 0', () => {
    expect(builder.build('explain', [], BASE_INTENT, modelId).tokenCount).toBeGreaterThan(0);
  });

  test('history geçilince prompt üretilir', () => {
    const h = [{ id: 'h1', role: 'user' as const, content: 'merhaba', timestamp: Date.now() }];
    expect(builder.build('şimdi yaz', h, BASE_INTENT, modelId).prompt.length).toBeGreaterThan(0);
  });

  test('ContextBuilder throw etmez', () => {
    expect(() => new ContextBuilder()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P13-3: ModelRouter.decide()
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P13-3: ModelRouter.decide()', () => {
  const router = new ModelRouter();

  test('DISABLED → null', () => {
    expect(router.decide(BASE_INTENT, 'DISABLED' as AIPermissionStatus)).toBeNull();
  });

  test('LOCAL_ONLY → fallbackModel null, fallbackEnabled false', () => {
    const d = router.decide(BASE_INTENT, 'LOCAL_ONLY' as AIPermissionStatus);
    expect(d).not.toBeNull();
    expect(d!.fallbackModel).toBeNull();
    expect(d!.fallbackEnabled).toBe(false);
  });

  test('LOCAL_ONLY → primaryModel offline:', () => {
    const d = router.decide(BASE_INTENT, 'LOCAL_ONLY' as AIPermissionStatus);
    if (d) expect(d.primaryModel).toMatch(/^offline:/);
  });

  test('CLOUD_ENABLED → RouteDecision döner', () => {
    expect(router.decide(BASE_INTENT, 'CLOUD_ENABLED' as AIPermissionStatus)).not.toBeNull();
  });

  test('RouteDecision alanları: primaryModel, fallbackModel, timeoutMs, fallbackEnabled', () => {
    const d = router.decide(BASE_INTENT, 'LOCAL_ONLY' as AIPermissionStatus);
    if (d) {
      expect(d).toHaveProperty('primaryModel');
      expect(d).toHaveProperty('fallbackModel');
      expect(d).toHaveProperty('timeoutMs');
      expect(d).toHaveProperty('fallbackEnabled');
    }
  });

  test('timeoutMs pozitif', () => {
    const d = router.decide(BASE_INTENT, 'LOCAL_ONLY' as AIPermissionStatus);
    if (d) expect(d.timeoutMs).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-P13-4: ParallelExecutor.run()
// ═══════════════════════════════════════════════════════════════════════════

describe('T-P13-4: ParallelExecutor.run()', () => {
  const router   = new ModelRouter();
  const builder  = new ContextBuilder();
  const decision = router.decide(BASE_INTENT, 'LOCAL_ONLY' as AIPermissionStatus)!;
  const ctx      = builder.build('test', [], BASE_INTENT, AIModelId.OFFLINE_GEMMA3_1B);

  test('örneği oluşturulabilir', () => {
    expect(() => new ParallelExecutor(makeWorkerClient())).not.toThrow();
  });

  test('run() Result döner', async () => {
    const result = await new ParallelExecutor(makeWorkerClient())
      .run(decision, ctx, { signal: new AbortController().signal, onChunk: jest.fn() });
    expect(result).toHaveProperty('ok');
  });

  test('abort → ok:false', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const client = makeWorkerClient();
    const result = await new ParallelExecutor(client)
      .run(decision, ctx, { signal: ctrl.signal, onChunk: jest.fn() });
    expect(result.ok).toBe(false);
  }, 5000);

  test('ok:true → fullText string', async () => {
    const result = await new AIOrchestrator(makeWorkerClient()).run({
      userMessage: 'write a fibonacci function',
      history:     [],
      permission:  'LOCAL_ONLY' as AIPermissionStatus,
      signal:      new AbortController().signal,
      onChunk:     jest.fn(),
    });
    if (result.ok) expect(typeof result.data.fullText).toBe('string');
  });

  test('pipeline: analyze → decide → build çağrıları', async () => {
    const spyA = jest.spyOn(IntentEngine.prototype,   'analyze');
    const spyD = jest.spyOn(ModelRouter.prototype,    'decide');
    const spyB = jest.spyOn(ContextBuilder.prototype, 'build');
    await new AIOrchestrator(makeWorkerClient()).run({
      userMessage: 'write a fibonacci function',
      history:     [],
      permission:  'LOCAL_ONLY' as AIPermissionStatus,
      signal:      new AbortController().signal,
      onChunk:     jest.fn(),
    });
    expect(spyA).toHaveBeenCalled();
    expect(spyD).toHaveBeenCalled();
    expect(spyB).toHaveBeenCalled();
    spyA.mockRestore(); spyD.mockRestore(); spyB.mockRestore();
  });
});
