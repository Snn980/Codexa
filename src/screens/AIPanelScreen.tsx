/**
 * src/screens/AIPanelScreen.tsx
 *
 * § 57 — Editor içi AI yardımcı paneli (tam implementasyon).
 *
 * Phase 15 placeholder kaldırıldı.
 * useAIPanel hook'u aracılığıyla:
 *   • EventBus'tan aktif dosya / seçim bağlamını alır
 *   • AIOrchestrator (§ 50) üzerinden yanıt üretir
 *   • QuickAction butonları → IntentEngine'e yönlendirilmiş mesajlar
 *   • Escalation / low-quality bildirimleri → Sentry (§ 32 ek)
 *
 * § 4  : AppContainer DI
 * § 8  : React.memo + useRef
 * § 23 : FlatList keyExtractor → item.id
 * § 56 : useAIOrchestrator hook
 */

import React, {
  memo,
  useCallback,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { AppContainer }    from '../app/AppContainer';
import { AIWorkerClient }       from '../ai/AIWorkerClient';
import { useAIPanel }           from '../hooks/useAIPanel';
import type { QuickActionKind } from '../hooks/useAIPanel';
import type { ChatMessage }     from '../hooks/useAIChat';
import { generateId }           from '../utils/uuid';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AIPanelScreenProps {
  container: AppContainer;
}

// ─── QuickAction tanımları ────────────────────────────────────────────────────

interface QuickAction {
  kind:  QuickActionKind;
  label: string;
  icon:  string;
}

const QUICK_ACTIONS: QuickAction[] = [
  { kind: 'explain',  label: 'Açıkla',   icon: '💡' },
  { kind: 'debug',    label: 'Debug',    icon: '🐛' },
  { kind: 'refactor', label: 'Refactor', icon: '✨' },
  { kind: 'test',     label: 'Test',     icon: '🧪' },
  { kind: 'docs',     label: 'JSDoc',    icon: '📝' },
];

// ─── EscalationBadge ──────────────────────────────────────────────────────────

const EscalationBadge = memo(() => (
  <View style={styles.escalationBadge}>
    <Text style={styles.escalationText}>☁ Bulut modeli kullandı</Text>
  </View>
));
EscalationBadge.displayName = 'EscalationBadge';

// ─── ChatBubble ───────────────────────────────────────────────────────────────

interface BubbleProps { message: ChatMessage }

const ChatBubble = memo(({ message }: BubbleProps) => {
  const isUser = message.role === 'user';
  return (
    <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAI]}>
      <Text style={isUser ? styles.bubbleTextUser : styles.bubbleTextAI}>
        {message.content}
      </Text>
    </View>
  );
});
ChatBubble.displayName = 'ChatBubble';

// ─── FileContextBar ───────────────────────────────────────────────────────────

interface FileContextBarProps {
  fileName:  string;
  language:  string;
  hasSelection: boolean;
}

const FileContextBar = memo(({ fileName, language, hasSelection }: FileContextBarProps) => (
  <View style={styles.contextBar}>
    <Text style={styles.contextFileName} numberOfLines={1}>
      📄 {fileName}
    </Text>
    <View style={styles.contextMeta}>
      <View style={styles.langBadge}>
        <Text style={styles.langBadgeText}>{language.toUpperCase()}</Text>
      </View>
      {hasSelection && (
        <View style={styles.selectionBadge}>
          <Text style={styles.selectionBadgeText}>Seçim aktif</Text>
        </View>
      )}
    </View>
  </View>
));
FileContextBar.displayName = 'FileContextBar';

// ─── QuickActionBar ───────────────────────────────────────────────────────────

interface QuickActionBarProps {
  onAction: (kind: QuickActionKind) => void;
  disabled: boolean;
}

