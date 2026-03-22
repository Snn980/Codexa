/**
 * ai/orchestration/IntentEngine.ts
 *
 * § 51 — Kural tabanlı intent tespiti.
 *
 * 8 kategori, deterministik regex/keyword eşleşmesi.
 * Hermes uyumlu (ML embedding / LLM meta-call yok).
 *
 * Tasarım kararları:
 *   • Her kural bir weight taşır — birden fazla kural eşleşirse
 *     en yüksek toplam ağırlık kazanır.
 *   • Belirsiz mesajlarda GENERAL fallback — hiç match yoksa confidence 0.4.
 *   • requiresCode / requiresContext intent içeriğinden çıkarılır,
 *     ContextBuilder ve ModelRouter için ipucu.
 *   • estimatedTokens: kaba tahmin (4 char ≈ 1 token, § 14.4 CHARS_PER_TOKEN).
 *
 * Test: __tests__/Orchestration.test.ts
 */

import type { Intent, IntentCategory } from './types';
import { IntentCategory as IC }        from './types';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4; // § 14.4

// ─── Kural tanımı ─────────────────────────────────────────────────────────────

interface Rule {
  category: IntentCategory;
  /** Büyük/küçük harf duyarsız regex */
  pattern:  RegExp;
  weight:   number;
}

