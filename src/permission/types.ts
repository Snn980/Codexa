/**
 * permission/types.ts — Geriye dönük uyumluluk barrel.
 *
 * Canonical konum: src/permission/PermissionGate.ts (AIPermissionStatus)
 *                  src/types/core.ts (AIPermissionState)
 *
 * REFACTOR (SORUN-9): Üçlü AIPermissionStatus/State tanımı tek kaynağa indirildi.
 *   - AIPermissionStatus : 'DISABLED' | 'LOCAL_ONLY' | 'CLOUD_ENABLED'  ← PermissionGate.ts
 *   - AIPermissionState  : "Disabled" | "LocalOnly" | "CloudEnabled"    ← core.ts (legacy)
 *
 * Yeni kodlar doğrudan "@/permission/PermissionGate" veya "@/types/core" import etmeli.
 */
export type { AIPermissionStatus } from './PermissionGate';
export type { AIPermissionState }  from '../types/core';
