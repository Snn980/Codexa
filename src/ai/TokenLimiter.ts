import type { RankedItem } from "./ContextRanker";

export const TOKEN_BUDGETS: Record<string, { maxTokens: number; reserveForOutput: number }> = {
  "offline":           { maxTokens: 2048,  reserveForOutput: 512  },
  "cloud-default":     { maxTokens: 8192,  reserveForOutput: 1024 },
  "claude-3-haiku":    { maxTokens: 32000, reserveForOutput: 2048 },
  "claude-3-sonnet":   { maxTokens: 32000, reserveForOutput: 2048 },
  "claude-3-opus":     { maxTokens: 32000, reserveForOutput: 2048 },
  "tiny":              { maxTokens: 100,   reserveForOutput: 10   },
};

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface LimitResult {
  items:       RankedItem[];
  droppedCount: number;
  tokensUsed:   number;
  tokensAvailable: number;
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
    let droppedCount = 0;

    for (const item of items) {
      const cost = estimateTokens(item.content);
      if (used + cost <= tokensAvailable) {
        kept.push(item);
        used += cost;
      } else {
        droppedCount++;
      }
    }

    return { items: kept, droppedCount, tokensUsed: used, tokensAvailable };
  }
}