const QuickActionBar = memo(({ onAction, disabled }: QuickActionBarProps) => (
  <ScrollView
    horizontal
    showsHorizontalScrollIndicator={false}
    style={styles.quickBar}
    contentContainerStyle={styles.quickBarContent}
    bounces={false}
  >
    {QUICK_ACTIONS.map(({ kind, label, icon }) => (
      <Pressable
        key={kind}
        style={({ pressed }) => [
          styles.quickBtn,
          pressed && styles.quickBtnPressed,
          disabled && styles.quickBtnDisabled,
        ]}
        onPress={() => onAction(kind)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label} aksiyonu`}
      >
        <Text style={styles.quickBtnIcon}>{icon}</Text>
        <Text style={styles.quickBtnLabel}>{label}</Text>
      </Pressable>
    ))}
  </ScrollView>
));
QuickActionBar.displayName = 'QuickActionBar';

// ─── StatusLine ───────────────────────────────────────────────────────────────

interface StatusLineProps {
  status:       string;
  qualityScore: number | null;
  escalated:    boolean;
}

const StatusLine = memo(({ status, qualityScore, escalated }: StatusLineProps) => {
  const label =
    status === 'analyzing'  ? 'Analiz ediliyor…' :
    status === 'streaming'  ? 'Yanıt üretiliyor…' :
    status === 'error'      ? '⚠ Hata oluştu' :
    null;

  return (
    <View style={styles.statusLine}>
      {label && (
        <View style={styles.statusRow}>
          {(status === 'analyzing' || status === 'streaming') && (
            <ActivityIndicator size="small" color={C.accent} style={{ marginRight: 6 }} />
          )}
          <Text style={styles.statusText}>{label}</Text>
        </View>
      )}
      {escalated && <EscalationBadge />}
      {qualityScore !== null && qualityScore < 0.7 && (
        <Text style={styles.lowQualityText}>⚠ Düşük kalite ({(qualityScore * 100).toFixed(0)}%)</Text>
      )}
    </View>
  );
});
StatusLine.displayName = 'StatusLine';

// ─── AIPanelScreen ────────────────────────────────────────────────────────────

export function AIPanelScreen({ container }: AIPanelScreenProps): React.ReactElement {

  // § 4 — AppContainer getter'larından DI
  const orchestrator   = container.orchestrator;
  const permissionGate = container.permissionGate;
  const eventBus       = container.eventBus;
  const sentryService  = container.sentryService;

  // § 56 — AIWorkerClient (bridge'den)
  const workerClientRef = useRef<AIWorkerClient | null>(null);
  if (!workerClientRef.current) {
    workerClientRef.current = new AIWorkerClient(container.bridge, generateId);
  }

  const permission = permissionGate.getStatus();

  const {
    orchestratorState,
    activeFile,
    triggerQuickAction,
    sendMessage,
  } = useAIPanel({ orchestrator, permission, eventBus, sentryService });

  const { messages, status, lastResult, isBusy, cancel, clear } = orchestratorState;

  // ─── Input state ─────────────────────────────────────────────────────────────
  const [inputText, setInputText] = useState('');
  const inputRef = useRef<TextInput>(null);

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || isBusy) return;
    setInputText('');
    sendMessage(text);
  }, [inputText, isBusy, sendMessage]);

  const handleQuickAction = useCallback((kind: QuickActionKind) => {
    if (isBusy) return;
    triggerQuickAction(kind);
  }, [isBusy, triggerQuickAction]);

  // § 23 — keyExtractor → item.id
  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);
  const renderBubble = useCallback(
    ({ item }: { item: ChatMessage }) => <ChatBubble message={item} />,
    [],
  );

  // ─── Render ──────────────────────────────────────────────────────────────────

  const noFile = !activeFile;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={88}
    >
      {/* Başlık */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>AI Asistan</Text>
        {messages.length > 0 && (
          <Pressable
            onPress={clear}
            style={styles.clearBtn}
            accessibilityRole="button"
            accessibilityLabel="Sohbeti temizle"
          >
            <Text style={styles.clearBtnText}>Temizle</Text>
          </Pressable>
        )}
      </View>

      {/* Dosya bağlamı */}
      {activeFile ? (
        <FileContextBar
          fileName={activeFile.fileName}
          language={activeFile.language}
          hasSelection={activeFile.selection.trim().length > 0}
        />
      ) : (
        <View style={styles.noFileBar}>
          <Text style={styles.noFileText}>Editörde bir dosya açın</Text>
        </View>
      )}

      {/* Quick actions */}
      <QuickActionBar
        onAction={handleQuickAction}
        disabled={isBusy || noFile}
      />

      {/* Chat listesi */}
      {messages.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>◈</Text>
          <Text style={styles.emptyTitle}>AI Panel Hazır</Text>
          <Text style={styles.emptyDesc}>
            Yukarıdaki hızlı aksiyonları kullanın{'\n'}veya mesaj yazın
          </Text>
        </View>
      ) : (
        <FlatList
          data={messages as ChatMessage[]}
          keyExtractor={keyExtractor}
          renderItem={renderBubble}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        />
      )}

      {/* Durum satırı */}
      <StatusLine
        status={status}
        qualityScore={lastResult?.qualityScore ?? null}
        escalated={lastResult?.escalated ?? false}
      />

      {/* Input alanı */}
      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={inputText}
          onChangeText={setInputText}
          placeholder="Soru veya komut…"
          placeholderTextColor={C.muted}
          multiline
          maxLength={2000}
          returnKeyType="send"
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
          editable={!isBusy}
          accessibilityLabel="AI mesaj girişi"
        />

        {isBusy ? (
          <Pressable
            style={styles.cancelBtn}
            onPress={cancel}
            accessibilityRole="button"
            accessibilityLabel="İptal et"
          >
            <Text style={styles.cancelBtnText}>■</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.sendBtn, (!inputText.trim() || noFile) && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!inputText.trim() || noFile}
            accessibilityRole="button"
            accessibilityLabel="Gönder"
          >
            <Text style={styles.sendBtnText}>↑</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

// ─── Renkler ──────────────────────────────────────────────────────────────────

const C = {
  bg:        '#0a0e1a',
  surface:   '#0d1117',
  surface2:  '#111827',
  border:    'rgba(255,255,255,0.06)',
  accent:    '#7c6af7',
  accentDim: 'rgba(124,106,247,0.15)',
  text:      '#e2e8f0',
  muted:     '#475569',
  user:      '#3b82f6',
  userDim:   '#1d4ed8',
  warn:      '#fbbf24',
  error:     '#f87171',
  cloud:     '#34d399',
} as const;

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// ─── Stiller ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:            { flex: 1, backgroundColor: C.bg },

  // Başlık
  header:          { flexDirection: 'row', alignItems: 'center',
                     paddingHorizontal: 14, paddingVertical: 10,
                     borderBottomWidth: 1, borderBottomColor: C.border,
                     backgroundColor: C.surface },
  headerTitle:     { flex: 1, fontSize: 14, fontWeight: '700', color: C.accent, fontFamily: MONO },
  clearBtn:        { paddingHorizontal: 8, paddingVertical: 3,
                     borderRadius: 5, borderWidth: 1, borderColor: C.border },
  clearBtnText:    { fontSize: 11, color: C.muted },

  // Dosya bağlamı
  contextBar:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                     paddingHorizontal: 12, paddingVertical: 6,
                     backgroundColor: C.surface2,
                     borderBottomWidth: 1, borderBottomColor: C.border },
  contextFileName: { flex: 1, fontSize: 11, color: C.text, fontFamily: MONO, marginRight: 8 },
  contextMeta:     { flexDirection: 'row', gap: 6 },
  langBadge:       { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
                     backgroundColor: C.accentDim },
  langBadgeText:   { fontSize: 9, color: C.accent, fontWeight: '700', fontFamily: MONO },
  selectionBadge:  { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
                     backgroundColor: 'rgba(52,211,153,0.12)' },
  selectionBadgeText: { fontSize: 9, color: C.cloud, fontWeight: '600' },
  noFileBar:       { paddingHorizontal: 12, paddingVertical: 6,
                     backgroundColor: C.surface2,
                     borderBottomWidth: 1, borderBottomColor: C.border,
                     alignItems: 'center' },
  noFileText:      { fontSize: 11, color: C.muted, fontFamily: MONO },

  // Quick actions
  quickBar:        { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: C.border },
  quickBarContent: { flexDirection: 'row', paddingHorizontal: 8,
                     paddingVertical: 8, gap: 6 },
  quickBtn:        { flexDirection: 'row', alignItems: 'center', gap: 4,
                     paddingHorizontal: 10, paddingVertical: 5,
                     borderRadius: 16, borderWidth: 1,
                     borderColor: C.border, backgroundColor: C.surface2 },
  quickBtnPressed: { backgroundColor: C.accentDim, borderColor: C.accent },
  quickBtnDisabled:{ opacity: 0.4 },
  quickBtnIcon:    { fontSize: 12 },
  quickBtnLabel:   { fontSize: 11, color: C.text, fontWeight: '500' },

  // Chat listesi
  list:            { flex: 1 },
  listContent:     { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },

  // Bubble
  bubble:          { maxWidth: '85%', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleUser:      { alignSelf: 'flex-end', backgroundColor: C.user },
  bubbleAI:        { alignSelf: 'flex-start', backgroundColor: C.surface2,
                     borderWidth: 1, borderColor: C.border },
  bubbleTextUser:  { color: '#fff', fontSize: 13, lineHeight: 19 },
  bubbleTextAI:    { color: C.text, fontSize: 13, lineHeight: 19, fontFamily: MONO },

  // Boş durum
  emptyState:      { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyIcon:       { fontSize: 32, color: C.muted },
  emptyTitle:      { fontSize: 14, fontWeight: '700', color: C.muted, fontFamily: MONO },
  emptyDesc:       { fontSize: 11, color: '#2d3748', fontFamily: MONO,
                     textAlign: 'center', lineHeight: 18 },

  // Durum satırı
  statusLine:      { minHeight: 28, paddingHorizontal: 12, paddingVertical: 4,
                     flexDirection: 'row', alignItems: 'center', gap: 8,
                     borderTopWidth: 1, borderTopColor: C.border,
                     backgroundColor: C.surface },
  statusRow:       { flexDirection: 'row', alignItems: 'center' },
  statusText:      { fontSize: 11, color: C.accent, fontFamily: MONO },
  escalationBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
                     backgroundColor: 'rgba(52,211,153,0.12)' },
  escalationText:  { fontSize: 10, color: C.cloud, fontWeight: '600' },
  lowQualityText:  { fontSize: 10, color: C.warn },

  // Input
  inputRow:        { flexDirection: 'row', alignItems: 'flex-end', gap: 8,
                     paddingHorizontal: 12, paddingVertical: 10,
                     borderTopWidth: 1, borderTopColor: C.border,
                     backgroundColor: C.surface },
  input:           { flex: 1, minHeight: 36, maxHeight: 100,
                     backgroundColor: C.surface2,
                     borderRadius: 10, borderWidth: 1, borderColor: C.border,
                     paddingHorizontal: 12, paddingVertical: 8,
                     color: C.text, fontSize: 13, fontFamily: MONO },
  sendBtn:         { width: 36, height: 36, borderRadius: 18,
                     backgroundColor: C.accent,
                     alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border },
  sendBtnText:     { fontSize: 16, color: '#fff', fontWeight: '700' },
  cancelBtn:       { width: 36, height: 36, borderRadius: 18,
                     backgroundColor: C.error,
                     alignItems: 'center', justifyContent: 'center' },
  cancelBtnText:   { fontSize: 12, color: '#fff', fontWeight: '700' },
});
