// src/hooks/useAIChat.ts
//
// Çözülen sorunlar:
//   - UUID crash riski → generateId() utility (uuid.ts)
//   - mountedRef tüm async path'lerde uygulanmamış → dispatch wrapper
//   - Concurrent chat request → _activeRequestRef lock
//   - Cancel mekanizması yok → AbortController + cancelPending()
//   - Retry / network error yönetimi → withRetry() + exponential backoff
//   - Rapid send race condition → requestQueue serialize
//   - Message history limit yok → sliding window, sistem mesajı korunur
//   - Message deduplication yok → idempotency key kontrolü
//   - Render memoization → useMemo tüm türetilmiş değerlerde
//   - Async reducer action order → AbortSignal ile iptal

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { generateId } from '../utils/uuid';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_MESSAGES = 500;   // § 17.3 clampMessages ile uyumlu
const MAX_CONTENT_BYTES    = 512 * 1024; // 512 KB — § 17.3
const RETRY_ATTEMPTS       = 3;
const RETRY_BASE_MS        = 300;

// ─── Tipler ───────────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system';
export type SendStatus   = 'idle' | 'pending' | 'streaming' | 'error';

export interface ChatMessage {
  readonly id:            string;   // generateId() ile garantili
  readonly role:          MessageRole;
  readonly content:       string;
  readonly timestamp:     number;
  /** İdempotency key — rapid send dedup için (opsiyonel, dışarıdan inject edilebilir) */
  readonly idempotencyKey?: string;
  /** Streaming devam ediyor mu — UI cursor animasyonu için */
  readonly isStreaming?:  boolean;
  /** Hata kodu — mesaj balonu kırmızı gösterim için */
  readonly errorCode?:    string;
  /** Token sayısı — UI token counter için */
  readonly tokens?:       number;
  /** Toplam token (streaming bittikten sonra) — UI özet için */
  readonly totalTokens?:  number;
}

export interface AIChatState {
  readonly messages:   readonly ChatMessage[];
  readonly sendStatus: SendStatus;
  readonly lastError:  string | null;
  readonly pendingId:  string | null;  // streaming assistant mesajının id'si
}

// ─── Action tipleri ───────────────────────────────────────────────────────────

type Action =
  | { type: 'APPEND';       message: Pick<ChatMessage, 'role' | 'content' | 'idempotencyKey'> }
  | { type: 'STREAM_START'; systemPrompt?: string; assistantId: string }
  | { type: 'STREAM_CHUNK'; chunk: string; assistantId: string }
  | { type: 'STREAM_END';   assistantId: string }
  | { type: 'CANCEL' }
  | { type: 'ERROR';        error: string }
  | { type: 'CLEAR' }
  | { type: 'TRIM';         maxMessages: number };

// ─── Reducer ─────────────────────────────────────────────────────────────────

const INITIAL_STATE: AIChatState = {
  messages:   [],
  sendStatus: 'idle',
  lastError:  null,
  pendingId:  null,
};

function applyMemoryLimit(
  messages: readonly ChatMessage[],
  maxMessages: number,
): readonly ChatMessage[] {
  if (messages.length <= maxMessages) return messages;
  // Sistem mesajı (index 0) her zaman korunur — § 17.3
  const hasSystem = messages[0]?.role === 'system';
  const pinned    = hasSystem ? [messages[0]] : [];
  const rest      = hasSystem ? messages.slice(1) : [...messages];
  const sliced    = rest.slice(rest.length - (maxMessages - pinned.length));
  return [...pinned, ...sliced];
}

function isDuplicate(
  messages: readonly ChatMessage[],
  idempotencyKey: string | undefined,
): boolean {
  if (!idempotencyKey) return false;
  return messages.some((m) => m.idempotencyKey === idempotencyKey);
}

