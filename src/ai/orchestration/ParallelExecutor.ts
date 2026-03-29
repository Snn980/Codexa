/**
 * ai/orchestration/ParallelExecutor.ts
 *
 * § 54 — Offline-first execution, timeout → cloud escalation.
 *
 * "Parallel" adı yanıltıcı olmasın: gerçek paralel çalışma yok.
 * Mobil kısıtları (RAM, batarya, maliyet) nedeniyle tek-kanallı çalışır:
 *
 *   1. primary (offline) model'i başlat
 *   2. OFFLINE_TIMEOUT_MS içinde stream tamamlanırsa → kullan
 *   3. timeout veya kalite yetersizse → fallback (cloud) escalate
 *   4. fallback da yoksa → primary result döndür (en iyisi buydu)
 *
 * Execution AIWorkerBridge üzerinden gider; runtime'lara doğrudan erişmez.
 *
 * § 1  : Result<T>
 * § 34 : Worker protokolü — IWorkerPort
 */

import type { Result }                  from '../../core/Result';
import { ok, err }                      from '../../core/Result';
import type { IAIWorkerClient }         from '../AIWorkerClient';
import type { RouteDecision, BuiltContext } from './types';
import type { AIModelId }               from '../AIModels';
import { getModel }                     from '../AIModels';

// ─── Tipler ───────────────────────────────────────────────────────────────────

export interface ExecutionResult {
  fullText:   string;
  modelUsed:  AIModelId;
  /** Cloud'a yükseltildi mi */
  escalated:  boolean;
  durationMs: number;
}

export interface ExecutorOptions {
  onChunk:    (chunk: string) => void;
  onComplete?: (fullText: string, modelUsed: AIModelId) => void;
  signal:     AbortSignal;
}

// ─── ParallelExecutor ─────────────────────────────────────────────────────────

export class ParallelExecutor {
  // Aktif timeout'ları takip et (open handles fix)
  private _activeTimeouts = new Set<NodeJS.Timeout>();

  constructor(private readonly _client: IAIWorkerClient) {}

  /**
   * Tüm aktif timeout'ları temizle (test cleanup için)
   */
  cleanup(): void {
    for (const timeout of this._activeTimeouts) {
      clearTimeout(timeout);
    }
    this._activeTimeouts.clear();
  }

  /**
   * Routing kararına göre çalıştır.
   * Result<ExecutionResult> — throw etmez.
   */
  async run(
    decision: RouteDecision,
    context:  BuiltContext,
    opts:     ExecutorOptions,
  ): Promise<Result<ExecutionResult>> {
    const start = Date.now();

    // ── 1. Primary model (genellikle offline) ─────────────────────────────────
    const primaryResult = await this._runWithTimeout(
      decision.primaryModel,
      context,
      opts,
      decision.timeoutMs,
    );

    // Başarılı → döndür
    if (primaryResult.ok) {
      const durationMs = Date.now() - start;
      opts.onComplete?.(primaryResult.data.fullText, decision.primaryModel);
      return ok({
        fullText:  primaryResult.data.fullText,
        modelUsed: decision.primaryModel,
        escalated: false,
        durationMs,
      });
    }

    // ── 2. Fallback (cloud) ───────────────────────────────────────────────────
    if (!decision.fallbackEnabled || !decision.fallbackModel) {
      // Fallback yok — primary hatasını ilet
      return err(
        primaryResult.error.code,
        primaryResult.error.message,
        { cause: primaryResult.error },
      );
    }

    // Kullanıcıya escalation bildirimi (chunk olarak şeffaf geçiş)
    opts.onChunk('\n\n_[Offline model yanıt üretemedi — bulut modeline geçiliyor…]_\n\n');

    // AbortSignal iptal edildiyse escalate etme
    if (opts.signal.aborted) {
      return err('ABORTED', 'Request aborted before cloud escalation');
    }

    const fallbackResult = await this._runWithTimeout(
      decision.fallbackModel,
      context,
      opts,
      0, // cloud için timeout yok
    );

    const durationMs = Date.now() - start;

    if (fallbackResult.ok) {
      opts.onComplete?.(fallbackResult.data.fullText, decision.fallbackModel);
      return ok({
        fullText:  fallbackResult.data.fullText,
        modelUsed: decision.fallbackModel,
        escalated: true,
        durationMs,
      });
    }

    return err(
      fallbackResult.error.code,
      `Primary and fallback both failed. Last: ${fallbackResult.error.message}`,
    );
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /**
   * Timeout'ları takip eden setTimeout wrapper'ı
   */
  private _setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    const timeout = setTimeout(() => {
      this._activeTimeouts.delete(timeout);
      callback();
    }, ms);
    this._activeTimeouts.add(timeout);
    return timeout;
  }

