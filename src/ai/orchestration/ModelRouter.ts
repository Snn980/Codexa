/**
 * ai/orchestration/ModelRouter.ts — Offline-first model routing.
 *
 * Expo Go değişikliği: CLOUD_ENABLED → direkt cloud (offline model indirili değil)
 * Native build: offline-first politika korunur
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

export const OFFLINE_TIMEOUT_MS = 15_000;

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

export class ModelRouter {

  decide(
    intent:     Intent,
    permission: AIPermissionStatus,
  ): RouteDecision | null {
    if (permission === 'DISABLED') return null;

    const promptKind = INTENT_TO_PROMPT_KIND[intent.category];

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

    // CLOUD_ENABLED: cloud modeli primary olarak kullan
    // (Expo Go'da offline model indirili değil, native build'de de cloud daha iyi)
    const cloudModel = this._bestCloudModel(promptKind);
    if (!cloudModel) {
      // Cloud model yoksa offline dene
      const offlineModel = this._bestOfflineModel(promptKind, intent);
      if (!offlineModel) return null;
      return {
        primaryModel:    offlineModel,
        fallbackModel:   null,
        timeoutMs:       OFFLINE_TIMEOUT_MS,
        fallbackEnabled: false,
      };
    }

    return {
      primaryModel:    cloudModel,
      fallbackModel:   null,
      timeoutMs:       0,
      fallbackEnabled: false,
    };
  }

  private _bestCloudModel(promptKind: PromptKind): AIModelId | null {
    const cloudModels = AI_MODELS.filter(
      (m) => m.variant === AIModelVariant.CLOUD && isModelAvailable(m.id, 'CLOUD_ENABLED'),
    );
    if (cloudModels.length === 0) return null;

    // kod için Sonnet, genel için Haiku
    if (promptKind === 'code') {
      const sonnet = cloudModels.find(m => m.id === AIModelId.CLOUD_CLAUDE_SONNET_46);
      if (sonnet) return sonnet.id as AIModelId;
    }
    const haiku = cloudModels.find(m => m.id === AIModelId.CLOUD_CLAUDE_HAIKU_45);
    if (haiku) return haiku.id as AIModelId;

    return cloudModels[0]!.id as AIModelId;
  }

  private _bestOfflineModel(promptKind: PromptKind, intent: Intent): AIModelId | null {
    const offlineModels = AI_MODELS.filter(
      m => m.variant === AIModelVariant.OFFLINE && isModelAvailable(m.id, 'LOCAL_ONLY'),
    );
    if (offlineModels.length === 0) return null;

    if (promptKind === 'long_context' && intent.estimatedTokens > 1_000) {
      const capable = offlineModels.filter(m => m.maxContextTokens >= 32_000);
      if (capable.length > 0) return this._preferReasoning(capable.map(m => m.id));
    }

    return selectModelForPrompt({
      kind:   promptKind,
      status: 'LOCAL_ONLY',
      estimatedInputTokens: intent.estimatedTokens,
    });
  }

  private _preferReasoning(candidates: AIModelId[]): AIModelId | null {
    const preference = [AIModelId.OFFLINE_PHI4_MINI, AIModelId.OFFLINE_GEMMA3_4B, AIModelId.OFFLINE_GEMMA3_1B];
    for (const id of preference) {
      if (candidates.includes(id)) return id;
    }
    return candidates[0] ?? null;
  }
}

export const modelRouter = new ModelRouter();
