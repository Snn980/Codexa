/**
 * hooks/useInlineCompletionBridge.ts
 *
 * § 58 — Inline Completion → AIOrchestrator kalite kapısı.
 *
 * useCodeCompletion hızlı yolu (AIWorkerClient) korur.
 * Kalite skoru INLINE_ESCALATION_THRESHOLD altındaysa
 * AIOrchestrator üzerinden code_complete intent ile tekrar dener.
 *
 * Arayüz: CodeCompletionState & CodeCompletionActions
 * → CodeCompletionOverlay değişmez.
 *
 * § 1  : Result<T>
 * § 8  : mountedRef + useCallback + useRef timer
 * § 15 : AbortSignal + iptal guard
 * § 55 : ResponseAggregator kalite skoru
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  useCodeCompletion,
  type CodeCompletionState,
  type CodeCompletionActions,
  type CursorContext,
  type CompletionSuggestion,
} from './useCodeCompletion';
import type { IAIWorkerClient } from '../ai/AIWorkerClient';
import type { AIOrchestrator }  from '../ai/orchestration/AIOrchestrator';
import type { AIModelId }       from '../ai/AIModels';
import type { AIPermissionStatus } from '../permission/PermissionGate';
import { ResponseAggregator }   from '../ai/orchestration/ResponseAggregator';
import { IntentCategory }       from '../ai/orchestration/types';
import { generateId }           from '../utils/uuid';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

/** § 58 — Bu eşiğin altında orchestrator escalation tetiklenir */
const INLINE_ESCALATION_THRESHOLD = 0.5;

/** § 58 — Minimum escalation aralığı (throttle) */
const INLINE_ESCALATION_COOLDOWN_MS = 5_000;

// ─── useInlineCompletionBridge ────────────────────────────────────────────────

export interface UseInlineCompletionBridgeOptions {
  workerClient:  IAIWorkerClient;
  orchestrator:  AIOrchestrator;
  permission:    AIPermissionStatus;
  activeModelId: AIModelId | null;
  onAccept:      (insertText: string, ctx: CursorContext) => void;
  /** Escalation gerçekleştiğinde Sentry / analytics için */
  onEscalation?: (score: number) => void;
  enabled?:      boolean;
}

export function useInlineCompletionBridge(
  opts: UseInlineCompletionBridgeOptions,
): CodeCompletionState & CodeCompletionActions {

  const {
    workerClient,
    orchestrator,
    permission,
    activeModelId,
    onAccept,
    onEscalation,
    enabled = true,
  } = opts;

  // ─── Temel hook ────────────────────────────────────────────────────────────
  // useCodeCompletion → hızlı path (§ 5 AIWorkerClient)
  const base = useCodeCompletion({
    workerClient,
    activeModelId,
    onAccept,
    enabled,
  });

  // ─── Escalation state ──────────────────────────────────────────────────────

  const [escalatedSuggestions, setEscalatedSuggestions] = useState<CompletionSuggestion[] | null>(null);
  const lastEscalationRef   = useRef<number>(0);
  const escalationAbortRef  = useRef<AbortController | null>(null);
  const lastCtxRef          = useRef<CursorContext | null>(null);
  const mountedRef          = useRef(true);
  const aggregator          = useMemo(() => new ResponseAggregator(), []);

  // § 8 — mountedRef
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      escalationAbortRef.current?.abort();
    };
  }, []);

  // ─── Kalite kontrolü ve escalation ────────────────────────────────────────

  const tryEscalate = useCallback(async (ctx: CursorContext) => {
    const now = Date.now();

    // Throttle: INLINE_ESCALATION_COOLDOWN_MS aralığından önce tekrar deneme
    if (now - lastEscalationRef.current < INLINE_ESCALATION_COOLDOWN_MS) return;
    lastEscalationRef.current = now;

    // Önceki escalation isteğini iptal et
    escalationAbortRef.current?.abort();
    const abortCtrl = new AbortController();
    escalationAbortRef.current = abortCtrl;

    // Orchestrator üzerinden code_complete intent
    const chunks: string[] = [];
    const result = await orchestrator.run({
      userMessage: `${ctx.prefix}`,
      history:     [],
      permission,
      signal:      abortCtrl.signal,
      onChunk:     (chunk) => { chunks.push(chunk); },
    });

    if (abortCtrl.signal.aborted || !mountedRef.current) return;
    if (!result.ok) return;

    const fullText = result.value.fullText.trim();
    if (!fullText) return;

    // Self-critique: § 55 ResponseAggregator
    const intentObj = {
      category:        IntentCategory.CODE_COMPLETE,
      confidence:      1.0,
      requiresCode:    true,
      requiresContext: false,
      estimatedTokens: Math.ceil(fullText.length / 4),
    };
    const quality = aggregator.score(fullText, intentObj);

    onEscalation?.(quality.score);

    // Satır bazlı öneri listesi
    const lines = fullText
      .split('\n')
      .map((l: string) => l.trimEnd())
      .filter(Boolean)
      .slice(0, 3);

    const suggestions: CompletionSuggestion[] = lines.map((line: string) => ({
      id:           generateId(),
      text:         line,
      insertOffset: 0,
    }));

    setEscalatedSuggestions(suggestions);
  }, [orchestrator, permission, aggregator, onEscalation]);

  // ─── onEditorChange wrapper ────────────────────────────────────────────────

  const onEditorChange = useCallback((ctx: CursorContext) => {
    lastCtxRef.current = ctx;
    // Escalation önerilerini sıfırla — kullanıcı yazmaya devam etti
    setEscalatedSuggestions(null);
    base.onEditorChange(ctx);
  }, [base]);

  // ─── Kalite izleme: base ready → skor kontrol ─────────────────────────────

  useEffect(() => {
    if (base.status !== 'ready' || base.suggestions.length === 0) return;

    // Mevcut önerilerin ilk satırını hızlı skor
    const sample  = base.suggestions.map(s => s.text).join('\n');
    const intentObj = {
      category:        IntentCategory.CODE_COMPLETE,
      confidence:      1.0,
      requiresCode:    true,
      requiresContext: false,
      estimatedTokens: Math.ceil(sample.length / 4),
    };
    const quality = aggregator.score(sample, intentObj);

    if (quality.score < INLINE_ESCALATION_THRESHOLD && lastCtxRef.current) {
      tryEscalate(lastCtxRef.current);
    }
  }, [base.status, base.suggestions, aggregator, tryEscalate]);

  // ─── acceptSuggestion ──────────────────────────────────────────────────────

  const acceptSuggestion = useCallback((suggestion: CompletionSuggestion) => {
    const ctx = lastCtxRef.current;
    if (!ctx) return;
    onAccept(suggestion.text, ctx);
    setEscalatedSuggestions(null);
    base.dismiss();
  }, [onAccept, base]);

  // ─── dismiss ───────────────────────────────────────────────────────────────

  const dismiss = useCallback(() => {
    escalationAbortRef.current?.abort();
    setEscalatedSuggestions(null);
    base.dismiss();
  }, [base]);

  // ─── Birleşik state ────────────────────────────────────────────────────────
  // Escalated öneri varsa base önerilerin yerini alır

  const suggestions = escalatedSuggestions ?? base.suggestions;
  const status      = base.status;
  const isVisible   = base.isVisible;

  return useMemo(() => ({
    suggestions,
    status,
    isVisible,
    onEditorChange,
    acceptSuggestion,
    dismiss,
  }), [suggestions, status, isVisible, onEditorChange, acceptSuggestion, dismiss]);
}
