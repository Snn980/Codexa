/**
 * ai/AIModels.ts — Model tanımları, token budget'ları, provider meta
 *
 * Son güncelleme: Mart 2026
 *
 * Offline modeller (GGUF / llama.cpp — cihazda):
 *   • Gemma 3 1B   — Google, 128K ctx, ~700MB Q4_K_M  (en hafif)
 *   • Gemma 3 4B   — Google, 128K ctx, ~2.5GB Q4_K_M  (dengeli)
 *   • Phi-4 Mini   — Microsoft, 128K ctx, ~2.4GB Q4_K_M (reasoning/kod)
 *
 * Cloud modeller (Anthropic / OpenAI — Mart 2026 canlı):
 *   • claude-haiku-4-5-20251001  — 200K ctx, 64K out, $1/$5 /MTok
 *   • claude-sonnet-4-6          — 200K ctx (1M beta), 64K out, $3/$15 /MTok
 *   • claude-opus-4-6            — 200K ctx (1M beta), 128K out, $15/$75 /MTok
 *   • gpt-4.1-mini               — 1M ctx, 32K out, OpenAI ekonomik
 *   • gpt-5.4                    — 1M ctx, 64K out, OpenAI flagship (5 Mart 2026)
 *
 * § 1  : Values<T> pattern — const enum yok (Hermes uyumsuz)
 * § 14 : TOKEN_BUDGETS — mobile context engine'e verilen pratik limitler
 *         (model max'larından küçük; mobile RAM & latency için kısıtlandı)
 */

import type { AIPermissionStatus } from "../permission/PermissionGate";

// ─── Provider ────────────────────────────────────────────────────────────────

export const AIProvider = {
  GOOGLE: "google",
  MICROSOFT: "microsoft",
  ANTHROPIC: "anthropic",
  OPENAI: "openai",
} as const;

export type AIProvider = (typeof AIProvider)[keyof typeof AIProvider];

// ─── Model ID ─────────────────────────────────────────────────────────────────

export const AIModelId = {
  // ── Offline (GGUF, llama.cpp) ─────────────────────────────────────────────
  OFFLINE_GEMMA3_1B: "offline:gemma-3-1b",
  OFFLINE_GEMMA3_4B: "offline:gemma-3-4b",
  OFFLINE_PHI4_MINI: "offline:phi-4-mini",

  // ── Cloud — Anthropic ─────────────────────────────────────────────────────
  CLOUD_CLAUDE_HAIKU_45: "cloud:claude-haiku-4-5",
  CLOUD_CLAUDE_SONNET_46: "cloud:claude-sonnet-4-6",
  CLOUD_CLAUDE_OPUS_46: "cloud:claude-opus-4-6",

  // ── Cloud — OpenAI ────────────────────────────────────────────────────────
  CLOUD_GPT41_MINI: "cloud:gpt-4-1-mini",
  CLOUD_GPT54: "cloud:o4-mini",
} as const;

export type AIModelId = (typeof AIModelId)[keyof typeof AIModelId];

// ─── Model Variant ────────────────────────────────────────────────────────────

export const AIModelVariant = {
  OFFLINE: "offline",
  CLOUD: "cloud",
} as const;

export type AIModelVariant = (typeof AIModelVariant)[keyof typeof AIModelVariant];

// ─── Token Budget ─────────────────────────────────────────────────────────────

/**
 * Context engine'e verilen pratik limitler.
 * Model'in gerçek max context'inden küçük tutulur:
 *   • Mobile RAM baskısı (offline)
 *   • Latency & maliyet optimizasyonu (cloud)
 * § 14.4 ile tutarlı.
 */
export interface TokenBudget {
  /** Context engine'e verilen max (PromptBuilder girdi) */
  contextTokens: number;
  /** API'ye gönderilen max_tokens */
  completionTokens: number;
}

