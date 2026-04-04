/**
 * ai/orchestration/types.ts
 *
 * AIOrchestrator katmanı için paylaşılan tipler.
 *
 * § 50 : AIOrchestrator facade
 * § 51 : IntentEngine — 8 kategori
 * § 53 : ModelRouter — offline-first
 * § 54 : ParallelExecutor
 * § 55 : ResponseAggregator — self-critique
 *
 * § 1  : Values<T> pattern (const enum yok — Hermes)
 */

import type { AIModelId }       from '../AIModels';
import type { ChatMessage }     from '../../hooks/useAIChat';
import type { AIPermissionStatus } from '../../permission/PermissionGate';

// ─── Intent ───────────────────────────────────────────────────────────────────

/**
 * § 51 — 8 intent kategorisi.
 *
 * | Kategori      | Örnek mesaj                              | PromptKind  |
 * |---------------|------------------------------------------|-------------|
 * | code_complete | "şu fonksiyonu tamamla"                  | code        |
 * | explain       | "bu kodu açıkla"                         | quick_answer|
 * | debug         | "neden hata veriyor"                     | code        |
 * | refactor      | "bunu daha temiz yaz"                    | code        |
 * | test_write    | "bu fonksiyon için test yaz"             | code        |
 * | doc_write     | "JSDoc ekle / README güncelle"           | quick_answer|
 * | file_analysis | "projedeki tüm TODO'ları bul"            | long_context|
 * | general       | "React hooks nedir"                      | quick_answer|
 */
export const IntentCategory = {
  CODE_COMPLETE: 'code_complete',
  EXPLAIN:       'explain',
  DEBUG:         'debug',
  REFACTOR:      'refactor',
  TEST_WRITE:    'test_write',
  DOC_WRITE:     'doc_write',
  FILE_ANALYSIS: 'file_analysis',
  GENERAL:       'general',
} as const;

export type IntentCategory = (typeof IntentCategory)[keyof typeof IntentCategory];

export interface Intent {
  category:       IntentCategory;
  /** 0.0 – 1.0 — kural eşleşme gücü */
  confidence:     number;
  /** Mesaj kod içeriyor mu (backtick, dil adı, vb.) */
  requiresCode:   boolean;
  /** Dosya bağlamı gerekiyor mu (file_analysis, refactor) */
  requiresContext: boolean;
  /** Tahmini token yükü — ContextBuilder için ipucu */
  estimatedTokens: number;
}

// ─── Orchestration Request / Result ──────────────────────────────────────────

export interface OrchestrationRequest {
  /** Son kullanıcı mesajı */
  userMessage: string;
  /** Mevcut session mesajları — ContextBuilder için */
  history:     readonly ChatMessage[];
  /** İzin durumu — ModelRouter için */
  permission:  AIPermissionStatus;
  /** Kullanıcının seçtiği provider — null = otomatik */
  preferredProvider?: 'anthropic' | 'openai' | null;
  /** İptal sinyali */
  signal:      AbortSignal;
  /** Chunk callback — streaming UI güncellemesi */
  onChunk:     (chunk: string) => void;
  /** Stream tamamlandı */
  onComplete?: (fullText: string, modelUsed: AIModelId) => void;
}

export interface OrchestrationResult {
  /** Modelin ürettiği tam metin */
  fullText:    string;
  /** Hangi model kullandı */
  modelUsed:   AIModelId;
  /** Tespit edilen intent */
  intent:      Intent;
  /** Cloud'a escalate edildi mi */
  escalated:   boolean;
  /** Self-critique skoru (0.0 – 1.0) */
  qualityScore: number;
  /** Toplam süre (ms) */
  durationMs:  number;
}

// ─── Route Decision ───────────────────────────────────────────────────────────

export interface RouteDecision {
  /** Birincil model */
  primaryModel:    AIModelId;
  /** Offline timeout sonrası fallback model (null = fallback yok) */
  fallbackModel:   AIModelId | null;
  /** Offline deneme için timeout (ms) — § 53 */
  timeoutMs:       number;
  /** Cloud escalation aktif mi */
  fallbackEnabled: boolean;
}

// ─── Quality Score ────────────────────────────────────────────────────────────

export interface QualityScore {
  /** Toplam skor (0.0 – 1.0) */
  score:       number;
  /** Cevap yeterince uzun mu */
  hasContent:  boolean;
  /** Kod bloğu bekleniyor ve var mı */
  hasCodeBlock: boolean;
  /** Hata / belirsizlik ifadesi içeriyor mu */
  hasError:    boolean;
  /** Cevap truncate görünüyor mu (eksik bitiş) */
  isTruncated: boolean;
}

// ─── Built Context ────────────────────────────────────────────────────────────

export interface BuiltContext {
  /** PromptBuilder'dan çıkan hazır prompt */
  prompt:      string;
  /** Tahmini token sayısı */
  tokenCount:  number;
  /** Sistem mesajı ayrı (bazı model API'leri ayırır) */
  systemPrompt: string;
}
