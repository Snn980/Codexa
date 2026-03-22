/**
 * ai/AIWorkerClient.ts — AI Worker Thread IPC sarmalayıcısı
 *
 * § 1  : Result<T>, tryResultAsync()
 * § 5  : { type, id, from, to, ts, payload } protokolü
 *         STREAM → seq monotonic, done: false
 *         RESPONSE → stream kapanış sinyali
 *         CANCEL → erken gelebilir, _cancelSet'e eklenir
 */

import type { Result } from "../core/Result";
import { ok, err, tryResultAsync } from "../core/Result";
import type { UUID } from "../core/types";
import type { AIModelId } from "./AIModels";

// ─── IPC Mesaj Tipleri ──────────────────────────────────────────────────────

type MsgType = "REQUEST" | "RESPONSE" | "STREAM" | "CANCEL";
type MsgFrom = "editor" | "runtime" | "ai" | "indexer";

interface BaseMsg {
  type: MsgType;
  id: UUID;
  from: MsgFrom;
  to: MsgFrom;
  ts: number;
}

// Giden (editor → ai)
export interface AIChatRequestPayload {
  kind: "chat";
  model: AIModelId;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  maxTokens: number;
}

export interface AICompletionRequestPayload {
  kind: "completion";
  model: AIModelId;
  prefix: string;
  suffix: string;
  language: string;
  maxTokens: number;
}

type AIRequestPayload = AIChatRequestPayload | AICompletionRequestPayload;

interface RequestMsg extends BaseMsg {
  type: "REQUEST";
  payload: AIRequestPayload;
}

interface CancelMsg extends BaseMsg {
  type: "CANCEL";
  payload: { targetId: UUID };
}

// Gelen (ai → editor)
interface StreamMsg extends BaseMsg {
  type: "STREAM";
  payload: {
    seq: number;
    token: string;
    // done: false — kapanış sinyali RESPONSE ile gelir (§ 5)
  };
}

interface ResponseMsg extends BaseMsg {
  type: "RESPONSE";
  payload: {
    ok: boolean;
    totalTokens?: number;
    errorCode?: string;
    errorMessage?: string;
  };
}

type IncomingMsg = StreamMsg | ResponseMsg;

// ─── Error Kodları ──────────────────────────────────────────────────────────

export const AIErrorCode = {
  WORKER_NOT_READY: "AI_WORKER_NOT_READY",
  STREAM_INTERRUPTED: "AI_STREAM_INTERRUPTED",
  WORKER_ERROR: "AI_WORKER_ERROR",
  REQUEST_CANCELLED: "AI_REQUEST_CANCELLED",
  SEQ_OUT_OF_ORDER: "AI_SEQ_OUT_OF_ORDER",
} as const;

// ─── AIWorkerClient ─────────────────────────────────────────────────────────

export interface IAIWorkerClient {
  /**
   * Chat isteği gönderir, AsyncGenerator ile token stream döner.
   * AbortSignal ile iptal edilebilir.
   */
  streamChat(
    payload: Omit<AIChatRequestPayload, "kind">,
    signal?: AbortSignal,
  ): AsyncGenerator<string, Result<{ totalTokens: number }>, unknown>;

  /**
   * Tek-seferlik completion (await edilebilir, streaming yok).
   */
  requestCompletion(
    payload: Omit<AICompletionRequestPayload, "kind">,
    signal?: AbortSignal,
  ): Promise<Result<string>>;

  dispose(): void;
}

/** Worker postMessage arayüzü — test'te mock'lanır */
export interface IWorkerPort {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", handler: (e: MessageEvent) => void): void;
  removeEventListener(type: "message", handler: (e: MessageEvent) => void): void;
}

type PendingRequest = {
  resolve: (msg: IncomingMsg) => void;
  reject: (reason: unknown) => void;
};

export class AIWorkerClient implements IAIWorkerClient {
  private readonly _port: IWorkerPort;
  private readonly _newUUID: () => UUID;
  private readonly _listeners = new Map<UUID, Array<(msg: IncomingMsg) => void>>();
  private _disposed = false;
  private readonly _msgHandler: (e: MessageEvent) => void;

  constructor(port: IWorkerPort, newUUID: () => UUID) {
    this._port = port;
    this._newUUID = newUUID;

    this._msgHandler = (e: MessageEvent) => {
      const msg = e.data as IncomingMsg;
      if (!msg?.id) return;
      const handlers = this._listeners.get(msg.id);
      if (!handlers) return;
      // Snapshot iteration (§ 3 EventBus pattern)
      const snap = [...handlers];
      for (const h of snap) {
        try { h(msg); } catch { /* listener hatası yutulur */ }
      }
    };

    this._port.addEventListener("message", this._msgHandler);
  }

