import type { RankedItem } from "./ContextRanker";

export const TOKEN_BUDGETS: Record<string, { maxTokens: number; reserveForOutput: number }> = {
  // ─── Offline (local GGUF) ──────────────────────────────────────────────────
  "offline":                    { maxTokens: 2048,   reserveForOutput: 512  },

  // ─── Cloud fallback ────────────────────────────────────────────────────────
  "cloud-default":              { maxTokens: 8192,   reserveForOutput: 1024 },

  // ─── Claude 4.x (güncel) ──────────────────────────────────────────────────
  // AIModelId değerleri: "cloud:claude-haiku-4-5" vb.
  // apiModelId değerleri: "claude-haiku-4-5-20251001" vb.
  // Her iki key de desteklenir — ContextEngine opts.model olarak iletebilir.
  "cloud:claude-haiku-4-5":     { maxTokens: 32_000, reserveForOutput: 4096  },
  "claude-haiku-4-5-20251001":  { maxTokens: 32_000, reserveForOutput: 4096  },

  "cloud:claude-sonnet-4-6":    { maxTokens: 64_000, reserveForOutput: 8192  },
  "claude-sonnet-4-6":          { maxTokens: 64_000, reserveForOutput: 8192  },

  "cloud:claude-opus-4-6":      { maxTokens: 64_000, reserveForOutput: 8192  },
  "claude-opus-4-6":            { maxTokens: 64_000, reserveForOutput: 8192  },

  // ─── Eski Claude 3 key'leri — geriye dönük uyumluluk ─────────────────────
  // Yeni projeler bu key'leri kullanmamalı; kaldırılacak (deprecation: Phase 22)
  "claude-3-haiku":             { maxTokens: 32_000, reserveForOutput: 2048  },
  "claude-3-sonnet":            { maxTokens: 32_000, reserveForOutput: 2048  },
  "claude-3-opus":              { maxTokens: 32_000, reserveForOutput: 2048  },

  // ─── Test sabitleri ────────────────────────────────────────────────────────
  "tiny":                       { maxTokens: 100,    reserveForOutput: 10    },
};

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface LimitResult {
  items:           RankedItem[];
  droppedCount:    number;
  tokensUsed:      number;
  tokensAvailable: number;
  anyTruncated:    boolean;
}

export interface BudgetOverride {
  model?:           string;
  maxTokens?:       number;
  reserveForOutput?: number;
}

export class TokenLimiter {
  limit(
    items:    RankedItem[],
    variant:  "offline" | "cloud",
    modelKey?: string,
    budgetOverride?: BudgetOverride,
  ): LimitResult {
    let budget: { maxTokens: number; reserveForOutput: number };

    if (budgetOverride?.maxTokens !== undefined) {
      budget = {
        maxTokens:       budgetOverride.maxTokens,
        reserveForOutput: budgetOverride.reserveForOutput ?? 256,
      };
    } else if (modelKey && TOKEN_BUDGETS[modelKey]) {
      budget = TOKEN_BUDGETS[modelKey]!;
    } else {
      budget = variant === "offline" ? TOKEN_BUDGETS["offline"]! : TOKEN_BUDGETS["cloud-default"]!;
    }

    const tokensAvailable = budget.maxTokens - budget.reserveForOutput;
    const kept: RankedItem[] = [];
    let used = 0;
    let droppedCount  = 0;
    let anyTruncated  = false;

    for (const item of items) {
      const cost = estimateTokens(item.content);
      if (used + cost <= tokensAvailable) {
        kept.push(item);
        used += cost;
      } else {
        const remaining = tokensAvailable - used;
        if (remaining > 20) {
          // Partial fit: truncate content to remaining token budget
          const charBudget = remaining * CHARS_PER_TOKEN;
          const truncated  = item.content.slice(0, charBudget) + "\n[truncated]";
          kept.push({ ...item, content: truncated });
          used        += remaining;
          anyTruncated = true;
        } else {
          droppedCount++;
        }
        // Once we can't fully fit, remaining items are dropped
        droppedCount += items.length - kept.length - droppedCount;
        break;
      }
    }

    return { items: kept, droppedCount, tokensUsed: used, tokensAvailable, anyTruncated };
  }
}