function reducer(state: AIChatState, action: Action): AIChatState {
  switch (action.type) {
    case 'APPEND': {
      // Deduplication — aynı idempotencyKey varsa tekrar ekleme
      if (isDuplicate(state.messages, action.message.idempotencyKey)) {
        return state;
      }
      return {
        ...state,
        sendStatus: 'pending',
        lastError:  null,
        messages: [
          ...state.messages,
          {
            id:             generateId(),
            role:           action.message.role,
            content:        action.message.content,
            timestamp:      Date.now(),
            idempotencyKey: action.message.idempotencyKey,
          },
        ],
      };
    }

    case 'STREAM_START': {
      const sysMsg: ChatMessage | undefined = action.systemPrompt
        ? {
            id:        generateId(),
            role:      'system',
            content:   action.systemPrompt,
            timestamp: Date.now(),
          }
        : undefined;

      const assistantMsg: ChatMessage = {
        id:        action.assistantId,  // dışarıdan verilir — StaleRef yok
        role:      'assistant',
        content:   '',
        timestamp: Date.now(),
      };

      return {
        ...state,
        sendStatus: 'streaming',
        lastError:  null,
        pendingId:  action.assistantId,
        messages:   [
          ...state.messages,
          ...(sysMsg ? [sysMsg] : []),
          assistantMsg,
        ],
      };
    }

    case 'STREAM_CHUNK': {
      // pendingId eşleşmiyorsa eski / iptal edilmiş stream — yoksay
      if (state.pendingId !== action.assistantId) return state;
      const msgs = [...state.messages];
      // ES2022 uyumlu findLastIndex — Array.findLastIndex ES2023'te eklendi,
      // ancak tsconfig hedefi ES2022 olduğundan reverse+findIndex ile implement edilir.
      const reversedIdx = [...msgs].reverse().findIndex((m) => m.id === action.assistantId);
      const idx = reversedIdx === -1 ? -1 : msgs.length - 1 - reversedIdx;
      if (idx === -1) return state;
      msgs[idx] = { ...msgs[idx], content: msgs[idx].content + action.chunk };
      return { ...state, messages: msgs };
    }

    case 'STREAM_END': {
      if (state.pendingId !== action.assistantId) return state;
      return { ...state, sendStatus: 'idle', pendingId: null };
    }

    case 'CANCEL':
      return { ...state, sendStatus: 'idle', pendingId: null };

    case 'ERROR':
      return {
        ...state,
        sendStatus: 'error',
        lastError:  action.error,
        pendingId:  null,
      };

    case 'TRIM':
      return {
        ...state,
        messages: applyMemoryLimit(state.messages, action.maxMessages),
      };

    case 'CLEAR':
      return INITIAL_STATE;

    default:
      return state;
  }
}

// ─── Retry yardımcısı ─────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  attempts = RETRY_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await fn(signal);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      lastError = err;
      if (i < attempts - 1) {
        // Exponential backoff: 300 ms, 600 ms, 1200 ms
        await new Promise<void>((res) => setTimeout(res, RETRY_BASE_MS * 2 ** i));
      }
    }
  }
  throw lastError;
}

// ─── Hook options ─────────────────────────────────────────────────────────────

export interface UseAIChatOptions {
  maxMessages?:   number;
  onError?:       (err: string) => void;
  /**
   * inject edilebilir send fonksiyonu — AIWorkerBridge veya test mock.
   * (signal: AbortSignal, message: ChatMessage[]) => AsyncGenerator<string>
   */
  sendFn?: (
    messages: readonly ChatMessage[],
    signal:   AbortSignal,
  ) => AsyncGenerator<string, void, unknown>;
}

