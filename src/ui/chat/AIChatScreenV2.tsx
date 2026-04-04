/**
 * ui/chat/AIChatScreenV2.tsx
 *
 * Tema güncellemesi:
 *   • 6 statik StyleSheet.create (S, ps, nb, eb, ec, sd) → makeStyles(colors)
 *   • useTheme() ana bileşende çağrılır, useMemo ile stiller hesaplanır
 *   • Alt bileşenler (ProviderSelector, NoKeyBanner vb.) colors prop alır
 *   • _shared bileşenleri (ChatBubble, InputBar vb.) zaten useTheme kullanıyor
 */

import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { useSafeAreaInsets }   from 'react-native-safe-area-context';
import { useAppContext }        from '@/app/AppContext';
import { useTheme }             from '@/theme';
import type { ThemeColors }     from '@/theme';
import { useAIOrchestrator }   from '../../hooks/useAIOrchestrator';
import { useAIChatSession }    from '../../hooks/useAIChatSession';
import { AIWorkerClient }      from '../../ai/AIWorkerClient';
import type { UUID }           from '../../types/core';
import { generateId }          from '../../utils/uuid';
import type { ChatMessage }    from '../../hooks/useAIChat';
import type { SessionMeta }    from '../../storage/chat/ChatHistoryRepository';
import {
  ChatBubble, EscalationChip, LowQualityToast,
  InputBar, StatusRow, MONO,
} from './_shared';

export interface AIChatScreenV2Props {
  initialSessionId?: string;
}

type ProviderTab = 'anthropic' | 'openai';

// ─── Stil fabrikası ───────────────────────────────────────────────────────────

