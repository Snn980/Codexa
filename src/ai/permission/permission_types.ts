export const AIPermissionState = {
  Disabled:     "Disabled",
  LocalOnly:    "LocalOnly",
  CloudEnabled: "CloudEnabled",
} as const;
export type AIPermissionState = (typeof AIPermissionState)[keyof typeof AIPermissionState];
