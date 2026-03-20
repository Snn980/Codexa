/**
 * ai/model/ModelRegistry.ts
 *
 * ModelKey → IModelRunner çözümleyici.
 * Phase 5.1 — Model Loader (rev 2)
 *
 * Değişiklikler (rev 2):
 *  • IModelRunner rev2 interface'e uyum (cancel, estimateTokens, activeRunIds)
 *  • listModels() ModelMeta.modelPath alanını da döner (rev2 meta)
 *
 * Kural referansları:
 *  § 1  Result<T> / ok() / err()
 *  § 4  AppContainer singleton — registry createApp() ile DI'dan alır
 *  § 14.6  PermissionGate — variant kontrolü burada yapılır
 */

import type { IModelRunner, ModelKey, ModelMeta, RunnerVariant } from "./IModelRunner";
import { ModelErrorCode } from "./IModelRunner";
import type { Result } from "../../core/Result";
import { ok, err } from "../../core/Result";

// ─── Registry config ──────────────────────────────────────────────────────

export interface ModelRegistryConfig {
  /**
   * İzin verilen variant'lar.
   * PermissionGate durumu değiştiğinde `setAllowedVariants()` çağrılır.
   */
  allowedVariants: ReadonlySet<RunnerVariant>;
}

// ─── Resolve result ───────────────────────────────────────────────────────

export interface ResolveResult {
  runner: IModelRunner;
  /** Gerçekte kullanılacak model (fallback olduysa farklı olabilir) */
  resolvedKey: ModelKey;
  /** İstenen ile çözülen farklıysa true */
  isFallback: boolean;
}

// ─── ModelRegistry ────────────────────────────────────────────────────────

export class ModelRegistry {
  private readonly _runners: IModelRunner[] = [];
  /** modelKey → runner hızlı lookup */
  private readonly _keyIndex = new Map<ModelKey, IModelRunner>();
  private _allowedVariants: Set<RunnerVariant>;
  private _disposed = false;

  constructor(config: ModelRegistryConfig) {
    this._allowedVariants = new Set(config.allowedVariants);
  }

  // ─── Runner yönetimi ──────────────────────────────────────────────────

  /**
   * Runner'ı kaydeder ve desteklediği tüm modelleri index'e ekler.
   * Aynı key'e sahip farklı runner kaydedilirse hata döner.
   */
  register(runner: IModelRunner): Result<void> {
    if (this._disposed) {
      return err(ModelErrorCode.INVALID_RUNNER_CONFIG, "Registry disposed");
    }

    for (const model of runner.supportedModels) {
      if (this._keyIndex.has(model.key)) {
        return err(
          ModelErrorCode.INVALID_RUNNER_CONFIG,
          `Duplicate model key: ${model.key}`,
          { context: { key: model.key } },
        );
      }
    }

    this._runners.push(runner);
    for (const model of runner.supportedModels) {
      this._keyIndex.set(model.key, runner);
    }

    return ok(undefined);
  }

  /**
   * İzin verilen variant setini günceller.
   * PermissionGate DISABLED → LOCAL_ONLY: offline eklenir.
   * LOCAL_ONLY → CLOUD_ENABLED: cloud da eklenir.
   */
  setAllowedVariants(variants: ReadonlySet<RunnerVariant>): void {
    this._allowedVariants = new Set(variants);
  }

  // ─── Resolve ──────────────────────────────────────────────────────────

  /**
   * İstenen `key` için uygun runner'ı döner.
   *
   * Öncelik:
   *  1. Tam key eşleşmesi (variant izinliyse)
   *  2. Aynı variantta fallback model
   *  3. Hata
   */
  resolve(key: ModelKey): Result<ResolveResult> {
    if (this._disposed) {
      return err(ModelErrorCode.MODEL_NOT_LOADED, "Registry disposed");
    }

    const directRunner = this._keyIndex.get(key);

    if (directRunner) {
      if (!this._allowedVariants.has(directRunner.variant)) {
        return err(
          ModelErrorCode.INFERENCE_FAILED,
          `Variant '${directRunner.variant}' is not allowed by permission gate`,
          { context: { key, variant: directRunner.variant } },
        );
      }
      return ok({ runner: directRunner, resolvedKey: key, isFallback: false });
    }

    // Key kayıtlı değil — fallback arama
    const requestedVariant = this._guessVariant(key);
    const fallback = this._findFallback(requestedVariant);

    if (fallback) {
      return ok({ runner: fallback.runner, resolvedKey: fallback.key, isFallback: true });
    }

    return err(
      ModelErrorCode.MODEL_NOT_LOADED,
      `No runner found for model key: ${key}`,
      { context: { key } },
    );
  }

  /**
   * Tüm kayıtlı model meta listesi.
   * İzin verilmeyen variant'lar da dahildir — UI kendi filtreyini yapabilir.
   */
  listModels(): ReadonlyArray<ModelMeta> {
    return this._runners.flatMap((r) => [...r.supportedModels]);
  }

  /** Yalnızca izin verilen variant'lara ait modeller */
  listAllowedModels(): ReadonlyArray<ModelMeta> {
    return this.listModels().filter((m) => this._allowedVariants.has(m.variant));
  }

  // ─── Dispose ──────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;

    await Promise.all(this._runners.map((r) => r.dispose().catch(() => {})));
    this._runners.length = 0;
    this._keyIndex.clear();
  }

  // ─── private ──────────────────────────────────────────────────────────

  private _guessVariant(key: ModelKey): RunnerVariant {
    if (key.startsWith("claude-") || key.startsWith("gpt-")) {
      return "cloud" as RunnerVariant;
    }
    return "offline" as RunnerVariant;
  }

  private _findFallback(
    variant: RunnerVariant,
  ): { runner: IModelRunner; key: ModelKey } | null {
    if (!this._allowedVariants.has(variant)) return null;

    for (const runner of this._runners) {
      if (runner.variant === variant) {
        const first = runner.supportedModels[0];
        if (first) return { runner, key: first.key };
      }
    }
    return null;
  }
}
