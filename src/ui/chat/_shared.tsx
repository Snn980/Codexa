/**
 * ui/chat/_shared.tsx
 *
 * § 59 — AIChatScreenLegacy ve AIChatScreenV2 arasında
 *         paylaşılan atom bileşenler ve stiller.
 *
 * Bu dosya doğrudan render edilmez; import edilir.
 *
 * § 8 : React.memo
 */

import React, { memo } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ChatMessage } from '../../hooks/useAIChat';

// ─── Renkler & tipografi ──────────────────────────────────────────────────────

export const C = {
  bg:        '#0a0e1a',
  surface:   '#0d1117',
  surface2:  '#111827',
  border:    'rgba(255,255,255,0.06)',
  accent:    '#7c6af7',
  user:      '#3b82f6',
  text:      '#e2e8f0',
  muted:     '#475569',
  error:     '#f87171',
  cloud:     '#34d399',
  warn:      '#fbbf24',
} as const;

export const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// ─── ChatBubble ───────────────────────────────────────────────────────────────

export const ChatBubble = memo(({ message }: { message: ChatMessage }) => {
  const isUser = message.role === 'user';
  return (
    <View style={[S.bubble, isUser ? S.bubbleUser : S.bubbleAI]}>
      <Text
        style={isUser ? S.bubbleTextUser : S.bubbleTextAI}
        selectable
      >
        {message.content}
      </Text>
    </View>
  );
});
ChatBubble.displayName = 'ChatBubble';

// ─── EscalationChip ──────────────────────────────────────────────────────────

export const EscalationChip = memo(() => (
  <View style={S.chip}>
    <Text style={S.chipText}>☁ Bulut modeli kullandı</Text>
  </View>
));
EscalationChip.displayName = 'EscalationChip';

// ─── LowQualityToast ─────────────────────────────────────────────────────────

export const LowQualityToast = memo(({ score }: { score: number }) => (
  <View style={S.toast}>
    <Text style={S.toastText}>
      ⚠ Düşük kalite ({(score * 100).toFixed(0)}%)
    </Text>
  </View>
));
LowQualityToast.displayName = 'LowQualityToast';

// ─── StatusRow ────────────────────────────────────────────────────────────────

export const StatusRow = memo(({ label }: { label: string }) => (
  <View style={S.statusRow}>
    <ActivityIndicator size="small" color={C.accent} />
    <Text style={S.statusText}>{label}</Text>
  </View>
));
StatusRow.displayName = 'StatusRow';

// ─── InputBar ─────────────────────────────────────────────────────────────────

export interface InputBarProps {
  value:      string;
  isBusy:     boolean;
  onChange:   (text: string) => void;
  onSend:     () => void;
  onCancel:   () => void;
}

export const InputBar = memo(({
  value, isBusy, onChange, onSend, onCancel,
}: InputBarProps) => (
  <View style={S.inputRow}>
    <TextInput
      style={S.input}
      value={value}
      onChangeText={onChange}
      placeholder="Mesaj…"
      placeholderTextColor={C.muted}
      multiline
      maxLength={2000}
      returnKeyType="send"
      onSubmitEditing={onSend}
      blurOnSubmit={false}
      editable={!isBusy}
      accessibilityLabel="AI mesaj girişi"
      testID="chat-input"
    />
    {isBusy ? (
      <Pressable
        style={S.cancelBtn}
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel="İptal et"
        testID="cancel-button"
      >
        <Text style={S.cancelBtnText}>■</Text>
      </Pressable>
    ) : (
      <Pressable
        style={[S.sendBtn, !value.trim() && S.sendBtnDisabled]}
        onPress={onSend}
        disabled={!value.trim()}
        accessibilityRole="button"
        accessibilityLabel="Gönder"
        testID="send-button"
      >
        <Text style={S.sendBtnText}>↑</Text>
      </Pressable>
    )}
  </View>
));
InputBar.displayName = 'InputBar';

// ─── Paylaşılan stiller ───────────────────────────────────────────────────────

export const S = StyleSheet.create({
  // Kök
  root:            { flex: 1, backgroundColor: C.bg },

  // Liste
  list:            { flex: 1 },
  listContent:     { padding: 12, gap: 8 },

  // Bubble
  bubble:          { maxWidth: '85%', borderRadius: 12,
                     paddingHorizontal: 12, paddingVertical: 8 },
  bubbleUser:      { alignSelf: 'flex-end', backgroundColor: C.user },
  bubbleAI:        { alignSelf: 'flex-start', backgroundColor: C.surface2,
                     borderWidth: 1, borderColor: C.border },
  bubbleTextUser:  { color: '#fff', fontSize: 13, lineHeight: 19 },
  bubbleTextAI:    { color: C.text, fontSize: 13, lineHeight: 19, fontFamily: MONO },

  // Bildirim şeritleri (chip / toast)
  chip:            { paddingHorizontal: 10, paddingVertical: 4,
                     backgroundColor: 'rgba(52,211,153,0.1)',
                     borderBottomWidth: 1, borderBottomColor: 'rgba(52,211,153,0.15)' },
  chipText:        { fontSize: 11, color: C.cloud, textAlign: 'center', fontWeight: '600' },
  toast:           { paddingHorizontal: 10, paddingVertical: 3,
                     backgroundColor: 'rgba(251,191,36,0.08)',
                     borderBottomWidth: 1, borderBottomColor: 'rgba(251,191,36,0.12)' },
  toastText:       { fontSize: 10, color: C.warn, textAlign: 'center' },

  // Durum satırı
  statusRow:       { flexDirection: 'row', alignItems: 'center', gap: 6,
                     paddingHorizontal: 12, paddingVertical: 6,
                     backgroundColor: C.surface,
                     borderTopWidth: 1, borderTopColor: C.border },
  statusText:      { fontSize: 11, color: C.accent, fontFamily: MONO },

  // Input satırı
  inputRow:        { flexDirection: 'row', alignItems: 'flex-end', gap: 8,
                     padding: 10, borderTopWidth: 1,
                     borderTopColor: C.border, backgroundColor: C.surface },
  input:           { flex: 1, minHeight: 40, maxHeight: 120,
                     backgroundColor: C.surface2, borderRadius: 10,
                     borderWidth: 1, borderColor: C.border,
                     paddingHorizontal: 12, paddingVertical: 8,
                     color: C.text, fontSize: 13, fontFamily: MONO },
  sendBtn:         { width: 36, height: 36, borderRadius: 18,
                     backgroundColor: C.accent,
                     alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: C.surface2,
                     borderWidth: 1, borderColor: C.border },
  sendBtnText:     { fontSize: 16, color: '#fff', fontWeight: '700' },
  cancelBtn:       { width: 36, height: 36, borderRadius: 18,
                     backgroundColor: C.error,
                     alignItems: 'center', justifyContent: 'center' },
  cancelBtnText:   { fontSize: 12, color: '#fff', fontWeight: '700' },
});