const RULES: readonly Rule[] = [
  // ── code_complete ──────────────────────────────────────────────────────────
  { category: IC.CODE_COMPLETE, weight: 0.9,
    pattern: /tamamla|complete|implement|yaz.*fonksiyon|fonksiyon.*yaz|method.*ekle|ekle.*method|write.*function|function.*implement|kod.*yaz|yaz.*kod|devam.*et.*kod/i },
  { category: IC.CODE_COMPLETE, weight: 0.7,
    pattern: /```[\s\S]*?```.*devam|continue.*code|finish.*implement/i },

  // ── debug ──────────────────────────────────────────────────────────────────
  { category: IC.DEBUG, weight: 0.95,
    pattern: /hata.*neden|neden.*hata|error.*why|why.*error|bug.*nerede|nerede.*bug|crash.*neden|neden.*crash|fix.*this|bunu.*düzelt|düzelt.*bunu/i },
  { category: IC.DEBUG, weight: 0.85,
    pattern: /TypeError|ReferenceError|SyntaxError|undefined.*not|cannot read|null.*pointer|NullPointerException|SIGABRT|unhandled.*exception/i },
  { category: IC.DEBUG, weight: 0.75,
    pattern: /çalışmıyor|çalışmıyor|doesn.t work|not working|failing|başarısız|hata veriyor/i },

  // ── explain ────────────────────────────────────────────────────────────────
  { category: IC.EXPLAIN, weight: 0.9,
    pattern: /açıkla|explain|ne.*yapıyor|what.*does|nasıl.*çalışıyor|how.*works|anlat|describe|ne.*anlama/i },
  { category: IC.EXPLAIN, weight: 0.7,
    pattern: /bu.*kodu.*anlıyorum|nedir.*bu|what.*is.*this|ne.*demek/i },

  // ── refactor ───────────────────────────────────────────────────────────────
  { category: IC.REFACTOR, weight: 0.95,
    pattern: /refactor|yeniden.*yaz|rewrite|daha.*temiz|clean.*up|optimize|iyileştir|improve.*code|düzenle|kodu.*düzelt/i },
  { category: IC.REFACTOR, weight: 0.8,
    pattern: /solid.*prensip|dry.*prensip|single.*responsibility|best.*practice|daha.*iyi.*yaz/i },

  // ── test_write ─────────────────────────────────────────────────────────────
  { category: IC.TEST_WRITE, weight: 0.98,
    pattern: /test.*yaz|yaz.*test|write.*test|unit.*test|integration.*test|jest.*test|test.*case|test.*ekle/i },
  { category: IC.TEST_WRITE, weight: 0.85,
    pattern: /describe\(|it\(|expect\(|toBe\(|mock.*function|spy.*on|test.*coverage/i },

  // ── doc_write ──────────────────────────────────────────────────────────────
  { category: IC.DOC_WRITE, weight: 0.97,
    pattern: /dokümantasyon|yorum\s*yaz|write.*doc/i },
  { category: IC.DOC_WRITE, weight: 0.95,
    pattern: /doc.*yaz|yaz.*doc|jsdoc|tsdoc|readme|comment.*ekle|ekle.*comment|document.*this|açıklama.*ekle/i },
  { category: IC.DOC_WRITE, weight: 0.8,
    pattern: /\/\*\*[\s\S]*?@param|@returns|@throws|add.*comments|yorum.*ekle/i },

  // ── file_analysis ──────────────────────────────────────────────────────────
  { category: IC.FILE_ANALYSIS, weight: 0.9,
    pattern: /projedeki|tüm.*dosya|all.*files|entire.*project|tüm.*kod|analiz.*et|analyze.*project|bul.*tüm|find.*all|grep.*project/i },
  { category: IC.FILE_ANALYSIS, weight: 0.8,
    pattern: /TODO|FIXME|HACK|bağımlılık|dependency|import.*graph|circular.*import|dead.*code/i },

  // ── general ────────────────────────────────────────────────────────────────
  { category: IC.GENERAL, weight: 0.5,
    pattern: /nedir|ne.*demek|what.*is|how.*to|nasıl|explain.*concept|kavram|tanım|definition/i },
  { category: IC.GENERAL, weight: 0.4,
    pattern: /merhaba|hello|hi|help|yardım|soru|question/i },
];

// ─── Kod varlığı sinyalleri ───────────────────────────────────────────────────

const CODE_SIGNALS = /```|`[^`]+`|function\s+\w+|const\s+\w+\s*=|class\s+\w+|import\s+|export\s+|=>/;
const CONTEXT_SIGNALS = /dosya|file|proje|project|tüm|all|analiz|analyz|klasör|folder|dizin|directory/i;

// ─── IntentEngine ─────────────────────────────────────────────────────────────

export class IntentEngine {

  /**
   * Mesajı analiz et ve Intent döndür.
   * Senkron — Hermes Worker içinde de çalışabilir.
   */
  analyze(message: string): Intent {
    // Kategori → birikimli ağırlık haritası
    const scores = new Map<IntentCategory, number>();

    for (const rule of RULES) {
      if (rule.pattern.test(message)) {
        const prev = scores.get(rule.category) ?? 0;
        scores.set(rule.category, prev + rule.weight);
      }
    }

    let bestCategory: IntentCategory = IC.GENERAL;
    let bestScore = 0;

    for (const [cat, score] of scores) {
      if (score > bestScore) {
        bestScore  = score;
        bestCategory = cat;
      }
    }

    // Eşleşme yoksa GENERAL, düşük confidence
    const confidence = bestScore > 0
      ? Math.min(bestScore, 1.0)
      : 0.4;

    const estimatedTokens = Math.ceil(message.length / CHARS_PER_TOKEN);

    return {
      category:        bestCategory,
      confidence,
      requiresCode:    CODE_SIGNALS.test(message),
      requiresContext: CONTEXT_SIGNALS.test(message),
      estimatedTokens,
    };
  }

  /**
   * Test / debug: tüm kural eşleşmelerini döndür.
   */
  debugScores(message: string): Record<IntentCategory, number> {
    const scores: Partial<Record<IntentCategory, number>> = {};
    for (const rule of RULES) {
      if (rule.pattern.test(message)) {
        scores[rule.category] = (scores[rule.category] ?? 0) + rule.weight;
      }
    }
    return scores as Record<IntentCategory, number>;
  }
}

// Module-level singleton — AppContainer dışı kullanım için
export const intentEngine = new IntentEngine();