export const TOKEN_BUDGETS: Record<AIModelId, TokenBudget> = {
  // Offline: RAM kısıtlı, küçük pencere
  [AIModelId.OFFLINE_GEMMA3_1B]:      { contextTokens: 2_048,  completionTokens: 512  },
  [AIModelId.OFFLINE_GEMMA3_4B]:      { contextTokens: 4_096,  completionTokens: 1024 },
  [AIModelId.OFFLINE_PHI4_MINI]:      { contextTokens: 4_096,  completionTokens: 1024 },

  // Cloud — Anthropic (gerçek ctx: 200K / 1M beta; mobile için pratik limit)
  [AIModelId.CLOUD_CLAUDE_HAIKU_45]:  { contextTokens: 32_000, completionTokens: 4096 },
  [AIModelId.CLOUD_CLAUDE_SONNET_46]: { contextTokens: 64_000, completionTokens: 8192 },
  [AIModelId.CLOUD_CLAUDE_OPUS_46]:   { contextTokens: 64_000, completionTokens: 8192 },

  // Cloud — OpenAI (gerçek ctx: 1M; mobile için pratik limit)
  [AIModelId.CLOUD_GPT41_MINI]:       { contextTokens: 32_000, completionTokens: 4096 },
  [AIModelId.CLOUD_GPT54]:            { contextTokens: 64_000, completionTokens: 8192 },
};

// ─── GGUF Model Metadata (offline) ───────────────────────────────────────────

export interface GGUFMeta {
  /** HuggingFace repo + filename */
  huggingFaceRepo: string;
  filename: string;
  /** Disk boyutu (MB) — indirme UI için */
  sizeMB: number;
  /** Minimum RAM gereksinimi (MB) */
  minRamMB: number;
  quantization: "Q4_K_M" | "IQ4_XS" | "Q5_K_M";
}

// ─── MLC Model ID Eşleme ──────────────────────────────────────────────────────

/**
 * AIModelId → @react-native-ai/mlc model string eşlemesi.
 *
 * Model seçim kriterleri (Mart 2026, mobil IDE, kodlama ağırlıklı):
 *   • Gemma 3 1B  — Ultra hafif (~700MB), Google mobil optimize, temel tamamlama
 *   • Qwen 2.5 Coder 1.5B — Kodlama/matematik odaklı, Qwen3.5 serisinin stabil kolu
 *   • Phi-4 Mini  — Reasoning-first, Microsoft, TypeScript/JS güçlü (~2.2GB)
 *
 * ⚠️ MLC model ID'leri @react-native-ai/mlc'nin prebuilt registry'sine göre
 *    verilmiştir. Değişiklikler için: https://github.com/callstackincubator/ai
 */
export const MLC_MODEL_IDS: Partial<Record<AIModelId, string>> = {
  [AIModelId.OFFLINE_GEMMA3_1B]: "gemma-3-1b-it-q4f16_1",
  [AIModelId.OFFLINE_GEMMA3_4B]: "Qwen2.5-Coder-1.5B-Instruct-q4f16_1",
  [AIModelId.OFFLINE_PHI4_MINI]: "Phi-4-mini-instruct-q4f16_1",
} as const;

/**
 * AIModelId için MLC model ID'sini döndürür.
 * Bilinmiyorsa apiModelId fallback olarak kullanılır.
 */
export function getMlcModelId(modelId: AIModelId): string | undefined {
  return MLC_MODEL_IDS[modelId];
}

// ─── Model Descriptor ─────────────────────────────────────────────────────────

export interface AIModel {
  id: AIModelId;
  /** UI'da gösterilen ad */
  displayName: string;
  /** Kısa açıklama */
  description: string;
  /** Uzun açıklama (model seçici detay paneli) */
  details: string;
  variant: AIModelVariant;
  provider: AIProvider;
  /**
   * Gerçek API model string'i.
   * Offline için llama.cpp GGUF dosya adı, cloud için provider API ID.
   */
  apiModelId: string;
  /** Hangi permission seviyesinde aktif olur */
  requiredPermission: AIPermissionStatus;
  /** UI'da gösterilen tahmini gecikme */
  latencyHint: "~100-300ms" | "~300-800ms" | "~1-3s" | "~2-5s";
  /** Ağ gerektiriyor mu */
  requiresNetwork: boolean;
  /** Offline modeller için GGUF bilgisi */
  gguf?: GGUFMeta;
  /**
   * Modelin gerçek (provider belgeli) maksimum context penceresi.
   * TOKEN_BUDGETS.contextTokens her zaman bundan küçük veya eşit olmalı.
   */
  maxContextTokens: number;
  maxOutputTokens: number;
}

// ─── AI_MODELS ────────────────────────────────────────────────────────────────

