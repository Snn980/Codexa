import { AIPermissionState } from "./permission_types";

export type { AIPermissionState };

export interface IPermissionGate {
  init(): Promise<{ ok: boolean; data: undefined }>;
  getStatus(): { state: AIPermissionState; consent: null; changedAt: string };
  isAllowed(variant: "offline" | "cloud"): boolean;
  transition(state: AIPermissionState): void;
  dispose(): void;
}