function makeStyles(C: ThemeColors) {
  // Chat için özel aksan — marka rengini koruyalım
  const ACCENT_CHAT = '#7c6af7';

  return {
    // Kök
    root:             { flex: 1, backgroundColor: C.bg },

    // Header
    header:           { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, paddingHorizontal: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.toolbar },
    headerLeft:       { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10 },
    headerRight:      { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10 },
    headerTitle:      { fontSize: 13, fontWeight: '700' as const, color: C.text, fontFamily: MONO },
    headerSub:        { fontSize: 10, color: C.muted, fontFamily: MONO, marginTop: 1 },
    headerSubError:   { color: C.error },
    headerIconBtn:    { padding: 4, position: 'relative' as const },
    headerIcon:       { fontSize: 18, color: C.muted },
    sessionBadge:     { position: 'absolute' as const, top: 0, right: 0, backgroundColor: ACCENT_CHAT, borderRadius: 8, minWidth: 16, height: 16, alignItems: 'center' as const, justifyContent: 'center' as const },
    sessionBadgeText: { fontSize: 9, color: '#fff', fontWeight: '700' as const },
    statusDot:        { width: 8, height: 8, borderRadius: 4, backgroundColor: C.surface2 },
    statusDotActive:  { backgroundColor: C.success },
    statusDotError:   { backgroundColor: C.error },

    // Liste
    list:             { flex: 1 },
    listContent:      { padding: 12, gap: 8 },
    listEmpty:        { flex: 1, justifyContent: 'center' as const },

    // Provider seçici
    psBar:            { flexDirection: 'row' as const, backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.border, paddingHorizontal: 10, paddingVertical: 6, gap: 6 },
    psTab:            { paddingHorizontal: 14, paddingVertical: 5, borderRadius: 6, backgroundColor: C.surface2, borderWidth: 1, borderColor: 'transparent' },
    psTabActive:      { backgroundColor: `${ACCENT_CHAT}25`, borderColor: `${ACCENT_CHAT}60` },
    psTabMissing:     { opacity: 0.5 },
    psLabel:          { fontSize: 11, color: C.muted, fontFamily: MONO, fontWeight: '600' as const },
    psLabelActive:    { color: ACCENT_CHAT },

    // API key uyarı banner
    nbWrap:           { flexDirection: 'row' as const, alignItems: 'flex-start' as const, gap: 10, margin: 12, padding: 12, borderRadius: 10, backgroundColor: `${C.warning}12`, borderWidth: 1, borderColor: `${C.warning}30` },
    nbIcon:           { fontSize: 20, marginTop: 2 },
    nbBody:           { flex: 1, gap: 4 },
    nbTitle:          { fontSize: 12, fontWeight: '700' as const, color: C.warning, fontFamily: MONO },
    nbDesc:           { fontSize: 11, color: C.textSecondary, fontFamily: MONO, lineHeight: 16 },

    // Hata banner
    ebWrap:           { flexDirection: 'row' as const, alignItems: 'flex-start' as const, gap: 8, marginHorizontal: 12, marginTop: 8, padding: 10, borderRadius: 8, backgroundColor: `${C.error}12`, borderWidth: 1, borderColor: `${C.error}35` },
    ebIcon:           { fontSize: 14, color: C.error, marginTop: 1 },
    ebMsg:            { flex: 1, fontSize: 12, color: C.error, fontFamily: MONO, lineHeight: 17 },

    // Boş durum
    ecWrap:           { alignItems: 'center' as const, paddingVertical: 40, gap: 10 },
    ecIcon:           { fontSize: 32, color: ACCENT_CHAT },
    ecTitle:          { fontSize: 14, fontWeight: '700' as const, color: C.text, fontFamily: MONO },
    ecDesc:           { fontSize: 12, color: C.muted, fontFamily: MONO, textAlign: 'center' as const, lineHeight: 18 },

    // Session drawer
    sdOverlay:        { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
    sdPanel:          { position: 'absolute' as const, right: 0, top: 0, bottom: 0, width: '80%' as any, backgroundColor: C.surface, borderLeftWidth: 1, borderLeftColor: C.border },
    sdHeader:         { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, paddingHorizontal: 16, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: C.border, paddingTop: 50 },
    sdTitle:          { fontSize: 14, fontWeight: '700' as const, color: C.text, fontFamily: MONO },
    sdNewBtn:         { backgroundColor: ACCENT_CHAT, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 6 },
    sdNewBtnText:     { fontSize: 12, color: '#fff', fontWeight: '700' as const, fontFamily: MONO },
    sdEmpty:          { flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const },
    sdEmptyText:      { fontSize: 12, color: C.muted, fontFamily: MONO },
    sdItem:           { flexDirection: 'row' as const, alignItems: 'center' as const, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.separator },
    sdItemActive:     { backgroundColor: `${ACCENT_CHAT}12` },
    sdItemBody:       { flex: 1, gap: 3 },
    sdItemTitle:      { fontSize: 13, color: C.text, fontFamily: MONO },
    sdItemMeta:       { fontSize: 10, color: C.muted, fontFamily: MONO },
    sdDeleteBtn:      { padding: 6 },
    sdDeleteBtnText:  { fontSize: 14, color: C.muted },
  };
}

// ─── Yardımcı ─────────────────────────────────────────────────────────────────

function fmtDate(ts: number): string {
  const d   = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  if (diffDays === 1) return 'Dün';
  if (diffDays < 7)  return `${diffDays} gün önce`;
  return `${d.getDate()}/${d.getMonth()+1}`;
}

// ─── Alt bileşenler (colors prop alır → tema değişince parent re-render eder) ─

type Styles = ReturnType<typeof makeStyles>;

const ProviderSelector = memo(({
  active, hasAnthropic, hasOpenAI, onChange, st,
}: {
  active: ProviderTab; hasAnthropic: boolean;
  hasOpenAI: boolean; onChange: (p: ProviderTab) => void;
  st: Styles;
}) => (
  <View style={st.psBar}>
    <Pressable
      style={[st.psTab, active === 'anthropic' && st.psTabActive, !hasAnthropic && st.psTabMissing]}
      onPress={() => onChange('anthropic')}
    >
      <Text style={[st.psLabel, active === 'anthropic' && st.psLabelActive]}>
        Claude {!hasAnthropic ? '⚠' : ''}
      </Text>
    </Pressable>
    <Pressable
      style={[st.psTab, active === 'openai' && st.psTabActive, !hasOpenAI && st.psTabMissing]}
      onPress={() => onChange('openai')}
    >
      <Text style={[st.psLabel, active === 'openai' && st.psLabelActive]}>
        GPT-4 {!hasOpenAI ? '⚠' : ''}
      </Text>
    </Pressable>
  </View>
));
ProviderSelector.displayName = 'ProviderSelector';

const NoKeyBanner = memo(({ provider, st }: { provider: ProviderTab; st: Styles }) => (
  <View style={st.nbWrap}>
    <Text style={st.nbIcon}>🔑</Text>
    <View style={st.nbBody}>
      <Text style={st.nbTitle}>API Anahtarı Eksik</Text>
      <Text style={st.nbDesc}>
        {provider === 'anthropic'
          ? 'Ayarlar → API Anahtarları → sk-ant-... ekleyin.'
          : 'Ayarlar → API Anahtarları → sk-proj-... ekleyin.'}
      </Text>
    </View>
  </View>
));
NoKeyBanner.displayName = 'NoKeyBanner';

const EmptyChat = memo(({ st }: { st: Styles }) => (
  <View style={st.ecWrap}>
    <Text style={st.ecIcon}>✦</Text>
    <Text style={st.ecTitle}>AI Asistan</Text>
    <Text style={st.ecDesc}>{'Kod yazma, hata ayıklama veya\nproje sorularınızı sorun.'}</Text>
  </View>
));
EmptyChat.displayName = 'EmptyChat';

const SessionDrawer = memo(({
  visible, sessions, activeId, onSelect, onNew, onDelete, onClose, st,
}: {
  visible: boolean;
  sessions: readonly SessionMeta[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew:    () => void;
  onDelete: (id: string) => void;
  onClose:  () => void;
  st: Styles;
}) => (
  <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <Pressable style={st.sdOverlay} onPress={onClose} />
    <View style={st.sdPanel}>
      <View style={st.sdHeader}>
        <Text style={st.sdTitle}>Sohbet Geçmişi</Text>
        <TouchableOpacity style={st.sdNewBtn} onPress={() => { onNew(); onClose(); }}>
          <Text style={st.sdNewBtnText}>+ Yeni</Text>
        </TouchableOpacity>
      </View>
      {sessions.length === 0 ? (
        <View style={st.sdEmpty}>
          <Text style={st.sdEmptyText}>Henüz kaydedilmiş sohbet yok.</Text>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          {sessions.map(s => (
            <Pressable
              key={s.id}
              style={[st.sdItem, s.id === activeId && st.sdItemActive]}
              onPress={() => { onSelect(s.id); onClose(); }}
            >
              <View style={st.sdItemBody}>
                <Text style={st.sdItemTitle} numberOfLines={1}>
                  {s.title || 'Sohbet'}
                </Text>
                <Text style={st.sdItemMeta}>
                  {fmtDate(s.updatedAt)} · {s.messageCount} mesaj
                </Text>
              </View>
              <TouchableOpacity style={st.sdDeleteBtn} onPress={() => onDelete(s.id)} hitSlop={8}>
                <Text style={st.sdDeleteBtnText}>✕</Text>
              </TouchableOpacity>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  </Modal>
));
SessionDrawer.displayName = 'SessionDrawer';

// ─── AIChatScreenV2 ───────────────────────────────────────────────────────────

export const AIChatScreenV2 = memo(({}: AIChatScreenV2Props): React.ReactElement => {
  const { top }        = useSafeAreaInsets();
  const { colors }     = useTheme();
  const st             = useMemo(() => makeStyles(colors), [colors]);

  const { services }   = useAppContext();
  const bridge         = services.bridge;
  const permissionGate = services.permissionGate;
  const sentryService  = services.sentryService;
  const keyStore       = services.keyStore;

  // Session yönetimi
  const {
    sessionId, sessions,
    loadSession, saveMessages,
    newSession, deleteSession, refreshSessions,
  } = useAIChatSession();

  const [drawerOpen, setDrawerOpen] = useState(false);

  // Provider key durumu
  const [hasAnthropic,   setHasAnthropic]  = useState(false);
  const [hasOpenAI,      setHasOpenAI]     = useState(false);
  const [activeProvider, setActiveProvider] = useState<ProviderTab>('anthropic');

  useEffect(() => {
    void (async () => {
      const ak = await keyStore.getKey('anthropic');
      const ok = await keyStore.getKey('openai');
      setHasAnthropic(!!ak);
      setHasOpenAI(!!ok);
      if (!ak && ok) setActiveProvider('openai');
    })();
  }, [keyStore]);

  const hasActiveKey = activeProvider === 'anthropic' ? hasAnthropic : hasOpenAI;

  const workerClientRef = useRef<AIWorkerClient | null>(null);
  if (!workerClientRef.current) {
    workerClientRef.current = new AIWorkerClient(bridge, generateId as () => UUID);
  }

  const permission = permissionGate.getStatus();

  const {
    messages, status, lastResult, lastError,
    isBusy, send, cancel, clear,
  } = useAIOrchestrator({
    orchestrator: services.orchestrator,
    permission,
    onEvent: (event, detail) => {
      sentryService.captureAIEvent(event, (detail as Record<string, unknown>) ?? {});
    },
  });

  const prevMsgLen = useRef(0);
  useEffect(() => {
    if (messages.length > 0 && messages.length !== prevMsgLen.current && status === 'idle') {
      prevMsgLen.current = messages.length;
      saveMessages(messages);
    }
  }, [messages, status, saveMessages]);

  const handleSelectSession = useCallback((id: string) => {
    loadSession(id);
    clear();
    refreshSessions();
  }, [loadSession, clear, refreshSessions]);

  const handleNewSession = useCallback(() => {
    newSession();
    clear();
  }, [newSession, clear]);

  const [inputText, setInputText] = useState('');

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || isBusy || !hasActiveKey) return;
    setInputText('');
    void send(text, activeProvider);
  }, [inputText, isBusy, send, hasActiveKey, activeProvider]);

  const keyExtractor  = useCallback((item: ChatMessage) => item.id, []);
  const renderMessage = useCallback(
    ({ item }: { item: ChatMessage }) => <ChatBubble message={item} />,
    [],
  );

  const statusLabel =
    status === 'analyzing' ? 'Analiz ediliyor…' :
    status === 'streaming' ? 'Yanıt üretiliyor…' :
    status === 'error'     ? 'Hata oluştu' : null;

  return (
    <KeyboardAvoidingView
      style={st.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* Header */}
      <View style={[st.header, { paddingTop: top + 10 }]}>
        <View style={st.headerLeft}>
          <TouchableOpacity
            style={st.headerIconBtn}
            onPress={() => { refreshSessions(); setDrawerOpen(true); }}
            hitSlop={8}
          >
            <Text style={st.headerIcon}>☰</Text>
            {sessions.length > 0 && (
              <View style={st.sessionBadge}>
                <Text style={st.sessionBadgeText}>
                  {sessions.length > 9 ? '9+' : sessions.length}
                </Text>
              </View>
            )}
          </TouchableOpacity>
          <View>
            <Text style={st.headerTitle}>AI Chat</Text>
            <Text style={[st.headerSub, status === 'error' && st.headerSubError]}>
              {status === 'idle'  ? (hasActiveKey ? 'Hazır' : 'Anahtar eksik') :
               status === 'error' ? 'Hata — tekrar deneyin' :
               (statusLabel ?? '')}
            </Text>
          </View>
        </View>
        <View style={st.headerRight}>
          {messages.length > 0 && (
            <TouchableOpacity style={st.headerIconBtn} onPress={handleNewSession} hitSlop={8}>
              <Text style={st.headerIcon}>✎</Text>
            </TouchableOpacity>
          )}
          <View style={[
            st.statusDot,
            status === 'error' ? st.statusDotError :
            status !== 'idle'  ? st.statusDotActive : null,
          ]} />
        </View>
      </View>

      {/* Provider seçici */}
      <ProviderSelector
        st={st}
        active={activeProvider}
        hasAnthropic={hasAnthropic}
        hasOpenAI={hasOpenAI}
        onChange={setActiveProvider}
      />

      {/* Bildirimler */}
      {lastResult?.escalated && <EscalationChip />}
      {lastResult !== null && lastResult.qualityScore < 0.7 && (
        <LowQualityToast score={lastResult.qualityScore} />
      )}

      {/* Hata banner */}
      {status === 'error' && lastError && (
        <View style={st.ebWrap}>
          <Text style={st.ebIcon}>⚠</Text>
          <Text style={st.ebMsg}>{lastError}</Text>
        </View>
      )}

      {/* Key uyarısı */}
      {!hasActiveKey && <NoKeyBanner st={st} provider={activeProvider} />}

      {/* Mesaj listesi */}
      <FlatList
        data={messages as ChatMessage[]}
        keyExtractor={keyExtractor}
        renderItem={renderMessage}
        style={st.list}
        contentContainerStyle={[st.listContent, messages.length === 0 && st.listEmpty]}
        keyboardShouldPersistTaps="handled"
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        ListEmptyComponent={hasActiveKey ? <EmptyChat st={st} /> : null}
        testID="chat-message-list"
      />

      {statusLabel && <StatusRow label={statusLabel} />}

      <InputBar
        value={inputText}
        isBusy={isBusy}
        onChange={setInputText}
        onSend={handleSend}
        onCancel={cancel}
      />

      {/* Oturum drawer */}
      <SessionDrawer
        st={st}
        visible={drawerOpen}
        sessions={sessions}
        activeId={sessionId}
        onSelect={handleSelectSession}
        onNew={handleNewSession}
        onDelete={deleteSession}
        onClose={() => setDrawerOpen(false)}
      />
    </KeyboardAvoidingView>
  );
});
AIChatScreenV2.displayName = 'AIChatScreenV2';
