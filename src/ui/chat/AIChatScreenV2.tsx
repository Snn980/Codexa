/**
 * ui/chat/AIChatScreenV2.tsx
 *
 * § 59 — useAIOrchestrator (§ 56) kullanan yeni implementasyon.
 *
 * AIChatScreenLegacy ile aynı UI atomlarını paylaşır (_shared.tsx).
 * Ek özellikler:
 *   • status === 'analyzing' → "Analiz ediliyor…"
 *   • lastResult.escalated   → EscalationChip
 *   • qualityScore < 0.7     → LowQualityToast
 *   • onEvent → SentryService (§ 32 ek)
 *
 * Hook:   useAIOrchestrator (§ 56) — koşulsuz, her zaman aynı hook
 *
 * § 8  : React.memo + useRef
 * § 23 : FlatList keyExtractor → item.id
 * § 32 : Sentry AI event capture
 * § 56 : useAIOrchestrator
 */

import React, {
  memo,
  useCallback,
  useRef,
  useState,
} from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';

import type { AppContainer }  from '../../app/AppContainer';
import { useAIOrchestrator }  from '../../hooks/useAIOrchestrator';
import { AIWorkerClient }     from '../../ai/AIWorkerClient';
import { generateId }         from '../../utils/uuid';
import type { ChatMessage }   from '../../hooks/useAIChat';
import {
  ChatBubble,
  EscalationChip,
  LowQualityToast,
  InputBar,
  StatusRow,
  S,
} from './_shared';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AIChatScreenV2Props {
  container:         AppContainer;
  initialSessionId?: string;
}

// ─── AIChatScreenV2 ───────────────────────────────────────────────────────────

export const AIChatScreenV2 = memo(({
  container,
}: AIChatScreenV2Props): React.ReactElement => {

  const bridge         = container.bridge;
  const permissionGate = container.permissionGate;
  const sentryService  = container.sentryService;

  // § 8 — AIWorkerClient ref pattern
  const workerClientRef = useRef<AIWorkerClient | null>(null);
  if (!workerClientRef.current) {
    workerClientRef.current = new AIWorkerClient(bridge, generateId);
  }

  const permission = permissionGate.getStatus();

  // ─── Hook: useAIOrchestrator ──────────────────────────────────────────────
  // Koşulsuz çağrı — hook kuralı ihlali yok (§ 8)

  const {
    messages,
    status,
    lastResult,
    isBusy,
    send,
    cancel,
  } = useAIOrchestrator({
    orchestrator: container.orchestrator,
    permission,
    onEvent: (event, detail) => {
      // § 32 ek — Sentry AI panel events
      sentryService.captureAIEvent(event, detail);
    },
  });

  // ─── Input state ──────────────────────────────────────────────────────────

  const [inputText, setInputText] = useState('');

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || isBusy) return;
    setInputText('');
    send(text);
  }, [inputText, isBusy, send]);

  // § 23 — keyExtractor → item.id
  const keyExtractor  = useCallback((item: ChatMessage) => item.id, []);
  const renderMessage = useCallback(
    ({ item }: { item: ChatMessage }) => <ChatBubble message={item} />,
    [],
  );

  // ─── Durum etiketleri ─────────────────────────────────────────────────────

  const statusLabel =
    status === 'analyzing' ? 'Analiz ediliyor…' :
    status === 'streaming' ? 'Yanıt üretiliyor…' :
    null;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={S.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* Escalation / kalite bildirimleri */}
      {lastResult?.escalated && <EscalationChip />}
      {lastResult != null && lastResult.qualityScore < 0.7 && (
        <LowQualityToast score={lastResult.qualityScore} />
      )}

      {/* Mesaj listesi */}
      <FlatList
        data={messages as ChatMessage[]}
        keyExtractor={keyExtractor}
        renderItem={renderMessage}
        style={S.list}
        contentContainerStyle={S.listContent}
        keyboardShouldPersistTaps="handled"
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        testID="chat-message-list"
      />

      {/* Durum satırı */}
      {statusLabel && <StatusRow label={statusLabel} />}

      {/* Input */}
      <InputBar
        value={inputText}
        isBusy={isBusy}
        onChange={setInputText}
        onSend={handleSend}
        onCancel={cancel}
      />
    </KeyboardAvoidingView>
  );
});
AIChatScreenV2.displayName = 'AIChatScreenV2';
