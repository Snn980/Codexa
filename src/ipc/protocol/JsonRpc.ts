/**
 * ipc/protocol/JsonRpc.ts
 * JSON-RPC 2.0 builder'ları ve tip guard'ları
 */

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcError,
} from "./types";

function nextId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Builder'lar ───────────────────────────────────────────────────────────────

export function createRequest(
  method: string,
  params?: unknown,
  id?: string,
): JsonRpcRequest {
  const req: Record<string, unknown> = {
    jsonrpc: "2.0",
    id:      id ?? nextId(),
    method,
  };
  if (params !== undefined) {
    req["params"] = params;
  }
  return req as unknown as JsonRpcRequest;
}

export function createResponse(
  id: string,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function createErrorResponse(
  id: string,
  codeOrError: number | JsonRpcError,
  message?: string,
  data?: unknown,
): JsonRpcResponse {
  const error: JsonRpcError = typeof codeOrError === "number"
    ? { code: codeOrError, message: message ?? "Error", ...(data !== undefined ? { data } : {}) }
    : codeOrError;
  return { jsonrpc: "2.0", id, error };
}

export function createNotification(
  method: string,
  params?: unknown,
): JsonRpcNotification {
  const notif: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) notif["params"] = params;
  return notif as unknown as JsonRpcNotification;
}

// ── Serialization ─────────────────────────────────────────────────────────────

export function serialize(msg: unknown): string {
  return JSON.stringify(msg);
}

export function deserialize(raw: string): JsonRpcRequest | JsonRpcResponse | JsonRpcNotification | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (typeof obj !== "object" || obj === null) return null;
    if (obj["jsonrpc"] !== "2.0") return null;
    return obj as unknown as JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
  } catch {
    return null;
  }
}

// ── Type guards ───────────────────────────────────────────────────────────────

export function isRequest(msg: unknown): msg is JsonRpcRequest {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m["jsonrpc"] === "2.0" && typeof m["id"] === "string" && typeof m["method"] === "string";
}

export function isResponse(msg: unknown): msg is JsonRpcResponse {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m["jsonrpc"] === "2.0" && typeof m["id"] === "string" && !("method" in m);
}

export function isNotification(msg: unknown): msg is JsonRpcNotification {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m["jsonrpc"] === "2.0" && typeof m["method"] === "string" && !("id" in m);
}

export function isErrorResponse(msg: unknown): msg is JsonRpcResponse & { error: JsonRpcError } {
  return isResponse(msg) && "error" in (msg as object);
}
