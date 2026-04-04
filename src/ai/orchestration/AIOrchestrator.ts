/**
 * ai/orchestration/AIOrchestrator.ts
 *
 * § 50 — Orchestration katmanı için tek giriş noktası.
 *
 * Çalışma akışı:
 *   OrchestrationRequest
 *     → IntentEngine.analyze()
 *     → ContextBuilder.build()
 *     → ModelRouter.decide()
 *     → ParallelExecutor.run()   (offline-first + timeout escalation)
 *     → ResponseAggregator.score()
 *     → score < 0.7 ise cloud escalation (Executor fallback)
 *     → OrchestrationResult
 *
 * AppContainer entegrasyonu:
 *   appContainer.orchestrator  ← § 50
 *   appContainer.init() sırasında IAIWorkerClient hazır olunca Orchestrator oluşturulur.
 *
 * § 1  : Result<T>
 * § 34 : Worker protokolü (IAIWorkerClient)
 */

import type { Result }                from '../../core/Result';
import { ok, err }                    from '../../core/Result';
import type { IAIWorkerClient }       from '../AIWorkerClient';
import { IntentEngine }               from './IntentEngine';
import { ContextBuilder }             from './ContextBuilder';
import { ModelRouter }                from './ModelRouter';
import { ParallelExecutor }           from './ParallelExecutor';
import { ResponseAggregator }         from './ResponseAggregator';
import type {
  OrchestrationRequest,
  OrchestrationResult,
}                                     from './types';

// ─── AIOrchestrator ───────────────────────────────────────────────────────────

export class AIOrchestrator {

  private readonly _intent:      IntentEngine;
  private readonly _context:     ContextBuilder;
  private readonly _router:      ModelRouter;
  private readonly _executor:    ParallelExecutor;
  private readonly _aggregator:  ResponseAggregator;

  constructor(client: IAIWorkerClient) {
    this._intent     = new IntentEngine();
    this._context    = new ContextBuilder();
    this._router     = new ModelRouter();
    this._executor   = new ParallelExecutor(client);
    this._aggregator = new ResponseAggregator();
  }

  /**
   * Ana orchestration metodu.
   * Result<OrchestrationResult> — throw etmez.
   */
  async run(req: OrchestrationRequest): Promise<Result<OrchestrationResult>> {
    const start = Date.now();

    // ── 1. Intent analizi ─────────────────────────────────────────────────────
    const intent = this._intent.analyze(req.userMessage);

    // ── 2. Routing kararı ─────────────────────────────────────────────────────
    const decision = this._router.decide(intent, req.permission, req.preferredProvider ?? null);
    if (!decision) {
      return err('PERMISSION_DENIED', 'AI features are disabled. Enable in Settings.');
    }

    // ── 3. Context inşası ─────────────────────────────────────────────────────
    const context = this._context.build(
      req.userMessage,
      req.history,
      intent,
      decision.primaryModel,
    );

    // ── 4. Execution (offline-first + timeout escalation) ─────────────────────
    const execResult = await this._executor.run(
      decision,
      context,
      {
        signal:     req.signal,
        onChunk:    req.onChunk,
        onComplete: req.onComplete,
      },
    );

    if (!execResult.ok) {
      return err(execResult.error.code, execResult.error.message);
    }

    const { fullText, modelUsed, escalated, durationMs } = execResult.data;

    // ── 5. Self-critique ──────────────────────────────────────────────────────
    const qualityScore = this._aggregator.score(fullText, intent);

    // Escalation zaten executor'da yapıldı; burada sadece log
    if (__DEV__ && this._aggregator.shouldEscalate(qualityScore) && !escalated) {
      console.warn(
        '[AIOrchestrator] Low quality response but no escalation occurred.',
        this._aggregator.describe(qualityScore),
      );
    }

    return ok({
      fullText,
      modelUsed,
      intent,
      escalated,
      qualityScore: qualityScore.score,
      durationMs,
    });
  }

  /**
   * Intent-only analizi — ModelSelector / debug UI için.
   */
  analyzeIntent(message: string) {
    return this._intent.analyze(message);
  }

  /**
   * Debug: tüm kural skorlarını döndür.
   */
  debugIntent(message: string) {
    return this._intent.debugScores(message);
  }
}
