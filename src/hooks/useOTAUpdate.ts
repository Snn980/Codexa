/**
 * hooks/useOTAUpdate.ts — Periyodik OTA güncelleme kontrolü
 *
 * DÜZELTME #1 — checkNow stale closure:
 *   ❌ if (checking) return  →  checking React state'i
 *      useCallback dep'i [container, checking] → her state değişiminde
 *      yeni fonksiyon referansı → timer/effect chain yeniden kurulur.
 *      Ayrıca: iki eş zamanlı çağrı arasında state güncellenmemişse
 *      ikincisi de geçer (stale closure).
 *
 *   ✅ checkingRef = useRef(false) → senkron, closure'dan bağımsız.
 *      useCallback dep'i sadece [container] → stabil referans.
 *      finally garantisi: hem ref hem state sıfırlanır.
 *
 * DÜZELTME #2 — eventBus entegrasyonu eksikti:
 *   ❌ model:download:complete → updatableModels'dan model çıkarılmıyordu.
 *      İndirme tamamlanınca badge kalıyordu.
 *
 *   ✅ container.eventBus (public getter, Phase 12 AppContainer) üzerinden
 *      model:download:complete dinlenir → modelId set'ten çıkarılır.
 *      Unsub: useEffect cleanup'ında.
 *
 * § 3  : IEventBus unsub cleanup
 * § 8  : useRef timer cleanup
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { AppState, type AppStateStatus }            from "react-native";
import type { AIModelId }                           from "../ai/AIModels";
import type { UpdateCheckResult }                   from "../ota/ModelVersionManifest";
import type { AppContainer }                        from "../app/AppContainer";

// ─── Tipler ───────────────────────────────────────────────────────────────────

export interface OTAUpdateState {
  updatableModels: ReadonlySet<AIModelId>;
  lastCheckedAt:   number | null;
  checking:        boolean;
  lastError:       string | null;
}

export interface OTAUpdateActions {
  checkNow(): Promise<void>;
  getUpdateEntry(modelId: AIModelId): UpdateCheckResult | undefined;
}

export interface UseOTAUpdateOptions {
  container:   AppContainer;
  intervalMs?: number;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useOTAUpdate(
  opts: UseOTAUpdateOptions,
): OTAUpdateState & OTAUpdateActions {
  const { container, intervalMs } = opts;

  const [updatableModels, setUpdatableModels] = useState<ReadonlySet<AIModelId>>(
    () => new Set(),
  );
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [checking,      setChecking]      = useState(false);
  const [lastError,     setLastError]     = useState<string | null>(null);

  const resultsRef    = useRef<UpdateCheckResult[]>([]);
  const timerRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef   = useRef<AppStateStatus>("active");
  // ✅ DÜZELTME #1: ref ile senkron guard — stale closure yok
  const checkingRef   = useRef(false);

  // ─── checkNow ─────────────────────────────────────────────────────────────

  const checkNow = useCallback(async (): Promise<void> => {
    // ✅ DÜZELTME #1: ref kontrolü — state'e bağlı değil
    if (checkingRef.current) return;

    checkingRef.current = true;
    setChecking(true);
    setLastError(null);

    try {
      const result = await container.checkForModelUpdates();
      if (!result) return;

      if (!result.ok) {
        setLastError((result as any).message ?? (result as any).code ?? "Bilinmeyen hata");
        return;
      }

      const results = (result as any).data as UpdateCheckResult[];
      resultsRef.current = results;

      const updatable = new Set<AIModelId>(
        results
          .filter((r) => r.status === "update-available")
          .map((r) => r.modelId),
      );
      setUpdatableModels(updatable);
      setLastCheckedAt(Date.now());
    } catch (e) {
      setLastError(String(e));
    } finally {
      // ✅ DÜZELTME #1: finally'de her ikisi de sıfırlanır
      checkingRef.current = false;
      setChecking(false);
    }
  // ✅ DÜZELTME #1: dep listesinden `checking` kaldırıldı — stabil referans
  }, [container]);

  // ─── Periyodik timer ──────────────────────────────────────────────────────

  useEffect(() => {
    void checkNow();

    const interval = intervalMs ?? 0;
    if (interval <= 0) return;

    timerRef.current = setInterval(() => {
      if (appStateRef.current !== "active") return;
      void checkNow();
    }, interval);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [container, intervalMs, checkNow]);

  // ─── AppState listener ────────────────────────────────────────────────────

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      appStateRef.current = next;
    });
    return () => sub.remove();
  }, []);

  // ─── DÜZELTME #2: eventBus — download complete → badge temizle ───────────

  useEffect(() => {
    if (!container.isReady) return;

    const unsub = container.eventBus.on(
      "model:download:complete",
      ({ modelId: _modelId }: { modelId: string }) => {
        const modelId = _modelId as AIModelId;
        setUpdatableModels((prev) => {
          if (!prev.has(modelId)) return prev; // referans değişmesin
          const next = new Set(prev);
          next.delete(modelId);
          return next;
        });
      },
    );

    return () => unsub();
  }, [container]);

  // ─── getUpdateEntry ───────────────────────────────────────────────────────

  const getUpdateEntry = useCallback(
    (modelId: AIModelId): UpdateCheckResult | undefined =>
      resultsRef.current.find((r) => r.modelId === modelId),
    [],
  );

  return {
    updatableModels,
    lastCheckedAt,
    checking,
    lastError,
    checkNow,
    getUpdateEntry,
  };
}
