/**
 * ui/chat/AIChatScreenLegacy.tsx
 *
 * § 59 — useAIChat (§ 5) kullanan orijinal implementasyon.
 *         Phase 15 öncesi davranış — sıfır regresyon garantisi.
 *
 * Hook:   useAIChat
 * Özel:   —
 *
 * § 5  : Worker protokolü
 * § 8  : React.memo + useRef
 * § 16 : idempotencyKey
 * § 23 : FlatList keyExtractor → item.id
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

import type { AppContainer } from '../../app/AppContainer';
import { useAIChat }         from '../../hooks/useAIChat';
import { AIWorkerClient }    from '../../ai/AIWorkerClient';
import type { UUID } from '../../types/core';
import { generateId }        from '../../utils/uuid';
import type { ChatMessage }  from '../../hooks/useAIChat';
import {
  ChatBubble,
  InputBar,
  StatusRow,
  S,
} from './_shared';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AIChatScreenLegacyProps {
  container:         AppContainer;
  initialSessionId?: string;
  otaIntervalMs?:    number;
}

// ─── AIChatScreenLegacy ───────────────────────────────────────────────────────

export const AIChatScreenLegacy = memo(({
  container,
}: AIChatScreenLegacyProps): React.ReactElement => {

  const bridge = container.bridge;

  // AIWorkerClient — sadece bir kez oluşturulur (§ 8 ref pattern)
  const workerClientRef = useRef<AIWorkerClient | null>(null);
  if (!workerClientRef.current) {
    workerClientRef.current = new AIWorkerClient(bridge, generateId as () => UUID);
  }

  const workerClient = workerClientRef.current;

  // ─── Hook: useAIChat ──────────────────────────────────────────────────────
  // FIX-6: useAIChat options sadece { sendFn?, maxMessages?, onError? } alır.
  // workerClient.streamChat'i sendFn olarak inject et.

  const {
    messages,
    sendStatus,
    sendMessage,
    cancelPending,
  } = useAIChat({
    sendFn: async function* (msgs, signal) {
      yield* workerClient.streamChat(
        {
          model:     'offline-gemma3-1b' as import('../../ai/AIModels').AIModelId,
          messages:  msgs.map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content })),
          maxTokens: 1024,
        },
        signal,
      );
    },
  });

  const isStreaming = sendStatus === 'streaming' || sendStatus === 'pending';

  // ─── Input state ──────────────────────────────────────────────────────────

  const [inputText, setInputText] = useState('');

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || isStreaming) return;
    setInputText('');
    sendMessage(text);
  }, [inputText, isStreaming, sendMessage]);

  const handleCancel = useCallback(() => {
    cancelPending();
  }, [cancelPending]);

  // § 23 — keyExtractor → item.id
  const keyExtractor  = useCallback((item: ChatMessage) => item.id, []);
  const renderMessage = useCallback(
    ({ item }: { item: ChatMessage }) => <ChatBubble message={item} />,
    [],
  );

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={S.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <FlatList
        data={messages as ChatMessage[]}
        keyExtractor={keyExtractor}
        renderItem={renderMessage}
        style={S.list}
        contentContainerStyle={S.listContent}
        keyboardShouldPersistTaps="handled"
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      />

      {isStreaming && <StatusRow label="Yanıt üretiliyor…" />}

      <InputBar
        value={inputText}
        isBusy={isStreaming}
        onChange={setInputText}
        onSend={handleSend}
        onCancel={handleCancel}
      />
    </KeyboardAvoidingView>
  );
});
AIChatScreenLegacy.displayName = 'AIChatScreenLegacy';
