/**
 * ui/chat/_shared.tsx
 *
 * Tema güncellemesi:
 *   • Hardcoded C paleti → useTheme().colors.chat üzerinden dinamik
 *   • Her bileşen useTheme() çağırır — memo hâlâ geçerli (colors referansı değişince re-render)
 *   • C export'u backward-compat için korunur (AIChatScreenV2 statik stillerinde kullanıyor)
 *     ama artık fallback dark değerleri taşır; gerçek renkler her bileşende useTheme()'den gelir.
 */

import React, { memo, useMemo } from 'react';
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
import { useTheme }         from '@/theme';
import type { ThemeColors } from '@/theme';

// ─── Backward-compat C export (AIChatScreenV2 statik stil referansları için) ─
// Bu değerler artık ekranda kullanılmıyor; makeSharedStyles(colors) gerçek değerleri verir.

export const C = {
  bg:      '#0a0e1a',
  surface: '#0d1117',
  surface2:'#111827',
  border:  'rgba(255,255,255,0.06)',
  accent:  '#7c6af7',
  user:    '#3b82f6',
  text:    '#e2e8f0',
  muted:   '#475569',
  error:   '#f87171',
  cloud:   '#34d399',
  warn:    '#fbbf24',
} as const;

export const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// ─── Dinamik stil fabrikası ───────────────────────────────────────────────────

export function makeSharedStyles(colors: ThemeColors) {
  const CH = colors.chat;
  return {
    root:            { flex: 1, backgroundColor: colors.bg },
    list:            { flex: 1 },
    listContent:     { padding: 12, gap: 8 },
    listEmpty:       { flexGrow: 1, justifyContent: 'center' as const },

    bubble:          { maxWidth: '85%' as any, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
    bubbleUser:      { alignSelf: 'flex-end' as const, backgroundColor: CH.userBubble },
    bubbleAI:        { alignSelf: 'flex-start' as const, backgroundColor: CH.aiBubble, borderWidth: 1, borderColor: colors.border },
    bubbleTextUser:  { color: CH.userText, fontSize: 13, lineHeight: 19 },
    bubbleTextAI:    { color: CH.aiText, fontSize: 13, lineHeight: 19, fontFamily: MONO },

    chip:            { paddingHorizontal: 10, paddingVertical: 4, backgroundColor: `${colors.success}18`, borderBottomWidth: 1, borderBottomColor: `${colors.success}25` },
    chipText:        { fontSize: 11, color: colors.success, textAlign: 'center' as const, fontWeight: '600' as const },
    toast:           { paddingHorizontal: 10, paddingVertical: 3, backgroundColor: `${colors.warning}14`, borderBottomWidth: 1, borderBottomColor: `${colors.warning}20` },
    toastText:       { fontSize: 10, color: colors.warning, textAlign: 'center' as const },

    statusRow:       { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border },
    statusText:      { fontSize: 11, color: colors.accent, fontFamily: MONO },

    inputRow:        { flexDirection: 'row' as const, alignItems: 'flex-end' as const, gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: CH.inputBg },
    input:           { flex: 1, minHeight: 40, maxHeight: 120, backgroundColor: colors.surface2, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 8, color: colors.text, fontSize: 13, fontFamily: MONO },
    sendBtn:         { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.accent, alignItems: 'center' as const, justifyContent: 'center' as const },
    sendBtnDisabled: { backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.border },
    sendBtnText:     { fontSize: 16, color: '#fff', fontWeight: '700' as const },
    cancelBtn:       { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.error, alignItems: 'center' as const, justifyContent: 'center' as const },
    cancelBtnText:   { fontSize: 12, color: '#fff', fontWeight: '700' as const },
  };
}

// ─── ChatBubble ───────────────────────────────────────────────────────────────

export const ChatBubble = memo(({ message }: { message: ChatMessage }) => {
  const { colors } = useTheme();
  const st = useMemo(() => makeSharedStyles(colors), [colors]);
  const isUser = message.role === 'user';
  return (
    <View style={[st.bubble, isUser ? st.bubbleUser : st.bubbleAI]}>
      <Text style={isUser ? st.bubbleTextUser : st.bubbleTextAI} selectable>
        {message.content}
      </Text>
    </View>
  );
});
ChatBubble.displayName = 'ChatBubble';

// ─── EscalationChip ──────────────────────────────────────────────────────────

export const EscalationChip = memo(() => {
  const { colors } = useTheme();
  const st = useMemo(() => makeSharedStyles(colors), [colors]);
  return (
    <View style={st.chip}>
      <Text style={st.chipText}>☁ Bulut modeli kullandı</Text>
    </View>
  );
});
EscalationChip.displayName = 'EscalationChip';

// ─── LowQualityToast ─────────────────────────────────────────────────────────

export const LowQualityToast = memo(({ score }: { score: number }) => {
  const { colors } = useTheme();
  const st = useMemo(() => makeSharedStyles(colors), [colors]);
  return (
    <View style={st.toast}>
      <Text style={st.toastText}>
        ⚠ Düşük kalite ({(score * 100).toFixed(0)}%)
      </Text>
    </View>
  );
});
LowQualityToast.displayName = 'LowQualityToast';

// ─── StatusRow ────────────────────────────────────────────────────────────────

export const StatusRow = memo(({ label }: { label: string }) => {
  const { colors } = useTheme();
  const st = useMemo(() => makeSharedStyles(colors), [colors]);
  return (
    <View style={st.statusRow}>
      <ActivityIndicator size="small" color={colors.accent} />
      <Text style={st.statusText}>{label}</Text>
    </View>
  );
});
StatusRow.displayName = 'StatusRow';

// ─── InputBar ─────────────────────────────────────────────────────────────────

export interface InputBarProps {
  value:    string;
  isBusy:   boolean;
  onChange: (text: string) => void;
  onSend:   () => void;
  onCancel: () => void;
}

export const InputBar = memo(({
  value, isBusy, onChange, onSend, onCancel,
}: InputBarProps) => {
  const { colors } = useTheme();
  const st = useMemo(() => makeSharedStyles(colors), [colors]);
  return (
    <View style={st.inputRow}>
      <TextInput
        style={st.input}
        value={value}
        onChangeText={onChange}
        placeholder="Mesaj…"
        placeholderTextColor={colors.muted}
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
          style={st.cancelBtn}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="İptal et"
          testID="cancel-button"
        >
          <Text style={st.cancelBtnText}>■</Text>
        </Pressable>
      ) : (
        <Pressable
          style={[st.sendBtn, !value.trim() && st.sendBtnDisabled]}
          onPress={onSend}
          disabled={!value.trim()}
          accessibilityRole="button"
          accessibilityLabel="Gönder"
          testID="send-button"
        >
          <Text style={st.sendBtnText}>↑</Text>
        </Pressable>
      )}
    </View>
  );
});
InputBar.displayName = 'InputBar';

// ─── Backward-compat static S export (AIChatScreenV2 hâlâ C.* ile static style kullanıyor)
// Sadece layout prop'ları güvenli — renkler dinamik bileşenlerden geliyor.

export const S = StyleSheet.create({
  root:            { flex: 1 },
  list:            { flex: 1 },
  listContent:     { padding: 12, gap: 8 },
  listEmpty:       { flexGrow: 1, justifyContent: 'center' },
  bubble:          { maxWidth: '85%', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleUser:      { alignSelf: 'flex-end' },
  bubbleAI:        { alignSelf: 'flex-start' },
  bubbleTextUser:  { fontSize: 13, lineHeight: 19 },
  bubbleTextAI:    { fontSize: 13, lineHeight: 19, fontFamily: MONO },
});
