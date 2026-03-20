/**
 * hooks/useModelSelector.ts — Phase 12: OTA update badge entegrasyonu
 *
 * DÜZELTME #3 — Her render'da yeni Set oluşturuluyordu:
 *   ❌ updatableModels = new Set<AIModelId>()  (default param)
 *      Her render'da yeni referans → useCallback([updatableModels]) dependency
 *      her seferinde değişir → hasUpdate her render'da yeni fonksiyon →
 *      FlatList/memo bileşenler gereksiz re-render.
 *
 *   ✅ EMPTY_SET modül sabiti — tek referans, asla değişmez.
 *      Default param değeri olarak kullanılır → referans stabilitesi korunur.
 *
 * § 3  : IEventBus unsub cleanup
 * § 14.6 : usePermissionGate entegrasyonu
 *
 * REFACTOR — PermissionStatus → AIPermissionStatus (doğru tip adı)
 *   AppEventMap'e "permission:status:changed" eklendi (types/core.ts)
 */

import { useState, useEffect, useCallback } from "react";
import type { IEventBus }                   from "../core/EventBus";
import type { IPermissionGate, AIPermissionStatus } from "../permission/PermissionGate";
import type { AIModelId, AIModel }          from "../ai/AIModels";
import { getAvailableModels, getDefaultModel, isModelAvailable } from "../ai/AIModels";

// ─── ✅ DÜZELTME #3: Modül sabiti — her render'da yeni referans yok ──────────
const EMPTY_SET: ReadonlySet<AIModelId> = new Set<AIModelId>();

// ─── Tipler ───────────────────────────────────────────────────────────────────

export interface ModelSelectorState {
  availableModels:          readonly AIModel[];
  selectedModelId:          AIModelId | null;
  permissionStatus:         AIPermissionStatus;
  isSelectedModelAvailable: boolean;
  updatableModels:          ReadonlySet<AIModelId>;
  hasUpdate(modelId: AIModelId): boolean;
}

export interface ModelSelectorActions {
  selectModel(id: AIModelId): void;
}

export interface UseModelSelectorOptions {
  permissionGate:   IPermissionGate;
  eventBus:         IEventBus;
  /** ✅ DÜZELTME #3: geçirilmezse EMPTY_SET — yeni referans yok */
  updatableModels?: ReadonlySet<AIModelId>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useModelSelector(
  opts: UseModelSelectorOptions,
): ModelSelectorState & ModelSelectorActions {
  const {
    permissionGate,
    eventBus,
    // ✅ DÜZELTME #3: new Set() değil EMPTY_SET — stabil referans
    updatableModels = EMPTY_SET,
  } = opts;

  const [permissionStatus, setPermissionStatus] = useState<AIPermissionStatus>(
    () => permissionGate.getStatus(),
  );
  const [selectedModelId, setSelectedModelId] = useState<AIModelId | null>(
    () => getDefaultModel(permissionGate.getStatus()),
  );

  // ─── Permission değişimi ──────────────────────────────────────────────────

  useEffect(() => {
    const unsub = eventBus.on(
      "permission:status:changed",
      (payload: { status: AIPermissionStatus }) => {
        const newStatus = payload.status;
        setPermissionStatus(newStatus);
        setSelectedModelId((prev) => {
          if (prev && isModelAvailable(prev, newStatus)) return prev;
          return getDefaultModel(newStatus);
        });
      },
    );
    return () => unsub();
  }, [eventBus]);

  // ─── Dışarıdan model değişimi ─────────────────────────────────────────────

  useEffect(() => {
    const unsub = eventBus.on(
      "ai:model:changed",
      (payload: { modelId: AIModelId }) => {
        setSelectedModelId(payload.modelId);
      },
    );
    return () => unsub();
  }, [eventBus]);

  // ─── selectModel ─────────────────────────────────────────────────────────

  const selectModel = useCallback(
    (id: AIModelId) => {
      setSelectedModelId(id);
      eventBus.emit("ai:model:changed", { modelId: id });
    },
    [eventBus],
  );

  // ─── hasUpdate ───────────────────────────────────────────────────────────

  const hasUpdate = useCallback(
    (modelId: AIModelId) => updatableModels.has(modelId),
    [updatableModels],
  );

  // ─── Türetilmiş değerler ──────────────────────────────────────────────────

  const availableModels          = getAvailableModels(permissionStatus);
  const isSelectedModelAvailable = selectedModelId != null &&
    isModelAvailable(selectedModelId, permissionStatus);

  return {
    availableModels,
    selectedModelId,
    permissionStatus,
    isSelectedModelAvailable,
    updatableModels,
    hasUpdate,
    selectModel,
  };
}
