import type { ContextCollector, EditorSnapshot } from "./ContextCollector";
import type { ContextRanker } from "./ContextRanker";
import type { TokenLimiter, BudgetOverride } from "./TokenLimiter";
import type { PromptBuilder, BuiltPrompt } from "./PromptBuilder";
import type { IPermissionGate } from "../permission/PermissionGate";

export interface IEngineLogger {
  warn(msg: string):  void;
  debug(msg: string): void;
}

export interface EngineRunOptions {
  variant:    "offline" | "cloud";
  userPrompt: string;
  model?:     string;
  budget?:    BudgetOverride & { model?: string; maxTokens?: number; reserveForOutput?: number };
  history?:   Array<{ role: "user" | "assistant"; content: string }>;
}

export interface PipelineStats {
  collectedCount:  number;
  droppedCount:    number;
  tokensUsed:      number;
  tokensAvailable: number;
  contextHash:     number;
  cacheHit:        boolean;
  anyTruncated:    boolean;
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
  // Offline
  "offline",
  // Cloud default
  "cloud-default",
  // Claude 4.x — AIModelId formatı ("cloud:*")
  "cloud:claude-haiku-4-5",
  "cloud:claude-sonnet-4-6",
  "cloud:claude-opus-4-6",
  // Claude 4.x — apiModelId formatı
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  // Geriye dönük uyumluluk (deprecation: Phase 22)
  "claude-3-haiku", "claude-3-sonnet", "claude-3-opus",
]);

export type EngineResult =
  | { ok: true;  data: EngineRunResult; error?: undefined }
  | { ok: false; error: { code: string; message: string }; data?: undefined };

export class ContextEngine {
  private readonly _deps: ContextEngineDeps;
  private _lastHash = 0;

  constructor(deps: ContextEngineDeps) {
    this._deps = deps;
  }

  async run(
    snapshot: EditorSnapshot,
    opts:     EngineRunOptions,
  ): Promise<EngineResult> {
    const { permissionGate, collector, ranker, limiter, builder, logger } = this._deps;

    // Permission check
    if (!permissionGate.isAllowed(opts.variant)) {
      const status = permissionGate.getStatus();
      const state = typeof status === "object" && "state" in status
        ? (status as { state: string }).state
        : String(status);
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
    const prompt = builder.build(limitResult.items, this._sanitizePrompt(opts.userPrompt), opts.variant);

    const contextHash = fnv1a(
      limitResult.items.map((i) => i.id + i.content.slice(0, 50)).join("|"),
    );

    const cacheHit = this._lastHash === contextHash;
    this._lastHash = contextHash;

    // Inject history before user message (cloud multi-turn)
    if (opts.history?.length) {
      prompt.messages = [...opts.history, ...prompt.messages];
    }

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
          cacheHit,
          anyTruncated:    limitResult.anyTruncated,
        },
      },
    };
  }

  private _sanitize(snapshot: EditorSnapshot): EditorSnapshot {
    const sanitized = snapshot.activeContent
      .replace(/ignore previous instructions?/gi, "[REDACTED]")
      .replace(/disregard prior instructions?/gi, "[REDACTED]")
      .replace(/you are now\b/gi, "[REDACTED]")
      .replace(/act as\b/gi, "[REDACTED]")
      .replace(/pretend to be\b/gi, "[REDACTED]")
      .replace(/<s>/gi, "[REDACTED]")
      .replace(/\u0000/g, "")
      .replace(/[\u202A-\u202E\u2066-\u2069]/g, "");

    const openTabs = (snapshot.openTabs ?? []).filter((t) => {
      const label = (t.label ?? "").toLowerCase();
      return !label.endsWith(".env") &&
             !label.endsWith(".secret") &&
             !label.endsWith(".pem") &&
             !label.includes(".env.");
    });

    return { ...snapshot, activeContent: sanitized, openTabs };
  }

  private _sanitizePrompt(userPrompt: string): string {
    return userPrompt
      .replace(/ignore previous instructions?/gi, "[REDACTED]")
      .replace(/disregard prior instructions?/gi, "[REDACTED]")
      .replace(/you are now\b/gi, "[REDACTED]")
      .replace(/act as\b/gi, "[REDACTED]")
      .replace(/pretend to be\b/gi, "[REDACTED]")
      .replace(/<s>/gi, "[REDACTED]")
      .replace(/\u0000/g, "")
      .replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
  }
}
