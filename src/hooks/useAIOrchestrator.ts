/**
 * hooks/useAIOrchestrator.ts
 *
 * § 56 — AIOrchestrator için React hook.
 *
 * useAIChat dokunulmaz; bu hook paralel olarak mevcuttur.
 * AIChatScreen yeni hook'a kademeli geçebilir.
 *
 * Farklar (useAIChat'e göre):
 *   • Model kararı kullanıcıdan değil IntentEngine + ModelRouter'dan gelir.
 *   • Her cevap self-critique skoruyla işaretlenir.
 *   • escalated flag UI'da "Bulut modeli kullanıldı" bildirimini tetikler.
 *   • onOrchestrationEvent: debug / analytics için.
 *
 * FIX-1: STREAM_START sırası düzeltildi — orchestrator.run()'dan ÖNCE dispatch.
 * FIX-2: Return değeri flat yapıldı — { state, ... } yerine { messages, status, ... }
 * FIX-3: UseAIOrchestratorReturn interface flat shape yansıtıyor.
 *
 * § 1  : Result<T>
 * § 8  : mountedRef + useCallback + useMemo
 * § 34 : Worker protokolü (IAIWorkerClient)
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';

import { generateId }             from '../utils/uuid';
import type { AIOrchestrator }    from '../ai/orchestration/AIOrchestrator';
import type { ChatMessage }       from './useAIChat';
import type { OrchestrationResult } from '../ai/orchestration/types';
import type { AIPermissionStatus } from '../permission/PermissionGate';

// ─── State ────────────────────────────────────────────────────────────────────

export type OrchestratorStatus = 'idle' | 'analyzing' | 'streaming' | 'error';

export interface OrchestratorState {
  readonly messages:     readonly ChatMessage[];
  readonly status:       OrchestratorStatus;
  readonly lastError:    string | null;
  readonly pendingId:    string | null;
  /** Son orchestration metadata */
  readonly lastResult:   Pick<OrchestrationResult, 'modelUsed' | 'escalated' | 'qualityScore' | 'durationMs'> | null;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

type Action =
  | { type: 'ANALYZING' }
  | { type: 'STREAM_START'; assistantId: string; userMsg: ChatMessage }
  | { type: 'STREAM_CHUNK'; chunk: string; assistantId: string }
  | { type: 'STREAM_END';   assistantId: string; result: OrchestrationResult }
  | { type: 'ERROR';        error: string }
  | { type: 'CANCEL' }
  | { type: 'CLEAR' };

// ─── Reducer ─────────────────────────────────────────────────────────────────

const INITIAL: OrchestratorState = {
  messages:   [],
  status:     'idle',
  lastError:  null,
  pendingId:  null,
  lastResult: null,
};

