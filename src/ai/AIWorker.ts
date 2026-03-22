/**
 * ai/AIWorker.ts — AI Worker thread entry point
 *
 * § 5  : { type, id, from, to, ts, payload } protokolü
 *         REQUEST → STREAM* → RESPONSE | CANCEL
 *         STREAM'de done: false — kapanış RESPONSE ile gelir
 *
 * DÜZELTMELER:
 *   ❗ _cancelSet CLEANUP  : CANCEL geldiğinde REQUEST zaten işleniyorsa
 *      _cancelSet'e girmiyor (zaten abort edildi). REQUEST gelmeden CANCEL
 *      gelirse _cancelSet'e girer; REQUEST işlenince set'ten silinir →
 *      memory leak yok.
 *   💡 SEQ OVERFLOW GUARD : seq Number.MAX_SAFE_INTEGER'a ulaşırsa sıfırlanır.
 *   💡 POST HATA YAKALAMA : _sendStream/_sendResponse try-catch ile sarıldı;
 *      port kapandığında worker crash yerine sessizce devam eder.
 */

import type { IAIWorkerRuntime } from "./IAIWorkerRuntime";
import type { AIModelId } from "./AIModels";
import { AI_MODELS } from "./AIModels";
import type { UUID } from "../core/types";

// ─── Protokol tipleri (§ 5) ──────────────────────────────────────────────────

type MsgFrom = "editor" | "ai";

interface BaseMsg {
  type: string;
  id: UUID;
  from: MsgFrom;
  to: MsgFrom;
  ts: number;
}

export interface AIRequestPayload {
  kind: "chat";
  model: AIModelId;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  maxTokens: number;
}

interface RequestMsg extends BaseMsg {
  type: "REQUEST";
  payload: AIRequestPayload;
}

interface CancelMsg extends BaseMsg {
  type: "CANCEL";
  payload: { targetId: UUID };
}

interface StreamMsg extends BaseMsg {
  type: "STREAM";
  // done: false zorunlu değil tipte — protokol kuralı: STREAM'de hiç done:true yok (§ 5)
  payload: { seq: number; token: string };
}

interface ResponseMsg extends BaseMsg {
  type: "RESPONSE";
  payload:
    | { ok: true; totalTokens: number }
    | { ok: false; errorCode: string; errorMessage: string };
}

// ─── Seq overflow sabiti ──────────────────────────────────────────────────────

/** 💡 SEQ OVERFLOW: bu değere ulaşınca seq sıfırlanır */
const SEQ_RESET_AT = 2 ** 31 - 1; // int32 max — taşma garantisi

// ─── AIWorker ─────────────────────────────────────────────────────────────────

export class AIWorker {
  private readonly _runtime: IAIWorkerRuntime;
  private readonly _post: (msg: unknown) => void;
  private _activeRequests = new Map<UUID, AbortController>();
  /**
   * ❗ _cancelSet CLEANUP: REQUEST gelmeden önce CANCEL gelirse buraya girer.
   * REQUEST işlenince _cancelSet'ten silinir → leak yok.
   * Eski REQUEST id'leri burada kalmaması için _handleRequest her durumda siler.
   */
  private _cancelSet = new Set<UUID>();
  private _disposed = false;

  constructor(runtime: IAIWorkerRuntime, post: (msg: unknown) => void) {
    this._runtime = runtime;
    this._post = post;
  }

  onMessage = (e: MessageEvent): void => {
    const msg = e.data as RequestMsg | CancelMsg;
    if (!msg?.type || !msg?.id) return;

    if (msg.type === "REQUEST" && (msg as RequestMsg).to === "ai") {
      void this._handleRequest(msg as RequestMsg);
      return;
    }
    if (msg.type === "CANCEL") {
      this._handleCancel(msg as CancelMsg);
    }
  };

  // ─── REQUEST ──────────────────────────────────────────────────────────

