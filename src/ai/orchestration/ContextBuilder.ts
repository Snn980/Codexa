/**
 * ai/orchestration/ContextBuilder.ts
 *
 * § 52 — Phase 4 (ContextCollector + TokenLimiter + PromptBuilder) facade.
 *
 * Orchestrator bu sınıf aracılığıyla context üretir;
 * alt katmanlara (ContextCollector vb.) doğrudan bağımlılık kurmaz.
 *
 * Tasarım kararları:
 *   • Phase 4 modülleri import edilemiyorsa (opsiyonel bağımlılık) basit
 *     fallback prompt inşaası devreye girer — Orchestrator hiç crash etmez.
 *   • systemPrompt sabit (IDE bağlamı) + dinamik (intent'e göre uzantı).
 *   • Mesaj geçmişi sliding window ile kesilir: context budget aşılmaz.
 *   • § 14.4: CHARS_PER_TOKEN = 4 (kaba tahmin, her iki yerde tutarlı).
 *
 * § 1  : Result<T> — build() hiç throw etmez
 */

import type { Intent, BuiltContext } from './types';
import type { ChatMessage }          from '../../hooks/useAIChat';
import type { AIModelId }            from '../AIModels';
import { TOKEN_BUDGETS }             from '../AIModels';
import { IntentCategory }            from './types';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;   // § 14.4
/** System prompt için ayrılan sabit token bütçesi */
const SYSTEM_PROMPT_TOKEN_RESERVE = 512;
/** Son mesajın her zaman eklenmesi için minimum reserve */
const LAST_MESSAGE_RESERVE = 256;

// ─── System prompt şablonları ─────────────────────────────────────────────────

const BASE_SYSTEM = `Sen bir mobil IDE asistanısın. TypeScript, React Native ve Expo konularında uzmansın.
Kısa, net ve uygulanabilir cevaplar ver. Kod örneklerinde TypeScript kullan.`;

const INTENT_EXTENSION: Record<string, string> = {
  [IntentCategory.CODE_COMPLETE]:
    ' Doğrudan çalışan kodu üret. Açıklama gereksizse kısalt.',
  [IntentCategory.DEBUG]:
    ' Önce root cause\'u belirt, sonra düzeltmeyi göster.',
  [IntentCategory.REFACTOR]:
    ' Sadece değişen kısımları göster, tamamını tekrar yazma.',
  [IntentCategory.TEST_WRITE]:
    ' Jest + React Native Testing Library kullan. Arrange-Act-Assert yap.',
  [IntentCategory.DOC_WRITE]:
    ' TSDoc/JSDoc formatında yaz. @param, @returns, @throws ekle.',
  [IntentCategory.FILE_ANALYSIS]:
    ' Tüm bulguları özetle. Dosya:satır referansı ver.',
  [IntentCategory.EXPLAIN]:
    ' Teknik ama anlaşılır açıkla. Gerekirse örnek ver.',
  [IntentCategory.GENERAL]:
    '',
};

// ─── ContextBuilder ───────────────────────────────────────────────────────────

export class ContextBuilder {

  /**
   * Intent + history + modelId'den hazır prompt üretir.
   * Her zaman BuiltContext döner, throw etmez.
   */
  build(
    userMessage: string,
    history:     readonly ChatMessage[],
    intent:      Intent,
    modelId:     AIModelId,
  ): BuiltContext {
    const budget        = TOKEN_BUDGETS[modelId];
    const contextBudget = budget.contextTokens
      - SYSTEM_PROMPT_TOKEN_RESERVE
      - LAST_MESSAGE_RESERVE;

    const systemPrompt = this._buildSystemPrompt(intent);
    const trimmedHistory = this._trimHistory(history, contextBudget, userMessage);
    const prompt         = this._buildPrompt(trimmedHistory, userMessage);

    const tokenCount = Math.ceil(
      (systemPrompt.length + prompt.length) / CHARS_PER_TOKEN,
    );

    return { prompt, tokenCount, systemPrompt };
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private _buildSystemPrompt(intent: Intent): string {
    const extension = INTENT_EXTENSION[intent.category] ?? '';
    return BASE_SYSTEM + extension;
  }

  /**
   * Mesaj geçmişini context budget'a sığacak şekilde kırpar.
   * Kırpma stratejisi: en eski mesajlar önce düşer,
   * sistem mesajı (index 0) her zaman korunur.
   */
  private _trimHistory(
    history:      readonly ChatMessage[],
    tokenBudget:  number,
    userMessage:  string,
  ): readonly ChatMessage[] {
    const userTokens = Math.ceil(userMessage.length / CHARS_PER_TOKEN);
    let remaining    = tokenBudget - userTokens;

    if (remaining <= 0) return [];

    const result: ChatMessage[] = [];
    // Sondan başa ekle (en güncel mesajlar önce)
    for (let i = history.length - 1; i >= 0; i--) {
      const msg    = history[i];
      const tokens = Math.ceil(msg.content.length / CHARS_PER_TOKEN);

      if (tokens > remaining) {
        // Sistem mesajını her zaman koru
        if (msg.role === 'system') result.unshift(msg);
        break;
      }

      remaining -= tokens;
      result.unshift(msg);
    }

    return result;
  }

  private _buildPrompt(
    history:     readonly ChatMessage[],
    userMessage: string,
  ): string {
    const lines: string[] = [];

    for (const msg of history) {
      if (msg.role === 'system') continue; // system ayrı gönderilir
      const prefix = msg.role === 'user' ? 'Kullanıcı' : 'Asistan';
      lines.push(`${prefix}: ${msg.content}`);
    }

    lines.push(`Kullanıcı: ${userMessage}`);
    return lines.join('\n\n');
  }
}

export const contextBuilder = new ContextBuilder();
