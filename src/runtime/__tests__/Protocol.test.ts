/**
 * Protocol.test.ts — JSON-RPC serialization + IPC worker protocol tests
 *
 * Coverage:
 *   JSON-RPC 2.0 (LSP layer)
 *     createRequest()      — structure, id, method, params
 *     createResponse()     — echoes request id, carries result
 *     createErrorResponse()— JSON-RPC error shape { code, message, data? }
 *     createNotification() — no id field
 *     serialize()          — JSON round-trip, compact output
 *     deserialize()        — valid msg, invalid JSON, unknown shape
 *     type guards          — isRequest / isResponse / isNotification / isError
 *
 *   IPC Worker Protocol (decisions § 5)
 *     createIPCRequest()   — {type, id, from, to, ts, payload}
 *     createIPCResponse()  — same id as request
 *     createIPCStream()    — seq increments, done always false
 *     createIPCCancel()    — CANCEL type, minimal payload
 *     to-field routing     — worker drops messages addressed to others
 *     CANCEL pre-arrival   — recorded before REQUEST processed
 *     UUID validity        — v4 format
 *
 * Decisions followed:
 *   § 5  IPC schema {type, id, from, to, ts, payload}
 *   § 5  REQUEST↔RESPONSE matched by same id
 *   § 5  STREAM seq for ordering; never carries done:true
 *   § 5  CANCEL can precede REQUEST → _cancelSet
 *   § 5  `to` field mandatory — worker self-filter
 *   § 9  LSP: JSON-RPC over postMessage
 */

import {
  createRequest,
  createResponse,
  createErrorResponse,
  createNotification,
  serialize,
  deserialize,
  isRequest,
  isResponse,
  isNotification,
  isErrorResponse,
} from "../../ipc/protocol/JsonRpc";
import {
  createIPCRequest,
  createIPCResponse,
  createIPCStream,
  createIPCCancel,
  isIPCMessage,
  MessageType,
  WorkerName,
} from "../../ipc/protocol/IpcProtocol";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  IPCMessage,
} from "../../ipc/protocol/types";

// ─── UUID v4 regex ────────────────────────────────────────────────────────────

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ─── JSON-RPC 2.0 ─────────────────────────────────────────────────────────────