export const AI_MODELS: readonly AIModel[] = [

  // ── Offline: Gemma 3 1B ──────────────────────────────────────────────────
  {
    id: AIModelId.OFFLINE_GEMMA3_1B,
    displayName: "Gemma 3 1B",
    description: "Ultra hafif, anında yanıt — ~700 MB",
    details: "Google'ın en küçük Gemma 3 modeli. Düşük RAM'li cihazlar için ideal. Temel kod tamamlama ve açıklamalar için yeterli.",
    variant: AIModelVariant.OFFLINE,
    provider: AIProvider.GOOGLE,
    apiModelId: "gemma-3-1b-it-q4f16_1",  // MLC model ID (@react-native-ai/mlc)
    requiredPermission: "LOCAL_ONLY",
    latencyHint: "~100-300ms",
    requiresNetwork: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    gguf: {
      huggingFaceRepo: "unsloth/gemma-3-1b-it-GGUF",
      filename: "gemma-3-1b-it-Q4_K_M.gguf",
      sizeMB: 700,
      minRamMB: 1_500,
      quantization: "Q4_K_M",
    },
  },

  // ── Offline: Qwen 2.5 Coder 1.5B ────────────────────────────────────────
  // ⚡ REFACTOR: Gemma 3 4B → Qwen 2.5 Coder 1.5B (kodlama ağırlıklı, daha küçük)
  {
    id: AIModelId.OFFLINE_GEMMA3_4B,
    displayName: "Qwen 2.5 Coder 1.5B",
    description: "Kodlama odaklı — ~1.2 GB, Qwen serisinin güçlü kodu",
    details: "Alibaba'nın Qwen 2.5 Coder serisi. 1.5B parametreye rağmen kod üretimi, tamamlama ve debug'da çok üstün. TypeScript, Python, JavaScript güçlü. 3B+ RAM önerilir.",
    variant: AIModelVariant.OFFLINE,
    provider: AIProvider.GOOGLE,   // MLC registry'de Google provider altında
    apiModelId: "Qwen2.5-Coder-1.5B-Instruct-q4f16_1",  // MLC model ID
    requiredPermission: "LOCAL_ONLY",
    latencyHint: "~100-300ms",
    requiresNetwork: false,
    maxContextTokens: 32_768,
    maxOutputTokens: 8_192,
    gguf: {
      huggingFaceRepo: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF",
      filename: "Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf",
      sizeMB: 1_200,
      minRamMB: 3_000,
      quantization: "Q4_K_M",
    },
  },

  // ── Offline: Phi-4 Mini ──────────────────────────────────────────────────
  {
    id: AIModelId.OFFLINE_PHI4_MINI,
    displayName: "Phi-4 Mini",
    description: "Reasoning odaklı — ~2.4 GB, kod & mantık",
    details: "Microsoft'un Phi-4 Mini modeli. 'Reasoning-first' eğitim ile karmaşık kod görevlerinde 70B modellere rakip. TypeScript & JS desteği güçlü.",
    variant: AIModelVariant.OFFLINE,
    provider: AIProvider.MICROSOFT,
    apiModelId: "Phi-4-mini-instruct-q4f16_1",  // MLC model ID (@react-native-ai/mlc)
    requiredPermission: "LOCAL_ONLY",
    latencyHint: "~300-800ms",
    requiresNetwork: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192,
    gguf: {
      huggingFaceRepo: "unsloth/Phi-4-mini-instruct-GGUF",
      filename: "Phi-4-mini-instruct-Q4_K_M.gguf",
      sizeMB: 2_400,
      minRamMB: 4_000,
      quantization: "Q4_K_M",
    },
  },

  // ── Cloud: Claude Haiku 4.5 ──────────────────────────────────────────────
  {
    id: AIModelId.CLOUD_CLAUDE_HAIKU_45,
    displayName: "Claude Haiku 4.5",
    description: "Hızlı & ekonomik — $1/$5 /MTok",
    details: "Anthropic'in en hızlı modeli. Gerçek zamanlı kod tamamlama, kısa açıklamalar ve yönlendirme görevleri için optimize. 200K context, 64K output.",
    variant: AIModelVariant.CLOUD,
    provider: AIProvider.ANTHROPIC,
    apiModelId: "claude-haiku-4-5-20251001",
    requiredPermission: "CLOUD_ENABLED",
    latencyHint: "~1-3s",
    requiresNetwork: true,
    maxContextTokens: 200_000,
    maxOutputTokens: 64_000,
  },

  // ── Cloud: Claude Sonnet 4.6 ─────────────────────────────────────────────
  {
    id: AIModelId.CLOUD_CLAUDE_SONNET_46,
    displayName: "Claude Sonnet 4.6",
    description: "En iyi fiyat/performans — $3/$15 /MTok",
    details: "Anthropic'in Mart 2026 varsayılan modeli. SWE-bench %79.6, ARC-AGI-2'de 4.3x sıçrama. Karmaşık refactor, debug ve uzun bağlam görevlerinde Opus'a yakın. 200K ctx (1M beta), 64K output.",
    variant: AIModelVariant.CLOUD,
    provider: AIProvider.ANTHROPIC,
    apiModelId: "claude-sonnet-4-6",
    requiredPermission: "CLOUD_ENABLED",
    latencyHint: "~1-3s",
    requiresNetwork: true,
    maxContextTokens: 200_000, // 1M beta ile 1_000_000
    maxOutputTokens: 64_000,
  },

  // ── Cloud: Claude Opus 4.6 ───────────────────────────────────────────────
  {
    id: AIModelId.CLOUD_CLAUDE_OPUS_46,
    displayName: "Claude Opus 4.6",
    description: "En akıllı model — $15/$75 /MTok",
    details: "Anthropic'in en güçlü modeli. SWE-bench %80.8, 128K output. Büyük codebase analizi, mimari kararlar ve karmaşık problem çözme için. Fast mode ile 2.5x hız (ek ücret).",
    variant: AIModelVariant.CLOUD,
    provider: AIProvider.ANTHROPIC,
    apiModelId: "claude-opus-4-6",
    requiredPermission: "CLOUD_ENABLED",
    latencyHint: "~2-5s",
    requiresNetwork: true,
    maxContextTokens: 200_000,
    maxOutputTokens: 128_000,
  },

  // ── Cloud: GPT-4.1 Mini ──────────────────────────────────────────────────
  {
    id: AIModelId.CLOUD_GPT41_MINI,
    displayName: "GPT-4.1 Mini",
    description: "OpenAI ekonomik — 1M token context",
    details: "OpenAI'ın 2025 ekonomik modeli. 1M token context ile büyük dosya analizi. Kod üretimi ve instruction-following'de güçlü. GPT-4o'nun halefi.",
    variant: AIModelVariant.CLOUD,
    provider: AIProvider.OPENAI,
    apiModelId: "gpt-4.1-mini",
    requiredPermission: "CLOUD_ENABLED",
    latencyHint: "~1-3s",
    requiresNetwork: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 32_000,
  },

  // ── Cloud: GPT-5.4 ───────────────────────────────────────────────────────
  {
    id: AIModelId.CLOUD_GPT54,
    displayName: "o4-mini",
    description: "OpenAI flagship — 1M ctx, computer use",
    details: "OpenAI'ın 5 Mart 2026'da yayınlanan en güçlü modeli. 1M token context, native computer control, OSWorld-Verified'da insan performansını geçti. GDPval %83.0.",
    variant: AIModelVariant.CLOUD,
    provider: AIProvider.OPENAI,
    apiModelId: "o4-mini",
    requiredPermission: "CLOUD_ENABLED",
    latencyHint: "~2-5s",
    requiresNetwork: true,
    maxContextTokens: 1_000_000,
    maxOutputTokens: 64_000,
  },

] as const;

