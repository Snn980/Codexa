/** Sandbox güvenlik sabitleri */
export const SECURITY_LIMITS = {
  MEMORY_MAX_BYTES:           50 * 1024 * 1024,   // 50 MB
  STACK_MAX_BYTES:             4 * 1024 * 1024,   //  4 MB
  MIN_EXECUTION_TIMEOUT_MS:              1_000,   //  1 s
  MAX_EXECUTION_TIMEOUT_MS:             30_000,   // 30 s
} as const;