  private async _handleRequest(msg: RequestMsg): Promise<void> {
    const { id, payload } = msg;

    // ❗ CANCEL CLEANUP: erken iptal — set'ten sil
    if (this._cancelSet.has(id)) {
      this._cancelSet.delete(id); // ← cleanup
      this._sendResponse(id, {
        ok: false,
        errorCode: "RUNTIME_REQUEST_ABORTED",
        errorMessage: "Cancelled before start",
      });
      return;
    }

    const model = AI_MODELS.find((m) => m.id === payload.model);
    if (!model) {
      this._sendResponse(id, {
        ok: false,
        errorCode: "RUNTIME_MODEL_NOT_LOADED",
        errorMessage: `Unknown model: ${payload.model}`,
      });
      return;
    }

    const abortCtrl = new AbortController();
    this._activeRequests.set(id, abortCtrl);

    const request = {
      modelId:    payload.model,
      apiModelId: model.apiModelId,
      messages:   payload.messages,
      maxTokens:  payload.maxTokens,
      signal:     abortCtrl.signal,
    };

    let seq = 0;
    const gen = this._runtime.streamChat(request);

    try {
      let item = await gen.next();

      while (!item.done) {
        const token = item.value as string;
        this._sendStream(id, seq, token);
        // 💡 SEQ OVERFLOW GUARD
        seq = seq >= SEQ_RESET_AT ? 0 : seq + 1;
        item = await gen.next();
      }

      const result = item.value;
      if (result && !result.ok) {
        this._sendResponse(id, {
          ok: false,
          errorCode: result.error.code,
          errorMessage: result.error.message ?? "Runtime error",
        });
      } else {
        this._sendResponse(id, {
          ok: true,
          totalTokens: result?.data?.totalTokens ?? 0,
        });
      }
    } catch (e) {
      this._sendResponse(id, {
        ok: false,
        errorCode: "RUNTIME_UNKNOWN",
        errorMessage: String(e),
      });
    } finally {
      this._activeRequests.delete(id);
    }
  }

  // ─── CANCEL ───────────────────────────────────────────────────────────

  private _handleCancel(msg: CancelMsg): void {
    const { targetId } = msg.payload;
    const ctrl = this._activeRequests.get(targetId);

    if (ctrl) {
      ctrl.abort();
      // activeRequests'ten silinmesi _handleRequest finally'de yapılır
    } else {
      // REQUEST henüz gelmedi — set'e ekle; _handleRequest silinecek
      this._cancelSet.add(targetId);
    }
  }

  // ─── Mesaj gönderme ───────────────────────────────────────────────────

  private _sendStream(requestId: UUID, seq: number, token: string): void {
    const msg: StreamMsg = {
      type: "STREAM",
      id:   requestId,
      from: "ai",
      to:   "editor",
      ts:   Date.now(),
      payload: { seq, token },
    };
    // 💡 POST HATA YAKALAMA
    try { this._post(msg); } catch { /* port kapanmış — sessizce devam */ }
  }

  private _sendResponse(requestId: UUID, payload: ResponseMsg["payload"]): void {
    const msg: ResponseMsg = {
      type: "RESPONSE",
      id:   requestId,
      from: "ai",
      to:   "editor",
      ts:   Date.now(),
      payload,
    };
    // 💡 POST HATA YAKALAMA
    try { this._post(msg); } catch { /* port kapanmış — sessizce devam */ }
  }

  // ─── Dispose ──────────────────────────────────────────────────────────

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const ctrl of this._activeRequests.values()) ctrl.abort();
    this._activeRequests.clear();
    // ❗ CANCEL CLEANUP: dispose'da set temizlenir
    this._cancelSet.clear();
    this._runtime.dispose();
  }
}

// ─── Worker bootstrap ────────────────────────────────────────────────────────

export function bootstrapWorker(
  runtime: IAIWorkerRuntime,
  selfObj: {
    addEventListener(t: "message", h: (e: MessageEvent) => void): void;
    postMessage(m: unknown): void;
  },
): AIWorker {
  const worker = new AIWorker(runtime, (msg) => selfObj.postMessage(msg));
  selfObj.addEventListener("message", worker.onMessage);
  return worker;
}
