/**
 * ipc/protocol/types.ts
 * JSON-RPC 2.0 ve IPC Worker Protocol tip tanımları
 */

// ── JSON-RPC 2.0 ─────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id:      string;
  readonly method:  string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id:      string;
  readonly result?: unknown;
  readonly error?:  JsonRpcError;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method:  string;
  readonly params?: unknown;
  // notifications have no "id"
}

export interface JsonRpcError {
  readonly code:    number;
  readonly message: string;
  readonly data?:   unknown;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification;

// ── IPC Worker Protocol ───────────────────────────────────────────────────────

export type IPCActor = "editor" | "runtime" | "language" | "ai" | "indexer";

export type IPCMessageType = "REQUEST" | "RESPONSE" | "STREAM" | "CANCEL";

export interface IPCMessage {
  readonly type:    IPCMessageType;
  readonly id:      string;
  readonly from:    IPCActor;
  readonly to:      IPCActor;
  readonly ts:      number;
  readonly payload?: unknown;
  readonly seq?:     number;
  readonly done?:    boolean;
  readonly ok?:      boolean;
  readonly data?:    unknown;
  readonly error?:   unknown;
}
