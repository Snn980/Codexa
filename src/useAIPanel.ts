/**
 * hooks/useAIPanel.ts
 *
 * § 57 — AIPanelScreen için özel hook.
 *
 * EventBus'tan aktif editör durumunu dinler,
 * useAIOrchestrator'a § 56 arayüzüyle bağlanır.
 *
 * § 1  : Result<T>
 * § 3  : EventBus unsub cleanup
 * § 8  : mountedRef + useCallback + useMemo
 * § 56 : useAIOrchestrator
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAIOrchestrator } from './useAIOrchestrator';
import type { AIOrchestrator } from '../ai/orchestration/AIOrchestrator';
import type { AIPermissionStatus } from '../permission/PermissionGate';
import type { IEventBus } from '../core/EventBus';
import type { SentryService } from '../monitoring/SentryService';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const MAX_SELECTION_CHARS = 2000; // § 57

// ─── Aktif Dosya Bağlamı ─────────────────────────────────────────────────────

export interface ActiveFileContext {
  fileId:    string;
  fileName:  string;
  language:  string;
  content:   string;
  /** Editörde seçili metin — yoksa '' */
  selection: string;
}

// ─── QuickAction ──────────────────────────────────────────────────────────────

export type QuickActionKind = 'explain' | 'debug' | 'refactor' | 'test' | 'docs';

const QUICK_ACTION_PROMPTS: Record<QuickActionKind, (code: string, lang: string) => string> = {
  explain:  (c, l) => `Bu kodu açıkla:\n\`\`\`${l}\n${c}\n\`\`\``,
  debug:    (c, l) => `Neden hata veriyor:\n\`\`\`${l}\n${c}\n\`\`\``,
  refactor: (c, l) => `Bunu daha temiz yaz:\n\`\`\`${l}\n${c}\n\`\`\``,
  test:     (c, l) => `Bu fonksiyon için test yaz:\n\`\`\`${l}\n${c}\n\`\`\``,
  docs:     (c, l) => `JSDoc ekle:\n\`\`\`${l}\n${c}\n\`\`\``,
};

// ─── useAIPanel ───────────────────────────────────────────────────────────────

export interface UseAIPanelOptions {
  orchestrator:  AIOrchestrator;
  permission:    PermissionStatus;
  eventBus:      IEventBus;
  sentryService: SentryService;
}

export interface UseAIPanelReturn {
  /** § 56 orchestrator state — messages, status, lastResult */
  orchestratorState: ReturnType<typeof useAIOrchestrator>;
  /** Şu anki editör bağlamı */
  activeFile: ActiveFileContext | null;
  /** QuickAction tetikleyici */
  triggerQuickAction: (kind: QuickActionKind) => void;
  /** Serbest mesaj gönder */
  sendMessage: (text: string) => void;
}

export function useAIPanel({
  orchestrator,
  permission,
  eventBus,
  sentryService,
}: UseAIPanelOptions): UseAIPanelReturn {

  const [activeFile, setActiveFile] = useState<ActiveFileContext | null>(null);

  // § 8 — mountedRef
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // § 56 — orchestrator hook
  const orch = useAIOrchestrator({
    orchestrator,
    permission,
    onEvent: (event, detail) => {
      // § 32 ek — Sentry AI panel events
      sentryService.captureAIEvent(event, detail);
    },
  });

  // ─── EventBus dinleyicileri ─────────────────────────────────────────────────

  useEffect(() => {
    // § 3 — tüm unsub'lar return fonksiyonunda
    const u1 = eventBus.on('editor:tab:focused', ({ fileId }) => {
      if (!mountedRef.current) return;
      setActiveFile(prev => prev ? { ...prev, fileId } : null);
    });

    // editor:file:loaded — tam dosya bağlamı (fileId, fileName, language, content)
    const u2 = eventBus.on(
      'editor:file:loaded',
      ({ fileId, fileName, language, content }) => {
        if (!mountedRef.current) return;
        setActiveFile({ fileId, fileName, language, content, selection: '' });
      },
    );

    // editor:selection:changed — seçim güncelleme
    const u3 = eventBus.on(
      'editor:selection:changed',
      ({ selection }) => {
        if (!mountedRef.current) return;
        setActiveFile(prev => prev ? { ...prev, selection } : null);
      },
    );

    // editor:content:changed — içerik güncelleme (AI bağlamı için)
    const u4 = eventBus.on(
      'editor:content:changed',
      ({ fileId, content }) => {
        if (!mountedRef.current) return;
        setActiveFile(prev =>
          prev && prev.fileId === fileId ? { ...prev, content } : prev,
        );
      },
    );

    return () => { u1(); u2(); u3(); u4(); };
  }, [eventBus]);

  // ─── sendMessage ────────────────────────────────────────────────────────────

  const sendMessage = useCallback((text: string) => {
    orch.send(text);
  }, [orch]);

  // ─── triggerQuickAction ─────────────────────────────────────────────────────

  const triggerQuickAction = useCallback((kind: QuickActionKind) => {
    if (!activeFile) return;

    // Seçim yoksa dosya içeriğinin ilk MAX_SELECTION_CHARS karakterini kullan (§ 57)
    const code = activeFile.selection.trim()
      ? activeFile.selection
      : activeFile.content.slice(0, MAX_SELECTION_CHARS);

    if (!code.trim()) return;

    const prompt = QUICK_ACTION_PROMPTS[kind](code, activeFile.language);
    orch.send(prompt);
  }, [activeFile, orch]);

  return useMemo(() => ({
    orchestratorState: orch,
    activeFile,
    triggerQuickAction,
    sendMessage,
  }), [orch, activeFile, triggerQuickAction, sendMessage]);
}
