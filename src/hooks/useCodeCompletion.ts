/**
 * hooks/useCodeCompletion.ts — Inline kod tamamlama
 *
 * § 1  : Result<T>
 * § 8  : useRef timer + cleanup
 * Debounce: 300ms (yazma duraksadığında tetikler)
 */

import { useState, useRef, useCallback, useEffect } from "react";
import type { IAIWorkerClient } from "../ai/AIWorkerClient";
import type { AIModelId } from "../ai/AIModels";

// ─── Completion Önerisi ─────────────────────────────────────────────────────

export interface CompletionSuggestion {
  id: string;
  text: string;
  /** Öneri kaç karakter cursor'ın soluna geçecek (genelde 0) */
  insertOffset: number;
}

// ─── Cursor Bağlamı ─────────────────────────────────────────────────────────

export interface CursorContext {
  /** Cursor'ın solundaki metin */
  prefix: string;
  /** Cursor'ın sağındaki metin */
  suffix: string;
  /** Dosya dili (js, ts, tsx, ...) */
  language: string;
}

// ─── Hook Durumu ────────────────────────────────────────────────────────────

export type CompletionStatus = "idle" | "loading" | "ready" | "error";

export interface CodeCompletionState {
  suggestions: CompletionSuggestion[];
  status: CompletionStatus;
  /** Overlay gösterilsin mi */
  isVisible: boolean;
}

export interface CodeCompletionActions {
  /** Editor her değişiklikte çağırır */
  onEditorChange: (ctx: CursorContext) => void;
  /** Kullanıcı öneriyi kabul etti */
  acceptSuggestion: (suggestion: CompletionSuggestion) => void;
  /** Overlay kapat */
  dismiss: () => void;
}

// ─── Sabitler ───────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 300;
const MIN_PREFIX_LENGTH = 2; // Çok kısa prefix'te istek atma
const MAX_SUGGESTIONS = 3;

// ─── useCodeCompletion ──────────────────────────────────────────────────────

export interface UseCodeCompletionOptions {
  workerClient: IAIWorkerClient;
  activeModelId: AIModelId | null;
  /** Öneri kabul edildiğinde çağrılır */
  onAccept: (insertText: string, context: CursorContext) => void;
  enabled?: boolean;
}

export function useCodeCompletion(opts: UseCodeCompletionOptions): CodeCompletionState & CodeCompletionActions {
  const { workerClient, activeModelId, onAccept, enabled = true } = opts;

  const [suggestions, setSuggestions] = useState<CompletionSuggestion[]>([]);
  const [status, setStatus] = useState<CompletionStatus>("idle");
  const [isVisible, setIsVisible] = useState(false);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortCtrlRef = useRef<AbortController | null>(null);
  const lastContextRef = useRef<CursorContext | null>(null);
  const suggestionCounterRef = useRef(0);

  // ─── Debounced fetch ─────────────────────────────────────────────────

  const fetchCompletions = useCallback(async (ctx: CursorContext) => {
    if (!activeModelId || !enabled) return;
    if (ctx.prefix.trimEnd().length < MIN_PREFIX_LENGTH) return;

    // Önceki isteği iptal
    abortCtrlRef.current?.abort();
    const abortCtrl = new AbortController();
    abortCtrlRef.current = abortCtrl;

    setStatus("loading");
    setIsVisible(true);

    const result = await workerClient.requestCompletion(
      {
        model: activeModelId,
        prefix: ctx.prefix,
        suffix: ctx.suffix,
        language: ctx.language,
        maxTokens: 128,
      },
      abortCtrl.signal,
    );

    if (abortCtrl.signal.aborted) return;

    if (!result.ok) {
      setStatus("error");
      setSuggestions([]);
      setIsVisible(false);
      return;
    }

    const completionText = result.data.trim();
    if (!completionText) {
      setStatus("idle");
      setIsVisible(false);
      setSuggestions([]);
      return;
    }

    // Birden fazla satır → birden fazla öneri olarak sun
    const lines = completionText
      .split("\n")
      .map((l: string) => l.trimEnd())
      .filter(Boolean)
      .slice(0, MAX_SUGGESTIONS);

    const newSuggestions: CompletionSuggestion[] = lines.map((line: string) => ({
      id: `s${++suggestionCounterRef.current}`,
      text: line,
      insertOffset: 0,
    }));

    setSuggestions(newSuggestions);
    setStatus("ready");
    setIsVisible(true);
  }, [activeModelId, enabled, workerClient]);

  // ─── onEditorChange ─────────────────────────────────────────────────

  const onEditorChange = useCallback((ctx: CursorContext) => {
    lastContextRef.current = ctx;

    // Debounce temizle
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
    }

    // Çok kısa prefix → overlay gizle
    if (ctx.prefix.trimEnd().length < MIN_PREFIX_LENGTH) {
      abortCtrlRef.current?.abort();
      setIsVisible(false);
      setSuggestions([]);
      setStatus("idle");
      return;
    }

    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      const current = lastContextRef.current;
      if (current) fetchCompletions(current);
    }, DEBOUNCE_MS);
  }, [fetchCompletions]);

  // ─── acceptSuggestion ───────────────────────────────────────────────

  const acceptSuggestion = useCallback((suggestion: CompletionSuggestion) => {
    const ctx = lastContextRef.current;
    if (!ctx) return;
    onAccept(suggestion.text, ctx);
    dismiss();
  }, [onAccept]);

  // ─── dismiss ────────────────────────────────────────────────────────

  const dismiss = useCallback(() => {
    abortCtrlRef.current?.abort();
    abortCtrlRef.current = null;
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setSuggestions([]);
    setIsVisible(false);
    setStatus("idle");
  }, []);

  // ─── Cleanup ────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
      }
      abortCtrlRef.current?.abort();
    };
  }, []);

  return {
    suggestions,
    status,
    isVisible,
    onEditorChange,
    acceptSuggestion,
    dismiss,
  };
}
