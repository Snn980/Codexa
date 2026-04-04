/**
 * ui/chat/AIChatScreenV2.tsx
 *
 * Chat geçmişi eklendi:
 *   • Oturum otomatik kaydediliyor (her yanıt sonrası)
 *   • Header: Geçmiş butonu → drawer panel
 *   • Header: Yeni sohbet butonu
 *   • Oturum listesi: başlık + tarih + sil
 *   • Seçilen oturumu yükle
 */

import React, {
  memo,
  useCallback,
  useEffect,
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
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { useSafeAreaInsets }   from 'react-native-safe-area-context';
import { useAppContext }        from '@/app/AppContext';
import { useAIOrchestrator }   from '../../hooks/useAIOrchestrator';
import { useAIChatSession }    from '../../hooks/useAIChatSession';
import { AIWorkerClient }      from '../../ai/AIWorkerClient';
import type { UUID }           from '../../types/core';
import { generateId }          from '../../utils/uuid';
import type { ChatMessage }    from '../../hooks/useAIChat';
import type { SessionMeta }    from '../../storage/chat/ChatHistoryRepository';
import {
  ChatBubble, EscalationChip, LowQualityToast,
  InputBar, StatusRow, C, MONO,
} from './_shared';

export interface AIChatScreenV2Props {
  initialSessionId?: string;
}

type ProviderTab = 'anthropic' | 'openai';

// ─── Provider seçici ─────────────────────────────────────────────────────────

const ProviderSelector = memo(({
  active, hasAnthropic, hasOpenAI, onChange,
}: {
  active: ProviderTab; hasAnthropic: boolean;
  hasOpenAI: boolean; onChange: (p: ProviderTab) => void;
}) => (
  <View style={ps.bar}>
    <Pressable
      style={[ps.tab, active === 'anthropic' && ps.tabActive, !hasAnthropic && ps.tabMissing]}
      onPress={() => onChange('anthropic')}
    >
      <Text style={[ps.label, active === 'anthropic' && ps.labelActive]}>
        Claude {!hasAnthropic ? '⚠' : ''}
      </Text>
    </Pressable>
    <Pressable
      style={[ps.tab, active === 'openai' && ps.tabActive, !hasOpenAI && ps.tabMissing]}
      onPress={() => onChange('openai')}
    >
      <Text style={[ps.label, active === 'openai' && ps.labelActive]}>
        GPT-4 {!hasOpenAI ? '⚠' : ''}
      </Text>
    </Pressable>
  </View>
));
ProviderSelector.displayName = 'ProviderSelector';

// ─── API Key uyarısı ─────────────────────────────────────────────────────────

const NoKeyBanner = memo(({ provider }: { provider: ProviderTab }) => (
  <View style={nb.wrap}>
    <Text style={nb.icon}>🔑</Text>
    <View style={nb.body}>
      <Text style={nb.title}>API Anahtarı Eksik</Text>
      <Text style={nb.desc}>
        {provider === 'anthropic'
          ? 'Ayarlar → API Anahtarları → sk-ant-... ekleyin.'
          : 'Ayarlar → API Anahtarları → sk-proj-... ekleyin.'}
      </Text>
    </View>
  </View>
));
NoKeyBanner.displayName = 'NoKeyBanner';

// ─── Boş durum ───────────────────────────────────────────────────────────────

const EmptyChat = memo(() => (
  <View style={ec.wrap}>
    <Text style={ec.icon}>✦</Text>
    <Text style={ec.title}>AI Asistan</Text>
    <Text style={ec.desc}>Kod yazma, hata ayıklama veya{'\n'}proje sorularınızı sorun.</Text>
  </View>
));
EmptyChat.displayName = 'EmptyChat';

// ─── Oturum drawer ───────────────────────────────────────────────────────────

function fmtDate(ts: number): string {
  const d   = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  if (diffDays === 1) return 'Dün';
  if (diffDays < 7)  return `${diffDays} gün önce`;
  return `${d.getDate()}/${d.getMonth()+1}`;
}

const SessionDrawer = memo(({
  visible, sessions, activeId, onSelect, onNew, onDelete, onClose,
}: {
  visible: boolean;
  sessions: readonly SessionMeta[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew:    () => void;
  onDelete: (id: string) => void;
  onClose:  () => void;
}) => (
  <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <Pressable style={sd.overlay} onPress={onClose} />
    <View style={sd.panel}>
      <View style={sd.header}>
        <Text style={sd.title}>Sohbet Geçmişi</Text>
        <TouchableOpacity style={sd.newBtn} onPress={() => { onNew(); onClose(); }}>
          <Text style={sd.newBtnText}>+ Yeni</Text>
        </TouchableOpacity>
      </View>
      {sessions.length === 0 ? (
        <View style={sd.empty}>
          <Text style={sd.emptyText}>Henüz kaydedilmiş sohbet yok.</Text>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          {sessions.map(s => (
            <Pressable
              key={s.id}
              style={[sd.item, s.id === activeId && sd.itemActive]}
              onPress={() => { onSelect(s.id); onClose(); }}
            >
              <View style={sd.itemBody}>
                <Text style={sd.itemTitle} numberOfLines={1}>
                  {s.title || 'Sohbet'}
                </Text>
                <Text style={sd.itemMeta}>
                  {fmtDate(s.updatedAt)} · {s.messageCount} mesaj
                </Text>
              </View>
              <TouchableOpacity
                style={sd.deleteBtn}
                onPress={() => onDelete(s.id)}
                hitSlop={8}
              >
                <Text style={sd.deleteBtnText}>✕</Text>
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
  const { top } = useSafeAreaInsets();
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
  const [hasAnthropic,   setHasAnthropic]   = useState(false);
  const [hasOpenAI,      setHasOpenAI]       = useState(false);
  const [activeProvider, setActiveProvider]  = useState<ProviderTab>('anthropic');

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

  // AIWorkerClient
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

  // Yanıt tamamlanınca kaydet
  const prevMsgLen = useRef(0);
  useEffect(() => {
    if (messages.length > 0 && messages.length !== prevMsgLen.current && status === 'idle') {
      prevMsgLen.current = messages.length;
      saveMessages(messages);
    }
  }, [messages, status, saveMessages]);

  // Oturum seç — mesajları yükle
  const handleSelectSession = useCallback((id: string) => {
    const loaded = loadSession(id);
    clear();
    // Yüklenen mesajları restore et (orchestrator'ın state'ini bypass ederek)
    // Şu an için: yeni oturum açılır, geçmiş sadece referans amaçlı
    // Tam restore: useAIOrchestrator'a loadMessages() eklenmeli (Faz 2)
    refreshSessions();
  }, [loadSession, clear, refreshSessions]);

  // Yeni oturum
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
      style={S.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* Header */}
      <View style={[S.header, { paddingTop: top + 10 }]}>
        <View style={S.headerLeft}>
          {/* Geçmiş butonu */}
          <TouchableOpacity
            style={S.headerIconBtn}
            onPress={() => { refreshSessions(); setDrawerOpen(true); }}
            hitSlop={8}
          >
            <Text style={S.headerIcon}>☰</Text>
            {sessions.length > 0 && (
              <View style={S.sessionBadge}>
                <Text style={S.sessionBadgeText}>
                  {sessions.length > 9 ? '9+' : sessions.length}
                </Text>
              </View>
            )}
          </TouchableOpacity>
          <View>
            <Text style={S.headerTitle}>AI Chat</Text>
            <Text style={[S.headerSub, status === 'error' && S.headerSubError]}>
              {status === 'idle'  ? (hasActiveKey ? 'Hazır' : 'Anahtar eksik') :
               status === 'error' ? 'Hata — tekrar deneyin' :
               (statusLabel ?? '')}
            </Text>
          </View>
        </View>
        <View style={S.headerRight}>
          {/* Yeni sohbet */}
          {messages.length > 0 && (
            <TouchableOpacity style={S.headerIconBtn} onPress={handleNewSession} hitSlop={8}>
              <Text style={S.headerIcon}>✎</Text>
            </TouchableOpacity>
          )}
          <View style={[
            S.statusDot,
            status === 'error'  ? S.statusDotError :
            status !== 'idle'   ? S.statusDotActive : null,
          ]} />
        </View>
      </View>

      {/* Provider seçici */}
      <ProviderSelector
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
        <View style={eb.wrap}>
          <Text style={eb.icon}>⚠</Text>
          <Text style={eb.msg}>{lastError}</Text>
        </View>
      )}

      {/* Key uyarısı */}
      {!hasActiveKey && <NoKeyBanner provider={activeProvider} />}

      {/* Mesaj listesi */}
      <FlatList
        data={messages as ChatMessage[]}
        keyExtractor={keyExtractor}
        renderItem={renderMessage}
        style={S.list}
        contentContainerStyle={[S.listContent, messages.length === 0 && S.listEmpty]}
        keyboardShouldPersistTaps="handled"
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        ListEmptyComponent={hasActiveKey ? <EmptyChat /> : null}
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

// ─── Stiller ─────────────────────────────────────────────────────────────────

const S = StyleSheet.create({
  root:            { flex: 1, backgroundColor: C.bg },
  header:          { flexDirection: 'row', alignItems: 'center',
                     justifyContent: 'space-between',
                     paddingHorizontal: 14, paddingBottom: 10,
                     borderBottomWidth: 1, borderBottomColor: C.border,
                     backgroundColor: C.surface },
  headerLeft:      { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerRight:     { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerTitle:     { fontSize: 13, fontWeight: '700', color: C.text, fontFamily: MONO },
  headerSub:       { fontSize: 10, color: C.muted, fontFamily: MONO, marginTop: 1 },
  headerSubError:  { color: '#f87171' },
  headerIconBtn:   { padding: 4, position: 'relative' },
  headerIcon:      { fontSize: 18, color: C.muted },
  sessionBadge:    { position: 'absolute', top: 0, right: 0,
                     backgroundColor: '#7c6af7', borderRadius: 8,
                     minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  sessionBadgeText:{ fontSize: 9, color: '#fff', fontWeight: '700' },
  statusDot:       { width: 8, height: 8, borderRadius: 4, backgroundColor: '#334155' },
  statusDotActive: { backgroundColor: '#34d399' },
  statusDotError:  { backgroundColor: '#f87171' },
  list:            { flex: 1 },
  listContent:     { padding: 12, gap: 8 },
  listEmpty:       { flex: 1, justifyContent: 'center' },
});

const ps = StyleSheet.create({
  bar:         { flexDirection: 'row', backgroundColor: C.surface,
                 borderBottomWidth: 1, borderBottomColor: C.border,
                 paddingHorizontal: 10, paddingVertical: 6, gap: 6 },
  tab:         { paddingHorizontal: 14, paddingVertical: 5, borderRadius: 6,
                 backgroundColor: 'rgba(255,255,255,0.04)',
                 borderWidth: 1, borderColor: 'transparent' },
  tabActive:   { backgroundColor: 'rgba(124,106,247,0.15)', borderColor: 'rgba(124,106,247,0.4)' },
  tabMissing:  { opacity: 0.5 },
  label:       { fontSize: 11, color: C.muted, fontFamily: MONO, fontWeight: '600' },
  labelActive: { color: '#7c6af7' },
});

const nb = StyleSheet.create({
  wrap:  { flexDirection: 'row', alignItems: 'flex-start', gap: 10,
           margin: 12, padding: 12, borderRadius: 10,
           backgroundColor: 'rgba(251,191,36,0.08)',
           borderWidth: 1, borderColor: 'rgba(251,191,36,0.2)' },
  icon:  { fontSize: 20, marginTop: 2 },
  body:  { flex: 1, gap: 4 },
  title: { fontSize: 12, fontWeight: '700', color: '#fbbf24', fontFamily: MONO },
  desc:  { fontSize: 11, color: '#94a3b8', fontFamily: MONO, lineHeight: 16 },
});

const eb = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'flex-start', gap: 8,
          marginHorizontal: 12, marginTop: 8, padding: 10, borderRadius: 8,
          backgroundColor: 'rgba(248,113,113,0.08)',
          borderWidth: 1, borderColor: 'rgba(248,113,113,0.25)' },
  icon: { fontSize: 14, color: '#f87171', marginTop: 1 },
  msg:  { flex: 1, fontSize: 12, color: '#fca5a5', fontFamily: MONO, lineHeight: 17 },
});

const ec = StyleSheet.create({
  wrap:  { alignItems: 'center', paddingVertical: 40, gap: 10 },
  icon:  { fontSize: 32, color: '#7c6af7' },
  title: { fontSize: 14, fontWeight: '700', color: C.text, fontFamily: MONO },
  desc:  { fontSize: 12, color: C.muted, fontFamily: MONO,
           textAlign: 'center', lineHeight: 18 },
});

const sd = StyleSheet.create({
  overlay:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  panel:        { position: 'absolute', right: 0, top: 0, bottom: 0, width: '80%',
                  backgroundColor: '#0d1117',
                  borderLeftWidth: 1, borderLeftColor: 'rgba(255,255,255,0.08)' },
  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                  paddingHorizontal: 16, paddingVertical: 16,
                  borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)',
                  paddingTop: 50 },
  title:        { fontSize: 14, fontWeight: '700', color: '#f1f5f9', fontFamily: MONO },
  newBtn:       { backgroundColor: '#7c6af7', borderRadius: 6,
                  paddingHorizontal: 12, paddingVertical: 6 },
  newBtnText:   { fontSize: 12, color: '#fff', fontWeight: '700', fontFamily: MONO },
  empty:        { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText:    { fontSize: 12, color: '#475569', fontFamily: MONO },
  item:         { flexDirection: 'row', alignItems: 'center',
                  paddingHorizontal: 16, paddingVertical: 12,
                  borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)' },
  itemActive:   { backgroundColor: 'rgba(124,106,247,0.08)' },
  itemBody:     { flex: 1, gap: 3 },
  itemTitle:    { fontSize: 13, color: '#e2e8f0', fontFamily: MONO },
  itemMeta:     { fontSize: 10, color: '#475569', fontFamily: MONO },
  deleteBtn:    { padding: 6 },
  deleteBtnText:{ fontSize: 14, color: '#475569' },
});