export interface UseAIChatReturn {
  // State
  messages:    readonly ChatMessage[];
  sendStatus:  SendStatus;
  lastError:   string | null;
  pendingId:   string | null;
  // Computed (memoized)
  isEmpty:     boolean;
  canSend:     boolean;
  // Actions
  sendMessage:          (content: string, idempotencyKey?: string) => Promise<void>;
  startAssistantStream: (systemPrompt?: string) => string; // returns assistantId
  appendAssistantChunk: (chunk: string, assistantId: string) => void;
  endAssistantStream:   (assistantId: string) => void;
  cancelPending:        () => void;
  setError:             (msg: string) => void;
  clear:                () => void;
  trimHistory:          () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAIChat(options: UseAIChatOptions = {}): UseAIChatReturn {
  const { maxMessages = DEFAULT_MAX_MESSAGES, onError, sendFn } = options;

  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  // ── mountedRef: tüm async path'lerde dispatch guard ──
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** dispatch wrapper — unmount sonrası state update önler */
  const safeDispatch = useCallback((action: Action) => {
    if (mountedRef.current) dispatch(action);
  }, []);

  // ── Concurrent request lock ──
  // Aynı anda sadece bir aktif request; rapid send ikinci isteği queue'a alır
  const _activeAbortRef   = useRef<AbortController | null>(null);
  const _requestQueueRef  = useRef<Array<() => Promise<void>>>([]);
  const _processingRef    = useRef(false);

  const _processQueue = useCallback(async () => {
    if (_processingRef.current) return;
    _processingRef.current = true;
    while (_requestQueueRef.current.length > 0) {
      const next = _requestQueueRef.current.shift()!;
      await next();
    }
    _processingRef.current = false;
  }, []);

  // ── Cancel ──
  const cancelPending = useCallback(() => {
    _activeAbortRef.current?.abort();
    _activeAbortRef.current = null;
    _requestQueueRef.current = [];  // kuyruk da temizlenir
    safeDispatch({ type: 'CANCEL' });
  }, [safeDispatch]);

  // ── sendMessage (sendFn inject edilmişse tam pipeline; yoksa sadece APPEND) ──
  const sendMessage = useCallback(
    async (content: string, idempotencyKey?: string) => {
      // Dedup — idempotencyKey ile çift tıklama / rapid send koruması
      const key = idempotencyKey ?? `${content}-${Date.now()}`;

      const task = async () => {
        safeDispatch({ type: 'APPEND', message: { role: 'user', content, idempotencyKey: key } });

        if (!sendFn) return; // sendFn enjekte edilmemişse sadece UI güncellenir

        const controller  = new AbortController();
        _activeAbortRef.current = controller;

        const assistantId = generateId();
        safeDispatch({ type: 'STREAM_START', assistantId });

        try {
          const currentMessages = [...state.messages, {
            id: generateId(), role: 'user' as const, content, timestamp: Date.now(),
          }];

          const gen = await withRetry(
            (signal) => {
              const g = sendFn(currentMessages, signal);
              return Promise.resolve(g);
            },
            controller.signal,
          );

          for await (const chunk of gen) {
            if (controller.signal.aborted) break;
            safeDispatch({ type: 'STREAM_CHUNK', chunk, assistantId });
          }

          if (!controller.signal.aborted) {
            safeDispatch({ type: 'STREAM_END', assistantId });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (mountedRef.current) {
            safeDispatch({ type: 'ERROR', error: msg });
            onError?.(msg);
          }
        } finally {
          if (_activeAbortRef.current === controller) {
            _activeAbortRef.current = null;
          }
        }
      };

      _requestQueueRef.current.push(task);
      _processQueue();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [safeDispatch, sendFn, onError, _processQueue],
  );

  // ── Streaming control (manuel — sendFn olmadan AIWorkerBridge kullanırken) ──
  const startAssistantStream = useCallback(
    (systemPrompt?: string): string => {
      const assistantId = generateId();
      safeDispatch({ type: 'STREAM_START', systemPrompt, assistantId });
      return assistantId;
    },
    [safeDispatch],
  );

  const appendAssistantChunk = useCallback(
    (chunk: string, assistantId: string) => {
      safeDispatch({ type: 'STREAM_CHUNK', chunk, assistantId });
    },
    [safeDispatch],
  );

  const endAssistantStream = useCallback(
    (assistantId: string) => {
      safeDispatch({ type: 'STREAM_END', assistantId });
    },
    [safeDispatch],
  );

  const setError = useCallback(
    (msg: string) => {
      safeDispatch({ type: 'ERROR', error: msg });
      onError?.(msg);
    },
    [safeDispatch, onError],
  );

  const clear = useCallback(() => {
    cancelPending();
    safeDispatch({ type: 'CLEAR' });
  }, [cancelPending, safeDispatch]);

  const trimHistory = useCallback(() => {
    safeDispatch({ type: 'TRIM', maxMessages });
  }, [safeDispatch, maxMessages]);

  // ── Periyodik trim — maxMessages aşılınca otomatik (§ 17.3) ──
  useEffect(() => {
    if (state.messages.length > maxMessages + 50) {
      safeDispatch({ type: 'TRIM', maxMessages });
    }
  }, [state.messages.length, maxMessages, safeDispatch]);

  // ── Memoized computed ──
  const isEmpty = useMemo(
    () => state.messages.filter((m) => m.role !== 'system').length === 0,
    [state.messages],
  );

  const canSend = useMemo(
    () => state.sendStatus === 'idle' || state.sendStatus === 'error',
    [state.sendStatus],
  );

  // ── Cleanup on unmount ──
  useEffect(() => {
    return () => {
      _activeAbortRef.current?.abort();
    };
  }, []);

  return {
    messages:             state.messages,
    sendStatus:           state.sendStatus,
    lastError:            state.lastError,
    pendingId:            state.pendingId,
    isEmpty,
    canSend,
    sendMessage,
    startAssistantStream,
    appendAssistantChunk,
    endAssistantStream,
    cancelPending,
    setError,
    clear,
    trimHistory,
  };
}
