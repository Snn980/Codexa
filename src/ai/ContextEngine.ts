import type { ContextCollector, EditorSnapshot } from "./ContextCollector";
import type { ContextRanker } from "./ContextRanker";
import type { TokenLimiter, BudgetOverride } from "./TokenLimiter";
import type { PromptBuilder, BuiltPrompt } from "./PromptBuilder";
import type { IPermissionGate } from "./permission/PermissionGate";

export interface IEngineLogger {
  warn(msg: string):  void;
  debug(msg: string): void;
}

export interface EngineRunOptions {
  variant:    "offline" | "cloud";
  userPrompt: string;
  model?:     string;
  budget?:    BudgetOverride & { model?: string; maxTokens?: number; reserveForOutput?: number };
}

export interface PipelineStats {
  collectedCount:  number;
  droppedCount:    number;
  tokensUsed:      number;
  tokensAvailable: number;
  contextHash:     number;
}

export interface EngineRunResult {
  prompt: BuiltPrompt;
  stats:  PipelineStats;
}

export interface ContextEngineDeps {
  permissionGate: IPermissionGate;
  collector:      ContextCollector;
  ranker:         ContextRanker;
  limiter:        TokenLimiter;
  builder:        PromptBuilder;
  logger?:        IEngineLogger;
}

function fnv1a(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h || 1;
}

const KNOWN_MODEL_KEYS = new Set([
  "offline", "cloud-default",
  "claude-3-haiku", "claude-3-sonnet", "claude-3-opus",
]);

export class ContextEngine {
  private readonly _deps: ContextEngineDeps;

  constructor(deps: ContextEngineDeps) {
    this._deps = deps;
  }

  async run(
    snapshot: EditorSnapshot,
    opts:     EngineRunOptions,
  ): Promise<
    | { ok: true;  data: EngineRunResult }
    | { ok: false; error: { code: string; message: string } }
  > {
    const { permissionGate, collector, ranker, limiter, builder, logger } = this._deps;

    // Permission check
    if (!permissionGate.isAllowed(opts.variant)) {
      const state = permissionGate.getStatus().state;
      return {
        ok:    false,
        error: { code: "AI_PERMISSION_DENIED", message: `Permission denied: current state is ${state}` },
      };
    }

    // Model key resolution
    let modelKey = opts.model ?? (opts.variant === "offline" ? "offline" : "cloud-default");
    if (opts.model && !KNOWN_MODEL_KEYS.has(opts.model)) {
      logger?.warn(`Unknown model key: ${opts.model}, falling back to default`);
      modelKey = opts.variant === "offline" ? "offline" : "cloud-default";
    }

    // Sanitize snapshot (jailbreak / .env exclusion handled in collector)
    const sanitizedSnapshot = this._sanitize(snapshot);

    // Pipeline: Collect → Rank → Limit → Build
    const collected    = await collector.collect(sanitizedSnapshot);
    const ranked       = await ranker.rank(collected, sanitizedSnapshot);
    const budgetOvr    = opts.budget;
    const limitResult  = limiter.limit(ranked, opts.variant, modelKey, budgetOvr);
    const prompt       = builder.build(limitResult.items, opts.userPrompt, opts.variant);

    const contextHash = fnv1a(
      limitResult.items.map((i) => i.id + i.content.slice(0, 50)).join("|"),
    );

    return {
      ok: true,
      data: {
        prompt,
        stats: {
          collectedCount:  collected.length,
          droppedCount:    limitResult.droppedCount,
          tokensUsed:      limitResult.tokensUsed,
          tokensAvailable: limitResult.tokensAvailable,
          contextHash,
        },
      },
    };
  }

  private _sanitize(snapshot: EditorSnapshot): EditorSnapshot {
    // Strip jailbreak injections from activeContent
    const sanitized = snapshot.activeContent
      .replace(/ignore previous instructions?/gi, "[REDACTED]")
      .replace(/you are now/gi, "[REDACTED]");

    // Filter .env/.secret tabs
    const openTabs = (snapshot.openTabs ?? []).filter((t) => {
      const label = t.label ?? "";
      return !label.endsWith(".env") && !label.endsWith(".secret");
    });

    return { ...snapshot, activeContent: sanitized, openTabs };
  }
}