function reducer(state: OrchestratorState, action: Action): OrchestratorState {
  switch (action.type) {

    case 'ANALYZING':
      return { ...state, status: 'analyzing', lastError: null };

    case 'STREAM_START': {
      const assistantMsg: ChatMessage = {
        id:        action.assistantId,
        role:      'assistant',
        content:   '',
        timestamp: Date.now(),
      };
      return {
        ...state,
        status:    'streaming',
        pendingId: action.assistantId,
        messages:  [...state.messages, action.userMsg, assistantMsg],
      };
    }

    case 'STREAM_CHUNK': {
      // FIX-1: pendingId eşleşmesi — STREAM_START önce geldiğinden artık çalışır
      if (state.pendingId !== action.assistantId) return state;
      return {
        ...state,
        messages: state.messages.map(m =>
          m.id === action.assistantId
            ? { ...m, content: m.content + action.chunk }
            : m,
        ),
      };
    }

    case 'STREAM_END': {
      const { result } = action;
      return {
        ...state,
        status:    'idle',
        pendingId: null,
        lastResult: {
          modelUsed:    result.modelUsed,
          escalated:    result.escalated,
          qualityScore: result.qualityScore,
          durationMs:   result.durationMs,
        },
      };
    }

    case 'ERROR':
      return { ...state, status: 'error', lastError: action.error, pendingId: null };

    case 'CANCEL':
      return { ...state, status: 'idle', pendingId: null };

    case 'CLEAR':
      return INITIAL;

    default:
      return state;
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseAIOrchestratorOptions {
  orchestrator:  AIOrchestrator;
  permission:    AIPermissionStatus;
  onEvent?:      (event: 'escalated' | 'low_quality' | 'timeout', detail: unknown) => void;
}

/**
 * FIX-2: Return değeri flat — AIChatScreenV2, AIPanelScreen destructure ile kullanır.
 * Önceki: { state, send, cancel, clear, isBusy }
 * Yeni:   { messages, status, lastResult, lastError, pendingId, isBusy, send, cancel, clear }
 */
export interface UseAIOrchestratorReturn {
  // State fields — flat (state.X yerine doğrudan X)
  messages:    readonly ChatMessage[];
  status:      OrchestratorStatus;
  lastResult:  OrchestratorState['lastResult'];
  lastError:   string | null;
  pendingId:   string | null;
  // Computed
  isBusy:      boolean;
  // Actions
  send:        (message: string) => Promise<void>;
  cancel:      () => void;
  clear:       () => void;
}

export function useAIOrchestrator({
  orchestrator,
  permission,
  onEvent,
}: UseAIOrchestratorOptions): UseAIOrchestratorReturn {

  const [state, dispatch] = useReducer(reducer, INITIAL);
  const mountedRef        = useRef(true);
  const abortRef          = useRef<AbortController | null>(null);
  const messagesRef       = useRef<readonly ChatMessage[]>([]);

  // messagesRef her render'da güncelle — send closure'ında stale olmaz
  messagesRef.current = state.messages;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── dispatch wrapper — unmount sonrası state güncellemesi yok ─────────────
  const safeDispatch = useCallback((action: Action) => {
    if (mountedRef.current) dispatch(action);
  }, []);

  // ── send ──────────────────────────────────────────────────────────────────
  const send = useCallback(async (message: string) => {
    if (state.status === 'streaming' || state.status === 'analyzing') return;

    // Önceki isteği iptal et
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const assistantId = generateId();
    const userMsg: ChatMessage = {
      id:        generateId(),
      role:      'user',
      content:   message,
      timestamp: Date.now(),
    };

    // FIX-1: STREAM_START önce — reducer'da pendingId set edilir
    // Böylece onChunk → STREAM_CHUNK reducer pendingId eşleşmesini bulur
    safeDispatch({ type: 'ANALYZING' });
    safeDispatch({ type: 'STREAM_START', assistantId, userMsg });

    const result = await orchestrator.run({
      userMessage: message,
      history:     messagesRef.current,
      permission,
      signal:      ctrl.signal,
      onChunk: (chunk) => {
        // pendingId artık set edilmiş durumda — chunk'lar düşmez
        safeDispatch({ type: 'STREAM_CHUNK', chunk, assistantId });
      },
      onComplete: (_fullText, _modelUsed) => {
        // STREAM_END action'da ele alınır
      },
    });

    if (ctrl.signal.aborted) {
      safeDispatch({ type: 'CANCEL' });
      return;
    }

    if (!result.ok) {
      safeDispatch({ type: 'ERROR', error: result.error.message });
      return;
    }

    safeDispatch({ type: 'STREAM_END', assistantId, result: result.data });

    // Event callback'ler
    if (result.data.escalated) {
      onEvent?.('escalated', { modelUsed: result.data.modelUsed });
    }
    if (result.data.qualityScore < 0.7) {
      onEvent?.('low_quality', { score: result.data.qualityScore });
    }

   
  }, [state.status, orchestrator, permission, safeDispatch, onEvent]);

  // ── cancel ────────────────────────────────────────────────────────────────
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    safeDispatch({ type: 'CANCEL' });
  }, [safeDispatch]);

  // ── clear ─────────────────────────────────────────────────────────────────
  const clear = useCallback(() => {
    abortRef.current?.abort();
    safeDispatch({ type: 'CLEAR' });
  }, [safeDispatch]);

  const isBusy = useMemo(
    () => state.status === 'analyzing' || state.status === 'streaming',
    [state.status],
  );

  // FIX-2: Flat return — state.X yerine doğrudan X alanları
  return {
    messages:   state.messages,
    status:     state.status,
    lastResult: state.lastResult,
    lastError:  state.lastError,
    pendingId:  state.pendingId,
    isBusy,
    send,
    cancel,
    clear,
  };
}
