/**
 * ai/orchestration/ResponseAggregator.ts
 *
 * § 55 — Deterministik self-critique ve kalite skoru.
 *
 * Paralel iki model çalışmaz; tek modelin cevabını senkron kurallarla
 * değerlendirir. Skor < QUALITY_THRESHOLD → cloud escalation sinyali.
 *
 * Skor bileşenleri (toplam 1.0):
 *   hasContent   (0.35) — cevap yeterli uzunlukta mı
 *   hasCodeBlock (0.25) — kod beklenen intent'te kod var mı
 *   noError      (0.25) — hata/belirsizlik ifadesi yok mu
 *   notTruncated (0.15) — cevap tam görünüyor mu
 *
 * § 1  : Result<T> — score() throw etmez
 */

import type { Intent, QualityScore }  from './types';
import { IntentCategory }             from './types';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

/**
 * § 55 — Minimum kalite eşiği.
 * Bu değerin altındaki cevaplar cloud escalation için işaretlenir.
 * 0.7 seçimi: 3/4 bileşenin geçmesi gerekiyor demek —
 * kısmi/hatalı cevaplarda cloud'a geç, yeterli cevaplarda kalma.
 */
export const QUALITY_THRESHOLD = 0.7;

/** Kod gerektiren intent kategorileri */
const CODE_REQUIRED_INTENTS = new Set<IntentCategory>([
  IntentCategory.CODE_COMPLETE,
  IntentCategory.DEBUG,
  IntentCategory.REFACTOR,
  IntentCategory.TEST_WRITE,
]);

/** Yeterli uzunluk eşiği (karakter) — intent'e göre değişir */
const MIN_LENGTH: Record<IntentCategory, number> = {
  [IntentCategory.CODE_COMPLETE]: 100,
  [IntentCategory.DEBUG]:         80,
  [IntentCategory.REFACTOR]:      100,
  [IntentCategory.TEST_WRITE]:    120,
  [IntentCategory.DOC_WRITE]:     60,
  [IntentCategory.EXPLAIN]:       80,
  [IntentCategory.FILE_ANALYSIS]: 100,
  [IntentCategory.GENERAL]:       40,
};

/** Hata / yetersizlik sinyalleri */
const ERROR_PATTERNS = [
  /i'm sorry|üzgünüm|özür dilerim/i,
  /i don't know|bilmiyorum|emin değilim.*bu/i,
  /i cannot|yapamam|yapamıyorum/i,
  /as an ai.*(cannot|unable)/i,
  /incomplete|eksik.*kald|tamamlayamadım/i,
];

/** Truncation sinyalleri — cevap yarıda kesilmiş */
const TRUNCATION_PATTERNS = [
  /```\s*$/, // Kapanmamış kod bloğu
  /\.\.\.\s*$/, // Nokta nokta nokta ile biten
  /\bve\s*$|\band\s*$|\bor\s*$|\bya da\s*$/i, // Yarım cümle
];

// ─── ResponseAggregator ───────────────────────────────────────────────────────

export class ResponseAggregator {

  /**
   * Cevabı değerlendir ve kalite skoru üret.
   * Senkron, Hermes uyumlu.
   *
   * @param response  Modelin ürettiği tam metin
   * @param intent    IntentEngine'den gelen intent
   */
  score(response: string, intent: Intent): QualityScore {
    const hasContent   = this._checkContent(response, intent);
    const hasCodeBlock = this._checkCodeBlock(response, intent);
    const hasError     = this._checkError(response);
    const isTruncated  = this._checkTruncated(response);

    const score =
      (hasContent   ? 0.35 : 0) +
      (hasCodeBlock ? 0.25 : 0) +
      (!hasError    ? 0.25 : 0) +
      (!isTruncated ? 0.15 : 0);

    return { score, hasContent, hasCodeBlock, hasError, isTruncated };
  }

  /**
   * Skoru kullanarak escalation kararı ver.
   * true → cloud escalation gerekiyor
   */
  shouldEscalate(qualityScore: QualityScore): boolean {
    return qualityScore.score < QUALITY_THRESHOLD;
  }

  /**
   * Debug: skor bileşenlerini human-readable string olarak döndür.
   */
  describe(qs: QualityScore): string {
    const parts = [
      `score=${qs.score.toFixed(2)}`,
      qs.hasContent   ? 'content✓' : 'content✗',
      qs.hasCodeBlock ? 'code✓'    : 'code✗',
      qs.hasError     ? 'error!'   : 'noError✓',
      qs.isTruncated  ? 'truncated!' : 'complete✓',
    ];
    return parts.join(' | ');
  }

  // ── Özel kontroller ─────────────────────────────────────────────────────────

  private _checkContent(response: string, intent: Intent): boolean {
    const minLen = MIN_LENGTH[intent.category] ?? 40;
    return response.trim().length >= minLen;
  }

  private _checkCodeBlock(response: string, intent: Intent): boolean {
    // Kod gerektirmeyen intent'lerde bu kriter otomatik geçer
    if (!CODE_REQUIRED_INTENTS.has(intent.category)) return true;
    // Inline veya fenced kod bloğu var mı
    return /```[\s\S]+?```|`[^`]{10,}`/.test(response);
  }

  private _checkError(response: string): boolean {
    return ERROR_PATTERNS.some(p => p.test(response));
  }

  private _checkTruncated(response: string): boolean {
    return TRUNCATION_PATTERNS.some(p => p.test(response));
  }
}

export const responseAggregator = new ResponseAggregator();