  private async _runWithTimeout(
    modelId:   AIModelId,
    context:   BuiltContext,
    opts:      ExecutorOptions,
    timeoutMs: number,
  ): Promise<Result<{ fullText: string }>> {
    const model = getModel(modelId);
    if (!model) {
      return err('MODEL_NOT_FOUND', `Unknown model: ${modelId}`);
    }

    // Timeout controller (0 = timeout yok)
    const timeoutController = timeoutMs > 0 ? new AbortController() : null;
    let timeoutHandle: NodeJS.Timeout | null = null;

    if (timeoutController && timeoutMs > 0) {
      // _setTimeout kullanarak timeout'u takip et
      timeoutHandle = this._setTimeout(() => timeoutController!.abort(), timeoutMs);
    }

    const signals: AbortSignal[] = [opts.signal];
    if (timeoutController) signals.push(timeoutController.signal);
    const combinedSignal = anySignal(signals);

    try {
      // Sinyal zaten iptal edildiyse başlatma
      if (combinedSignal.aborted) {
        return err('ABORTED', 'Request aborted before start');
      }

      let fullText = '';

      const gen = this._client.streamChat(
        {
          model:     modelId,
          messages:  [
            { role: 'system',  content: context.systemPrompt },
            { role: 'user',    content: context.prompt },
          ],
          maxTokens: 1024,
        },
        combinedSignal,
      );

      let totalTokens = 0;

for await (const chunk of gen) {
  if (typeof chunk === 'string') {
    fullText += chunk;
    opts.onChunk(chunk);
  }
}

// ✅ Generator'ün return value'sini al
const genResult = await gen;

if (!genResult.ok) {
  return err(genResult.error.code, genResult.error.message);
}

totalTokens = genResult.data.totalTokens;

return ok({ fullText });

    } catch (e: unknown) {
      const isTimeout = timeoutController?.signal.aborted && !opts.signal.aborted;
      if (isTimeout) {
        return err('OFFLINE_TIMEOUT', `Model ${modelId} timed out after ${timeoutMs}ms`);
      }
      if (opts.signal.aborted) {
        return err('ABORTED', 'Request aborted by user');
      }

      const msg = e instanceof Error ? e.message : String(e);
      return err('EXECUTION_ERROR', msg);
    } finally {
      // Her durumda timeout'u temizle
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        this._activeTimeouts.delete(timeoutHandle);
      }
    }
  }
}

// ─── Hermes uyumlu anySignal ──────────────────────────────────────────────────
// AbortSignal.any() Hermes < 0.74'te yok (FIX-6 ile tutarlı).

function anySignal(signals: AbortSignal[]): AbortSignal {
  const already = signals.find(s => s.aborted);
  if (already) return already;

  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals);
  }

  const ctrl = new AbortController();
  const abort = () => {
    ctrl.abort();
    for (const s of signals) s.removeEventListener('abort', abort);
  };
  for (const s of signals) s.addEventListener('abort', abort, { once: true });
  return ctrl.signal;
}