// ─── Permission → Model filter ────────────────────────────────────────────────

const PERMISSION_ORDER: Record<AIPermissionStatus, number> = {
  DISABLED: 0,
  LOCAL_ONLY: 1,
  CLOUD_ENABLED: 2,
};

/** Verilen permission seviyesinde kullanılabilir modeller */
export function getAvailableModels(status: AIPermissionStatus): readonly AIModel[] {
  const rank = PERMISSION_ORDER[status];
  return AI_MODELS.filter((m) => PERMISSION_ORDER[m.requiredPermission] <= rank);
}

/** Model var mı ve izinli mi? */
export function isModelAvailable(id: AIModelId, status: AIPermissionStatus): boolean {
  const model = AI_MODELS.find((m) => m.id === id);
  if (!model) return false;
  return PERMISSION_ORDER[model.requiredPermission] <= PERMISSION_ORDER[status];
}

/** Descriptor'ı getir */
export function getModel(id: AIModelId): AIModel | undefined {
  return AI_MODELS.find((m) => m.id === id);
}

/**
 * Default model — izin seviyesine göre önerilen seçim.
 * LOCAL_ONLY → Gemma 3 1B (en hafif, her cihazda çalışır)
 * CLOUD_ENABLED → Claude Sonnet 4.6 (Mart 2026 en iyi fiyat/performans)
 */
