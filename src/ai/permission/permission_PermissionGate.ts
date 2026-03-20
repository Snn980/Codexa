/**
 * ai/permission/permission_PermissionGate.ts — Geriye dönük uyumluluk barrel.
 *
 * Canonical konum: src/permission/PermissionGate.ts
 *
 * REFACTOR (SORUN-9): Duplike IPermissionGate tanımı kaldırıldı.
 */
export type { AIPermissionState }  from '../../types/core';
export type { AIPermissionStatus } from '../../permission/PermissionGate';
export type { IPermissionGate }    from '../../permission/PermissionGate';
