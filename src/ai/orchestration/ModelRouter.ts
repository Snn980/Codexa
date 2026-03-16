/**
 * ai/orchestration/ModelRouter.ts
 *
 * § 53 — Offline-first model routing.
 *
 * Intent + permission seviyesinden RouteDecision üretir.
 * AIRuntimeFactory ve selectModelForPrompt'un ÜSTÜNDE çalışır —
 * ikinci bir routing sistemi değil, orchestration katmanı kararıdır.
 *
 * Routing mantığı:
 *
 *   permission = LOCAL_ONLY
 *     → primary: en iyi offline model
 *     → fallback: null (cloud yasak)
 *
 *   permission = CLOUD_ENABLED
 *     → intent.category → PromptKind mapping
 *     → primary: offline (offline-first politika)
 *     → fallback: uygun cloud model
 *     → timeoutMs: OFFLINE_TIMEOUT_MS (§ 53, AppConfig'den gelir)
 *
 *   permission = DISABLED
 *     → null döner (Orchestrator erken çıkar)
 *
 * § 1  : Result<T>
 * § 14 : TOKEN_BUDGETS
 */

import {
  AIModelId,
  AIModelVariant,
  getAvailableModels,
  selectModelForPrompt,
  isModelAvailable,
  AI_MODELS,
} from '../AIModels';
import type { AIPermissionStatus } from '../../permission/PermissionGate';
import type { Intent, RouteDecision } from './types';
import { IntentCategory }            from './types';
import type { PromptKind }           from '../AIModels';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

/**
 * § 53 — Offline timeout.
 * Bu süre içinde offline model yanıt üretemezse cloud escalation tetiklenir.
 * Mobil performans testi referansı: Phi-4 Mini 2.4GB @ 512 token ~8-12s.
 * 15s: tüm offline modeller için yeterli, kullanıcı bekleme eşiği altında.
 */
export const OFFLINE_TIMEOUT_MS = 15_000;

// ─── Intent → PromptKind mapping ─────────────────────────────────────────────

const INTENT_TO_PROMPT_KIND: Record<IntentCategory, PromptKind> = {
  [IntentCategory.CODE_COMPLETE]: 'code',
  [IntentCategory.DEBUG]:         'code',
  [IntentCategory.REFACTOR]:      'code',
  [IntentCategory.TEST_WRITE]:    'code',
  [IntentCategory.EXPLAIN]:       'quick_answer',
  [IntentCategory.DOC_WRITE]:     'quick_answer',
  [IntentCategory.FILE_ANALYSIS]: 'long_context',
  [IntentCategory.GENERAL]:       'quick_answer',
};

// ─── ModelRouter ──────────────────────────────────────────────────────────────

export class ModelRouter {

  /**
   * Routing kararını üret.
   * permission = DISABLED → null (Orchestrator abort eder)
   */
  decide(
    intent:     Intent,
    permission: AIPermissionStatus,
  ): RouteDecision | null {
    if (permission === 'DISABLED') return null;

    const promptKind = INTENT_TO_PROMPT_KIND[intent.category];

    // LOCAL_ONLY: sadece offline modeller
    if (permission === 'LOCAL_ONLY') {
      const offlineModel = selectModelForPrompt({
        kind:   promptKind,
        status: 'LOCAL_ONLY',
        estimatedInputTokens: intent.estimatedTokens,
      });

      if (!offlineModel) return null;

      return {
        primaryModel:    offlineModel,
        fallbackModel:   null,
        timeoutMs:       OFFLINE_TIMEOUT_MS,
        fallbackEnabled: false,
      };
    }

    // CLOUD_ENABLED: offline-first + cloud fallback
    // Primary: önce offline dene (offline-first politika)
    const offlineModel = this._bestOfflineModel(promptKind, intent);

    // Fallback: offline çalışmazsa cloud
    const cloudModel = selectModelForPrompt({
      kind:   promptKind,
      status: 'CLOUD_ENABLED',
      estimatedInputTokens: intent.estimatedTokens,
    });

    // Hiç offline model yoksa direkt cloud
    if (!offlineModel) {
      if (!cloudModel) return null;
      return {
        primaryModel:    cloudModel,
        fallbackModel:   null,
        timeoutMs:       0,
        fallbackEnabled: false,
      };
    }

    return {
      primaryModel:    offlineModel,
      fallbackModel:   cloudModel,
      timeoutMs:       OFFLINE_TIMEOUT_MS,
      fallbackEnabled: cloudModel !== null,
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /**
   * Intent'e göre en uygun offline modeli seç.
   * file_analysis gibi büyük context gerektiren intent'lerde
   * küçük modeller elenir (TOKEN_BUDGETS kontrol edilir).
   */
  private _bestOfflineModel(
    promptKind: PromptKind,
    intent:     Intent,
  ): AIModelId | null {
    const offlineModels = AI_MODELS
      .filter(m =>
        m.variant === AIModelVariant.OFFLINE &&
        isModelAvailable(m.id, 'LOCAL_ONLY'),
      );

    if (offlineModels.length === 0) return null;

    // file_analysis: 32K+ token context gerekiyor, küçük modelleri ele
    if (promptKind === 'long_context' && intent.estimatedTokens > 1_000) {
      const capable = offlineModels.filter(
        m => m.maxContextTokens >= 32_000,
      );
      if (capable.length > 0) {
        // reasoning-first tercih: Phi-4 Mini → Gemma3-4B → Gemma3-1B
        return this._preferReasoning(capable.map(m => m.id));
      }
    }

    // Genel: selectModelForPrompt'u offline modele yönlendir
    return selectModelForPrompt({
      kind:   promptKind,
      status: 'LOCAL_ONLY',
      estimatedInputTokens: intent.estimatedTokens,
    });
  }

  private _preferReasoning(candidates: AIModelId[]): AIModelId | null {
    // Phi-4 Mini (reasoning) → Gemma3-4B → Gemma3-1B
    const preference = [
      AIModelId.OFFLINE_PHI4_MINI,
      AIModelId.OFFLINE_GEMMA3_4B,
      AIModelId.OFFLINE_GEMMA3_1B,
    ];
    for (const id of preference) {
      if (candidates.includes(id)) return id;
    }
    return candidates[0] ?? null;
  }
}

export const modelRouter = new ModelRouter();