export function getDefaultModel(status: AIPermissionStatus): AIModelId | null {
  if (status === "DISABLED") return null;
  if (status === "LOCAL_ONLY") return AIModelId.OFFLINE_GEMMA3_1B;
  return AIModelId.CLOUD_CLAUDE_SONNET_46;
}

/**
 * Provider bazlı gruplama — ModelSelector UI için.
 *
 * Dönüş tipi Map<AIProvider, readonly AIModel[]> ile tutarlı:
 * iç AIModel[] dizisi Map'e eklendikten sonra dışarıya readonly olarak sunulur.
 * Callers slice / spread ile kopyalayabilir, orijinali mutate edemez.
 */
export function getModelsByProvider(
  status: AIPermissionStatus,
): Map<AIProvider, readonly AIModel[]> {
  const available = getAvailableModels(status);
  // Accumulator: mutable (iç birikim), sonuçta readonly olarak yayılır.
  const acc = new Map<AIProvider, AIModel[]>();

  for (const model of available) {
    const arr = acc.get(model.provider) ?? [];
    arr.push(model);
    acc.set(model.provider, arr);
  }

  // Yeni Map üret — value tipi readonly AIModel[] olarak widened.
  const result = new Map<AIProvider, readonly AIModel[]>();
  for (const [provider, models] of acc) {
    result.set(provider, models as readonly AIModel[]);
  }
  return result;
}

// ─── Prompt tipi → model seçici ──────────────────────────────────────────────

/**
 * Prompt'un niteliğine göre en uygun modeli seçer.
 *
 * | Tip          | Tercih edilen                      | Gerekçe                              |
 * |--------------|------------------------------------|--------------------------------------|
 * | code         | Phi-4 Mini (offline) / Sonnet 4.6  | Reasoning-first eğitim, SWE-bench    |
 * | long_context | Claude Sonnet 4.6 / Opus 4.6       | 200K ctx, uzun bağlam tutma          |
 * | quick_answer | Claude Haiku 4.5 / Gemma 3 1B      | Düşük latency, ekonomik              |
 * | offline      | Gemma 3 1B → 4B → Phi-4 Mini       | Sıralı boyut tercihi                 |
 *
 * `status` izin seviyesini, `estimatedInputTokens` bağlam uzunluğunu bildirir.
 * Her zaman kullanılabilir bir model döner; fallback zinciri garanti eder.
 */
export type PromptKind = "code" | "long_context" | "quick_answer" | "offline";

export interface SelectModelOptions {
  kind: PromptKind;
  status: AIPermissionStatus;
  /** Tahmini girdi token sayısı — long_context seçiminde devreye girer */
  estimatedInputTokens?: number;
}

