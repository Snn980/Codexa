/**
 * ipc/protocol/IpcProtocol.ts
 * IPC Worker protokol builder'ları, MessageType ve WorkerName sabitleri
 *
 * Protocol.test.ts'nin beklediği arayüz:
 *   createIPCRequest(from, to, payload)
 *   createIPCResponse(requestId, from, to, payload)
 *   createIPCStream(requestId, from, to, seq, payload)
 *   createIPCCancel(requestId, from, to)
 *   isIPCMessage(value)
 *   MessageType  — enum-benzeri sabit
 *   WorkerName   — enum-benzeri sabit
 */

import type { IPCMessage, IPCActor, IPCMessageType } from "./types";

// ── Sabitler ──────────────────────────────────────────────────────────────────

export const MessageType = {
  Request:  "REQUEST",
  Response: "RESPONSE",
  Stream:   "STREAM",
  Cancel:   "CANCEL",
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const WorkerName = {
  Editor:   "editor",
  Runtime:  "runtime",
  Language: "language",
  AI:       "ai",
  Indexer:  "indexer",
} as const;
export type WorkerName = (typeof WorkerName)[keyof typeof WorkerName];

// ── UUID üretici ──────────────────────────────────────────────────────────────

function generateId(): string {
  // RFC 4122 v4 uyumlu UUID (crypto yoksa Math.random tabanlı fallback)
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Builder'lar ───────────────────────────────────────────────────────────────

export function createIPCRequest(
  from:    IPCActor,
  to:      IPCActor,
  payload: unknown,
): IPCMessage {
  return {
    type:    "REQUEST",
    id:      generateId(),
    from,
    to,
    ts:      Date.now(),
    payload,
  };
}

export function createIPCResponse(
  requestId: string,
  from:      IPCActor,
  to:        IPCActor,
  payload:   unknown,
): IPCMessage {
  return {
    type:    "RESPONSE",
    id:      requestId,
    from,
    to,
    ts:      Date.now(),
    ok:      true,
    data:    payload,
    payload,
  };
}

export function createIPCStream(
  requestId: string,
  from:      IPCActor,
  to:        IPCActor,
  seq:       number,
  payload:   unknown,
): IPCMessage {
  return {
    type:    "STREAM",
    id:      requestId,
    from,
    to,
    ts:      Date.now(),
    seq,
    done:    false,
    payload,
  };
}

export function createIPCCancel(
  requestId: string,
  from:      IPCActor,
  to:        IPCActor,
): IPCMessage {
  return {
    type:    "CANCEL",
    id:      requestId,
    from,
    to,
    ts:      Date.now(),
    payload: null,
  };
}

// ── Type guard ────────────────────────────────────────────────────────────────

export function isIPCMessage(value: unknown): value is IPCMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m["id"]   !== "string")  return false;
  if (typeof m["from"] !== "string")  return false;
  if (typeof m["to"]   !== "string")  return false;
  if (typeof m["ts"]   !== "number")  return false;
  if (!("payload" in m)) return false;
  const t = m["type"];
  return t === "REQUEST" || t === "RESPONSE" || t === "STREAM" || t === "CANCEL";
}