  // ─── streamChat ────────────────────────────────────────────────────────

  async *streamChat(
    payload: Omit<AIChatRequestPayload, "kind">,
    signal?: AbortSignal,
  ): AsyncGenerator<string, Result<{ totalTokens: number }>, unknown> {
    if (this._disposed) {
      return err(AIErrorCode.WORKER_NOT_READY, "AIWorkerClient disposed");
    }

    const id = this._newUUID();
    let expectedSeq = 0;
    let done = false;
    let totalTokens = 0;

    // AbortSignal → CANCEL gönder
    const onAbort = () => this._sendCancel(id);
    signal?.addEventListener("abort", onAbort);

    // Token queue + promise resolver
    const queue: string[] = [];
    let resolver: (() => void) | null = null;
    let terminationResult: Result<{ totalTokens: number }> | null = null;

    const enqueue = (msg: IncomingMsg) => {
      if (done) return;

      if (msg.type === "STREAM") {
        const { seq, token } = msg.payload;
        if (seq !== expectedSeq) {
          terminationResult = err(AIErrorCode.SEQ_OUT_OF_ORDER, `seq ${seq} !== ${expectedSeq}`);
          done = true;
          resolver?.();
          return;
        }
        expectedSeq++;
        queue.push(token);
        resolver?.();
      } else if (msg.type === "RESPONSE") {
        done = true;
        if (msg.payload.ok) {
          totalTokens = msg.payload.totalTokens ?? 0;
          terminationResult = ok({ totalTokens });
        } else {
          terminationResult = err(
            (msg.payload.errorCode as import('../types/core').ErrorCode) ?? AIErrorCode.WORKER_ERROR,
            msg.payload.errorMessage ?? "AI worker error",
          );
        }
        resolver?.();
      }
    };

    this._addListener(id, enqueue);

    // REQUEST gönder
    const request: RequestMsg = {
      type: "REQUEST",
      id,
      from: "editor",
      to: "ai",
      ts: Date.now(),
      payload: { kind: "chat", ...payload },
    };
    this._port.postMessage(request);

    try {
      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else if (!done) {
          await new Promise<void>((res) => { resolver = res; });
          resolver = null;
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this._removeListener(id);
    }

    if (signal?.aborted) {
      return err(AIErrorCode.REQUEST_CANCELLED, "Cancelled by user");
    }

    return terminationResult ?? err(AIErrorCode.STREAM_INTERRUPTED, "Stream ended without RESPONSE");
  }

  // ─── requestCompletion ─────────────────────────────────────────────────

  async requestCompletion(
    payload: Omit<AICompletionRequestPayload, "kind">,
    signal?: AbortSignal,
  ): Promise<Result<string>> {
    return tryResultAsync(
      async () => {
        const tokens: string[] = [];
        const gen = this.streamChat(
          // completion → chat uyarlaması (AI worker completion mode alır)
          {
            model: payload.model,
            messages: [
              {
                role: "user",
                content: `Complete the following ${payload.language} code. Return only the completion, no explanation.\n\n${payload.prefix}<CURSOR>${payload.suffix}`,
              },
            ],
            maxTokens: payload.maxTokens,
          } as Omit<AIChatRequestPayload, "kind">,
          signal,
        );

        let item = await gen.next();
        while (!item.done) {
          tokens.push(item.value);
          item = await gen.next();
        }
        return tokens.join("");
      },
      AIErrorCode.WORKER_ERROR,
      "Completion request failed",
    );
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private _sendCancel(targetId: UUID): void {
    if (this._disposed) return;
    const msg: CancelMsg = {
      type: "CANCEL",
      id: this._newUUID(),
      from: "editor",
      to: "ai",
      ts: Date.now(),
      payload: { targetId },
    };
    try { this._port.postMessage(msg); } catch { /* port kapanmış olabilir */ }
  }

  private _addListener(id: UUID, handler: (msg: IncomingMsg) => void): void {
    const arr = this._listeners.get(id) ?? [];
    arr.push(handler);
    this._listeners.set(id, arr);
  }

  private _removeListener(id: UUID): void {
    this._listeners.delete(id);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._port.removeEventListener("message", this._msgHandler);
    this._listeners.clear();
  }
}