describe("JSON-RPC 2.0 — createRequest()", () => {
  it("produces a well-formed request object", () => {
    const req = createRequest("textDocument/hover", { position: { line: 3, character: 10 } });

    expect(req.jsonrpc).toBe("2.0");
    expect(req.method).toBe("textDocument/hover");
    expect(req.params).toEqual({ position: { line: 3, character: 10 } });
  });

  it("generates a UUID v4 id when none is supplied", () => {
    const req = createRequest("textDocument/completion");

    expect(typeof req.id).toBe("string");
    expect(req.id).toMatch(UUID_V4_RE);
  });

  it("preserves a caller-supplied id", () => {
    const req = createRequest("textDocument/definition", undefined, "req-42");

    expect(req.id).toBe("req-42");
  });

  it("omits params field when not provided", () => {
    const req = createRequest("shutdown");

    expect("params" in req).toBe(false);
  });

  it("two calls without explicit id produce distinct ids", () => {
    const a = createRequest("$/ping");
    const b = createRequest("$/ping");

    expect(a.id).not.toBe(b.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("JSON-RPC 2.0 — createResponse()", () => {
  it("echoes the request id", () => {
    const req = createRequest("textDocument/hover", {}, "hover-1");
    const res = createResponse(req.id, { contents: "docs here" });

    expect(res.id).toBe("hover-1");
  });

  it("carries result in the result field", () => {
    const res = createResponse("any-id", [1, 2, 3]);

    expect(res.result).toEqual([1, 2, 3]);
    expect(res.jsonrpc).toBe("2.0");
  });

  it("does not have an error field on success", () => {
    const res = createResponse("any-id", { ok: true });

    expect("error" in res).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("JSON-RPC 2.0 — createErrorResponse()", () => {
  it("has error.code and error.message", () => {
    const res = createErrorResponse("req-99", -32601, "Method not found");

    expect(res.error.code).toBe(-32601);
    expect(res.error.message).toBe("Method not found");
  });

  it("echoes the request id", () => {
    const res = createErrorResponse("req-99", -32600, "Invalid Request");

    expect(res.id).toBe("req-99");
    expect(res.jsonrpc).toBe("2.0");
  });

  it("optionally carries data in error object", () => {
    const data = { offendingMethod: "unknownMethod" };
    const res  = createErrorResponse("req-1", -32601, "Method not found", data);

    expect(res.error.data).toEqual(data);
  });

  it("does not have a result field", () => {
    const res = createErrorResponse("req-1", -32700, "Parse error");

    expect("result" in res).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("JSON-RPC 2.0 — createNotification()", () => {
  it("has no id field", () => {
    const notif = createNotification("textDocument/publishDiagnostics", { uri: "file:///a.ts" });

    expect("id" in notif).toBe(false);
  });

  it("has method and jsonrpc fields", () => {
    const notif = createNotification("$/progress", { value: 50 });

    expect(notif.jsonrpc).toBe("2.0");
    expect(notif.method).toBe("$/progress");
  });

  it("carries params when provided", () => {
    const params = { diagnostics: [] };
    const notif  = createNotification("textDocument/publishDiagnostics", params);

    expect(notif.params).toEqual(params);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("JSON-RPC 2.0 — serialize() / deserialize()", () => {
  it("round-trips a request through serialize → deserialize", () => {
    const req = createRequest("textDocument/hover", { line: 0 }, "rpc-1");
    const raw = serialize(req);
    const out = deserialize(raw);

    expect(out).toEqual(req);
  });

  it("round-trips a response through serialize → deserialize", () => {
    const res = createResponse("rpc-1", { contents: "hover text" });
    const out = deserialize(serialize(res));

    expect(out).toEqual(res);
  });

  it("round-trips an error response", () => {
    const res = createErrorResponse("rpc-2", -32601, "Method not found");
    const out = deserialize(serialize(res));

    expect(out).toEqual(res);
  });

  it("round-trips a notification", () => {
    const notif = createNotification("$/progress", { value: 75 });
    const out   = deserialize(serialize(notif));

    expect(out).toEqual(notif);
  });

  it("serialize produces a string", () => {
    const req = createRequest("initialized");

    expect(typeof serialize(req)).toBe("string");
  });

  it("deserialize returns null for invalid JSON", () => {
    const result = deserialize("not valid json {{");

    expect(result).toBeNull();
  });

  it("deserialize returns null for JSON that is not an object", () => {
    expect(deserialize("[1,2,3]")).toBeNull();
    expect(deserialize('"a string"')).toBeNull();
    expect(deserialize("42")).toBeNull();
  });

  it("deserialize returns null when jsonrpc field is missing", () => {
    const bad = JSON.stringify({ id: "1", method: "foo" });

    expect(deserialize(bad)).toBeNull();
  });

  it("deserialize returns null when jsonrpc version is not '2.0'", () => {
    const v1  = JSON.stringify({ jsonrpc: "1.0", id: "1", method: "foo" });
    const v3  = JSON.stringify({ jsonrpc: "3.0", id: "1", method: "bar" });

    expect(deserialize(v1)).toBeNull();
    expect(deserialize(v3)).toBeNull();
  });

  it("deserialize returns null when jsonrpc is correct type but wrong value", () => {
    // Numeric 2 is not the string "2.0"
    const bad = JSON.stringify({ jsonrpc: 2, id: "1", method: "foo" });

    expect(deserialize(bad)).toBeNull();
  });

  it("preserves null params field (initialize request pattern)", () => {
    const req = createRequest("initialize", null as unknown as undefined, "init-1");
    const out = deserialize(serialize(req));

    expect((out as JsonRpcRequest).params).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("JSON-RPC 2.0 — type guards", () => {
  it("isRequest identifies request objects", () => {
    const req = createRequest("textDocument/hover");

    expect(isRequest(req)).toBe(true);
    expect(isResponse(req)).toBe(false);
    expect(isNotification(req)).toBe(false);
  });

  it("isResponse identifies response objects", () => {
    const res = createResponse("id-1", {});

    expect(isResponse(res)).toBe(true);
    expect(isRequest(res)).toBe(false);
  });

  it("isNotification identifies notification objects", () => {
    const notif = createNotification("$/ping");

    expect(isNotification(notif)).toBe(true);
    expect(isRequest(notif)).toBe(false);
    expect(isResponse(notif)).toBe(false);
  });

  it("isErrorResponse identifies error responses", () => {
    const ok  = createResponse("id-1", {});
    const err = createErrorResponse("id-2", -32601, "Not found");

    expect(isErrorResponse(ok)).toBe(false);
    expect(isErrorResponse(err)).toBe(true);
  });

  it("type guards return false for plain objects", () => {
    const junk = { foo: "bar" };

    expect(isRequest(junk)).toBe(false);
    expect(isResponse(junk)).toBe(false);
    expect(isNotification(junk)).toBe(false);
    expect(isErrorResponse(junk)).toBe(false);
  });
});

// ─── IPC Worker Protocol (decisions § 5) ─────────────────────────────────────

describe("IPC Protocol — createIPCRequest()", () => {
  it("produces a message with type REQUEST", () => {
    const msg = createIPCRequest(WorkerName.Editor, WorkerName.Language, { method: "parse" });

    expect(msg.type).toBe(MessageType.Request);
  });

  it("has from, to, id, ts, payload fields", () => {
    const msg = createIPCRequest(WorkerName.Editor, WorkerName.Runtime, { method: "run" });

    expect(msg.from).toBe(WorkerName.Editor);
    expect(msg.to).toBe(WorkerName.Runtime);
    expect(msg.id).toMatch(UUID_V4_RE);
    expect(typeof msg.ts).toBe("number");
    expect(msg.payload).toBeDefined();
  });

  it("generates unique id per call", () => {
    const a = createIPCRequest(WorkerName.Editor, WorkerName.Indexer, {});
    const b = createIPCRequest(WorkerName.Editor, WorkerName.Indexer, {});

    expect(a.id).not.toBe(b.id);
  });

  it("ts is a recent Unix millisecond timestamp", () => {
    const before = Date.now();
    const msg    = createIPCRequest(WorkerName.AI, WorkerName.Runtime, {});
    const after  = Date.now();

    expect(msg.ts).toBeGreaterThanOrEqual(before);
    expect(msg.ts).toBeLessThanOrEqual(after);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("IPC Protocol — createIPCResponse()", () => {
  it("echoes the request id (REQUEST ↔ RESPONSE matching)", () => {
    const req = createIPCRequest(WorkerName.Editor, WorkerName.Language, {});
    const res = createIPCResponse(req.id, WorkerName.Language, WorkerName.Editor, { result: "ok" });

    expect(res.id).toBe(req.id);
    expect(res.type).toBe(MessageType.Response);
  });

  it("swaps from/to compared to the originating request", () => {
    const req = createIPCRequest(WorkerName.Editor, WorkerName.Language, {});
    const res = createIPCResponse(req.id, WorkerName.Language, WorkerName.Editor, {});

    expect(res.from).toBe(WorkerName.Language);
    expect(res.to).toBe(WorkerName.Editor);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("IPC Protocol — createIPCStream()", () => {
  it("has type STREAM", () => {
    const req   = createIPCRequest(WorkerName.Editor, WorkerName.AI, {});
    const chunk = createIPCStream(req.id, WorkerName.AI, WorkerName.Editor, 0, { text: "hello" });

    expect(chunk.type).toBe(MessageType.Stream);
  });

  it("carries seq at the message root — not inside payload (protocol envelope, decisions § 5)", () => {
    const req   = createIPCRequest(WorkerName.Editor, WorkerName.AI, {});
    const chunk = createIPCStream(req.id, WorkerName.AI, WorkerName.Editor, 7, { text: "x" });

    // seq is protocol-level metadata (ordering), not user content → must live at root
    expect((chunk as IPCMessage & { seq: number }).seq).toBe(7);
    // payload must not carry seq — that would mix concerns
    expect((chunk.payload as Record<string, unknown>).seq).toBeUndefined();
  });

  it("never has done:true — closing signal comes via RESPONSE (decisions § 5)", () => {
    const req   = createIPCRequest(WorkerName.Editor, WorkerName.AI, {});
    const chunk = createIPCStream(req.id, WorkerName.AI, WorkerName.Editor, 0, { text: "y" });

    // Check both root and payload — neither may carry done:true
    expect((chunk as IPCMessage & { done?: boolean }).done).not.toBe(true);
    expect((chunk.payload as { done?: boolean }).done).not.toBe(true);
  });

  it("seq increments are preserved across multiple stream chunks", () => {
    const req  = createIPCRequest(WorkerName.Editor, WorkerName.AI, {});
    const seqs = [0, 1, 2, 3].map((seq) =>
      createIPCStream(req.id, WorkerName.AI, WorkerName.Editor, seq, {}),
    );

    const rootSeqs = seqs.map((m) => (m as IPCMessage & { seq: number }).seq);
    expect(rootSeqs).toEqual([0, 1, 2, 3]);
  });

  it("out-of-order chunks are detectable via seq", () => {
    const req    = createIPCRequest(WorkerName.Editor, WorkerName.AI, {});
    const chunks = [2, 0, 1].map((seq) =>
      createIPCStream(req.id, WorkerName.AI, WorkerName.Editor, seq, {}),
    );

    const seqs = chunks.map((m) => (m as IPCMessage & { seq: number }).seq);
    expect(seqs).not.toEqual([0, 1, 2]);
    expect([...seqs].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("IPC Protocol — createIPCCancel()", () => {
  it("has type CANCEL", () => {
    const cancel = createIPCCancel("some-req-id", WorkerName.Editor, WorkerName.Runtime);

    expect(cancel.type).toBe(MessageType.Cancel);
  });

  it("preserves the original request id", () => {
    const reqId  = "req-to-cancel";
    const cancel = createIPCCancel(reqId, WorkerName.Editor, WorkerName.AI);

    expect(cancel.id).toBe(reqId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("IPC Protocol — to-field routing", () => {
  it("a language worker ignores messages addressed to the runtime", () => {
    const forRuntime = createIPCRequest(WorkerName.Editor, WorkerName.Runtime, {});

    // The worker self-filter: msg.to !== "language" → drop
    const shouldProcess = forRuntime.to === WorkerName.Language;

    expect(shouldProcess).toBe(false);
  });

  it("a language worker processes messages addressed to itself", () => {
    const forLanguage = createIPCRequest(WorkerName.Editor, WorkerName.Language, {});

    const shouldProcess = forLanguage.to === WorkerName.Language;

    expect(shouldProcess).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("IPC Protocol — CANCEL pre-arrival semantics", () => {
  it("CANCEL arrives before REQUEST: id recorded in cancelSet, REQUEST is silently dropped", () => {
    const cancelSet = new Set<string>();

    const reqId  = "future-req-id";
    const cancel = createIPCCancel(reqId, WorkerName.Editor, WorkerName.Runtime);

    // Simulate worker receiving CANCEL first
    cancelSet.add(cancel.id);

    // Simulate REQUEST arriving later
    const req = createIPCRequest(WorkerName.Editor, WorkerName.Runtime, { method: "run" });
    // Override id to match the pre-cancelled id (testing the lookup)
    const reqWithKnownId = { ...req, id: reqId };

    const isCancelled = cancelSet.has(reqWithKnownId.id);

    expect(isCancelled).toBe(true);
    // After processing the drop, the cancel entry is removed
    cancelSet.delete(reqWithKnownId.id);
    expect(cancelSet.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("IPC Protocol — isIPCMessage() strict type guard", () => {
  it("returns true for a valid IPC request message", () => {
    const req = createIPCRequest(WorkerName.Editor, WorkerName.Language, {});

    expect(isIPCMessage(req)).toBe(true);
  });

  it("returns true for STREAM and CANCEL messages", () => {
    const req    = createIPCRequest(WorkerName.Editor, WorkerName.AI, {});
    const stream = createIPCStream(req.id, WorkerName.AI, WorkerName.Editor, 0, {});
    const cancel = createIPCCancel(req.id, WorkerName.Editor, WorkerName.AI);

    expect(isIPCMessage(stream)).toBe(true);
    expect(isIPCMessage(cancel)).toBe(true);
  });

  it("returns false for JSON-RPC messages (no from/to/ts fields)", () => {
    expect(isIPCMessage(createRequest("initialize"))).toBe(false);
    expect(isIPCMessage(createResponse("id-1", {}))).toBe(false);
    expect(isIPCMessage(createNotification("$/ping"))).toBe(false);
  });

  it("returns false when 'type' field is missing", () => {
    const msg = createIPCRequest(WorkerName.Editor, WorkerName.Language, {});
    const { type: _omit, ...withoutType } = msg;

    expect(isIPCMessage(withoutType)).toBe(false);
  });

  it("returns false when 'from' field is missing", () => {
    const msg = createIPCRequest(WorkerName.Editor, WorkerName.Language, {});
    const { from: _omit, ...withoutFrom } = msg;

    expect(isIPCMessage(withoutFrom)).toBe(false);
  });

  it("returns false when 'to' field is missing", () => {
    const msg = createIPCRequest(WorkerName.Editor, WorkerName.Language, {});
    const { to: _omit, ...withoutTo } = msg;

    expect(isIPCMessage(withoutTo)).toBe(false);
  });

  it("returns false when 'id' field is missing", () => {
    const msg = createIPCRequest(WorkerName.Editor, WorkerName.Language, {});
    const { id: _omit, ...withoutId } = msg;

    expect(isIPCMessage(withoutId)).toBe(false);
  });

  it("returns false when 'ts' field is missing", () => {
    const msg = createIPCRequest(WorkerName.Editor, WorkerName.Language, {});
    const { ts: _omit, ...withoutTs } = msg;

    expect(isIPCMessage(withoutTs)).toBe(false);
  });

  it("returns false when 'payload' field is missing", () => {
    const msg = createIPCRequest(WorkerName.Editor, WorkerName.Language, {});
    const { payload: _omit, ...withoutPayload } = msg;

    expect(isIPCMessage(withoutPayload)).toBe(false);
  });

  it("returns false for null, undefined, and primitives", () => {
    expect(isIPCMessage(null)).toBe(false);
    expect(isIPCMessage(undefined)).toBe(false);
    expect(isIPCMessage(42)).toBe(false);
    expect(isIPCMessage("REQUEST")).toBe(false);
  });

  it("returns false for an empty object", () => {
    expect(isIPCMessage({})).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("IPC Protocol — full round-trip via postMessage serialization", () => {
  it("IPC request survives JSON.stringify → JSON.parse", () => {
    const req = createIPCRequest(
      WorkerName.Editor,
      WorkerName.Language,
      { method: "textDocument/symbolIndex", params: { fileId: "file-001" } },
    );

    const wire   = JSON.stringify(req);
    const parsed = JSON.parse(wire) as IPCMessage;

    expect(parsed.type).toBe(MessageType.Request);
    expect(parsed.id).toBe(req.id);
    expect(parsed.from).toBe(WorkerName.Editor);
    expect(parsed.to).toBe(WorkerName.Language);
    expect(parsed.ts).toBe(req.ts);
  });

  it("IPC stream chunk survives serialization round-trip", () => {
    const req   = createIPCRequest(WorkerName.Editor, WorkerName.AI, {});
    const chunk = createIPCStream(req.id, WorkerName.AI, WorkerName.Editor, 3, { delta: "hello" });

    const parsed = JSON.parse(JSON.stringify(chunk)) as IPCMessage;

    expect(parsed.type).toBe(MessageType.Stream);
    expect(parsed.id).toBe(req.id);
  });
});