export function selectModelForPrompt(opts: SelectModelOptions): AIModelId | null {
  const { kind, status, estimatedInputTokens = 0 } = opts;

  if (status === "DISABLED") return null;

  // Öncelik listesi — her kind için tercih sırasıyla alternatifler.
  // İlk kullanılabilir model seçilir.
  const PREFERENCE: Record<PromptKind, readonly AIModelId[]> = {

    /**
     * code — reasoning-first modeller önce.
     * Offline: Phi-4 Mini (reasoning), Gemma3-4B, Gemma3-1B
     * Cloud:   Sonnet 4.6 (SWE-bench %79.6), Haiku 4.5, Opus 4.6
     */
    code: [
      AIModelId.OFFLINE_PHI4_MINI,
      AIModelId.CLOUD_CLAUDE_SONNET_46,
      AIModelId.OFFLINE_GEMMA3_4B,
      AIModelId.CLOUD_CLAUDE_HAIKU_45,
      AIModelId.CLOUD_CLAUDE_OPUS_46,
      AIModelId.OFFLINE_GEMMA3_1B,
      AIModelId.CLOUD_GPT41_MINI,
      AIModelId.CLOUD_GPT54,
    ],

    /**
     * long_context — büyük context penceresi önce.
     * estimatedInputTokens > 32K → Sonnet/Opus/GPT-5.4 zorunlu.
     * Cloud: Sonnet 4.6 (200K) → Opus 4.6 (200K) → GPT-5.4 (1M) → GPT-4.1 Mini
     * Offline: Gemma3-4B (128K ctx) → Phi-4 Mini → Gemma3-1B
     */
    long_context: [
      AIModelId.CLOUD_CLAUDE_SONNET_46,
      AIModelId.CLOUD_CLAUDE_OPUS_46,
      AIModelId.CLOUD_GPT54,
      AIModelId.CLOUD_GPT41_MINI,
      AIModelId.OFFLINE_GEMMA3_4B,
      AIModelId.OFFLINE_PHI4_MINI,
      AIModelId.CLOUD_CLAUDE_HAIKU_45,
      AIModelId.OFFLINE_GEMMA3_1B,
    ],

    /**
     * quick_answer — düşük latency, ekonomik.
     * Cloud: Haiku 4.5 (~1-3s, $1/$5 /MTok) → GPT-4.1 Mini → Sonnet 4.6
     * Offline: Gemma3-1B (~100-300ms) → Gemma3-4B → Phi-4 Mini
     */
    quick_answer: [
      AIModelId.CLOUD_CLAUDE_HAIKU_45,
      AIModelId.OFFLINE_GEMMA3_1B,
      AIModelId.CLOUD_GPT41_MINI,
      AIModelId.OFFLINE_GEMMA3_4B,
      AIModelId.CLOUD_CLAUDE_SONNET_46,
      AIModelId.OFFLINE_PHI4_MINI,
      AIModelId.CLOUD_CLAUDE_OPUS_46,
      AIModelId.CLOUD_GPT54,
    ],

    /**
     * offline — ağsız, boyut sırasıyla.
     * Gemma3-1B (700MB) → Gemma3-4B (2.5GB) → Phi-4 Mini (2.4GB)
     * Hiçbiri yoksa cloud'a düşer (status CLOUD_ENABLED ise).
     */
    offline: [
      AIModelId.OFFLINE_GEMMA3_1B,
      AIModelId.OFFLINE_GEMMA3_4B,
      AIModelId.OFFLINE_PHI4_MINI,
      // Fallback — kullanıcı offline mod istedi ama LOCAL_ONLY izni yoksa cloud:
      AIModelId.CLOUD_CLAUDE_HAIKU_45,
      AIModelId.CLOUD_GPT41_MINI,
      AIModelId.CLOUD_CLAUDE_SONNET_46,
    ],
  };

  let candidates: readonly AIModelId[] = PREFERENCE[kind] ?? [];
  if (!candidates) candidates = [];

  // long_context: tahmini girdi > 32K token → küçük offline modelleri eleme
  if (kind === "long_context" && estimatedInputTokens > 32_000) {
    candidates = candidates.filter((id) => {
      const model = getModel(id);
      return model && model.maxContextTokens > 32_000;
    });
  }

  // İlk kullanılabilir model
  for (const id of candidates) {
    if (isModelAvailable(id, status)) return id;
  }

  // Son fallback — izin seviyesindeki herhangi bir model
  return getDefaultModel(status);
}

// ─── TOKEN_BUDGETS integrity guard ───────────────────────────────────────────

/**
 * Context token'ların model max'ını aşmamasını doğrular.
 * Geliştirme sırasında çağrılır; üretimde tree-shaking ile düşer.
 */
export function assertBudgetIntegrity(): void {
  for (const model of AI_MODELS) {
    const budget = TOKEN_BUDGETS[model.id];
    if (budget.contextTokens > model.maxContextTokens) {
      throw new Error(
        `Budget integrity: ${model.id} contextTokens (${budget.contextTokens}) > model max (${model.maxContextTokens})`,
      );
    }
    if (budget.completionTokens > model.maxOutputTokens) {
      throw new Error(
        `Budget integrity: ${model.id} completionTokens (${budget.completionTokens}) > model max (${model.maxOutputTokens})`,
      );
    }
  }
}
