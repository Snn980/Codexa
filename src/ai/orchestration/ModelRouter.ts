/**
 * ai/orchestration/ModelRouter.ts — Cloud-only model routing.
 * Offline routing kaldırıldı.
 */

import {
  AIModelId,
  AIModelVariant,
  isModelAvailable,
  AI_MODELS,
} from '../AIModels';
import type { AIPermissionStatus } from '../../permission/PermissionGate';
import type { Intent, RouteDecision } from './types';
import { IntentCategory } from './types';
import type { PromptKind } from '../AIModels';

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
    intent:            Intent,
    permission:        AIPermissionStatus,
    preferredProvider: 'anthropic' | 'openai' | null = null,
  ): RouteDecision | null {
    if (permission === 'DISABLED') return null;
    if (permission === 'LOCAL_ONLY') return null;

    const promptKind = INTENT_TO_PROMPT_KIND[intent.category];
    const cloudModel = this._bestCloudModel(promptKind, preferredProvider);
    if (!cloudModel) return null;

    return {
      primaryModel:    cloudModel,
      fallbackModel:   null,
      timeoutMs:       0,
      fallbackEnabled: false,
    };
  }

  private _bestCloudModel(
    promptKind:        PromptKind,
    preferredProvider: 'anthropic' | 'openai' | null,
  ): AIModelId | null {
    const cloudModels = AI_MODELS.filter(
      (m) => m.variant === AIModelVariant.CLOUD && isModelAvailable(m.id, 'CLOUD_ENABLED'),
    );
    if (cloudModels.length === 0) return null;

    // ── Kullanıcı OpenAI seçtiyse ─────────────────────────────────────
    if (preferredProvider === 'openai') {
      const openaiModels = cloudModels.filter(m =>
        m.id === AIModelId.CLOUD_GPT41_MINI || m.id === AIModelId.CLOUD_GPT54,
      );
      if (openaiModels.length > 0) {
        // code görevleri için GPT-5.4, geri kalanlar için Mini
        const gpt54 = openaiModels.find(m => m.id === AIModelId.CLOUD_GPT54);
        const mini  = openaiModels.find(m => m.id === AIModelId.CLOUD_GPT41_MINI);
        if (promptKind === 'code' && gpt54) return gpt54.id as AIModelId;
        return (mini ?? gpt54)!.id as AIModelId;
      }
      // OpenAI modeli yoksa Anthropic'e düş
    }

    // ── Anthropic (varsayılan veya tercih) ────────────────────────────
    if (promptKind === 'code') {
      const sonnet = cloudModels.find(m => m.id === AIModelId.CLOUD_CLAUDE_SONNET_46);
      if (sonnet) return sonnet.id as AIModelId;
    }
    const haiku = cloudModels.find(m => m.id === AIModelId.CLOUD_CLAUDE_HAIKU_45);
    if (haiku) return haiku.id as AIModelId;

    return cloudModels[0]!.id as AIModelId;
  }
}

export const modelRouter = new ModelRouter();
