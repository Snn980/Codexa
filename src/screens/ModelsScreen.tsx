/**
 * src/screens/ModelsScreen.tsx
 *
 * § 61 — Model listesi, indirme ve OTA güncelleme ekranı (tam implementasyon).
 *        Phase 15 placeholder kaldırıldı.
 *
 * Bileşen ağacı:
 *   ModelsScreen
 *     ├── OTAUpdateBanner
 *     ├── OfflineModelList → ModelCard × n
 *     └── CloudModelList  → ModelCard (permission rozeti)
 *
 * § 3  : EventBus unsub cleanup
 * § 4  : AppContainer DI (downloadManager, permissionGate, eventBus)
 * § 8  : React.memo + useRef + mountedRef
 * § 23 : FlatList keyExtractor → item.id
 * § 26 : AI_MODELS listesi
 * § 36 : Background model indirme
 *
 * API düzeltmeleri (bugfix):
 *   container.downloadManager  → AppContainer.downloadManager getter (§ 63)
 *   permissionGate.getStatus() → AIPermissionStatus (§ FIX-3)
 *   downloadManager.startDownload / cancelDownload (gerçek metod adları)
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
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AppContainer }         from '../app/AppContainer';
import { AI_MODELS, AIModelVariant } from '../ai/AIModels';
import type { AIModel, AIModelId }   from '../ai/AIModels';
import type { DownloadState }        from '../download/ModelDownloadManager';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface ModelsScreenProps {
  container: AppContainer;
}

// ─── useModelsScreen ──────────────────────────────────────────────────────────

interface ModelsScreenState {
  states:      Record<AIModelId, DownloadState>;
  updateCount: number;
}

function useModelsScreen(container: AppContainer) {
  // § FIX-5: downloadManager (alias getter) + § FIX-3: getStatus()
  const downloadManager = container.downloadManager;
  const permissionGate  = container.permissionGate;
  const eventBus        = container.eventBus;
  const permission      = permissionGate.getStatus();
  const mountedRef      = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Başlangıç state'i
  const initialStates = useMemo<Record<AIModelId, DownloadState>>(() => {
    const result = {} as Record<AIModelId, DownloadState>;
    for (const m of AI_MODELS) {
      result[m.id] = downloadManager.getState(m.id);
    }
    return result;
  }, [downloadManager]);

  const [screenState, setScreenState] = useState<ModelsScreenState>({
    states:      initialStates,
    updateCount: 0,
  });

  // ─── EventBus dinleyicileri ─────────────────────────────────────────────────

  useEffect(() => {
    const patch = (modelId: AIModelId) => {
      if (!mountedRef.current) return;
      setScreenState(prev => ({
        ...prev,
        states: {
          ...prev.states,
          [modelId]: downloadManager.getState(modelId),
        },
      }));
    };

    const patchAndUpdateCount = (modelId: AIModelId) => {
      if (!mountedRef.current) return;
      setScreenState(prev => ({
        states: {
          ...prev.states,
          [modelId]: downloadManager.getState(modelId),
        },
        updateCount: prev.updateCount > 0 ? prev.updateCount - 1 : 0,
      }));
    };

    const u1 = eventBus.on(
      'model:download:progress',
      ({ modelId }) => patch(modelId),
    );
    const u2 = eventBus.on(
      'model:download:complete',
      ({ modelId }) => patchAndUpdateCount(modelId),
    );
    const u3 = eventBus.on(
      'model:download:error',
      ({ modelId }) => patch(modelId),
    );
    const u4 = eventBus.on(
      'model:download:cancel',
      ({ modelId }) => patch(modelId),
    );

    return () => { u1(); u2(); u3(); u4(); };
  }, [eventBus, downloadManager]);

  // ─── Aksiyonlar ─────────────────────────────────────────────────────────────

  // § FIX: gerçek metod adları — startDownload / cancelDownload
  const startDownload = useCallback((modelId: AIModelId) => {
    downloadManager.startDownload(modelId).catch(() => {/* hata EventBus'ta */});
  }, [downloadManager]);

  const cancelDownload = useCallback((modelId: AIModelId) => {
    downloadManager.cancelDownload(modelId);
  }, [downloadManager]);

  return {
    states:       screenState.states,
    updateCount:  screenState.updateCount,
    permission,
    startDownload,
    cancelDownload,
  };
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
  success:   '#34d399',
  warn:      '#fbbf24',
  error:     '#f87171',
  cloud:     '#60a5fa',
} as const;

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// ─── ProgressBar ──────────────────────────────────────────────────────────────

const ProgressBar = memo(({ percent }: { percent: number }) => (
  <View style={styles.progressTrack}>
    <View style={[styles.progressFill, { width: `${Math.min(percent, 100)}%` as `${number}%` }]} />
  </View>
));
ProgressBar.displayName = 'ProgressBar';

// ─── ModelCard ────────────────────────────────────────────────────────────────

interface ModelCardProps {
  model:         AIModel;
  state:         DownloadState;
  onStart:       (id: AIModelId) => void;
  onCancel:      (id: AIModelId) => void;
  isCloud:       boolean;
}

const ModelCard = memo(({
  model, state, onStart, onCancel, isCloud,
}: ModelCardProps) => {
  const isDownloading = state.status === 'downloading' || state.status === 'checking';
  const isVerifying   = state.status === 'verifying';
  const isComplete    = state.status === 'complete';
  const isError       = state.status === 'error';
  const isBusy        = isDownloading || isVerifying;

  const sizeMB = model.sizeGB ? Math.round(model.sizeGB * 1024) : null;

  return (
    <View style={styles.card}>
      {/* Başlık satırı */}
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardName}>{model.name}</Text>
          {isCloud && (
            <View style={styles.cloudBadge}>
              <Text style={styles.cloudBadgeText}>☁ Bulut</Text>
            </View>
          )}
          {isComplete && (
            <View style={styles.completeBadge}>
              <Text style={styles.completeBadgeText}>✓ Hazır</Text>
            </View>
          )}
        </View>
        {sizeMB && (
          <Text style={styles.cardSize}>{sizeMB >= 1024
            ? `${(sizeMB / 1024).toFixed(1)} GB`
            : `${sizeMB} MB`}
          </Text>
        )}
      </View>

      {/* Model meta */}
      <Text style={styles.cardMeta} numberOfLines={1}>
        {model.contextWindow ? `${(model.contextWindow / 1000).toFixed(0)}K ctx` : ''}
        {model.contextWindow && model.quantization ? '  ·  ' : ''}
        {model.quantization ?? ''}
      </Text>

      {/* Progress */}
      {isBusy && (
        <View style={styles.progressRow}>
          <ProgressBar percent={state.percent} />
          <Text style={styles.progressText}>
            {isVerifying
              ? 'Doğrulanıyor…'
              : `${state.receivedMB.toFixed(0)} / ${state.totalMB.toFixed(0)} MB`}
          </Text>
        </View>
      )}

      {/* Hata mesajı */}
      {isError && (
        <Text style={styles.errorText} numberOfLines={2}>
          ⚠ {state.errorMessage ?? 'İndirme başarısız'}
        </Text>
      )}

      {/* Aksiyon butonu */}
      {!isCloud && (
        <View style={styles.cardActions}>
          {isBusy ? (
            <Pressable
              style={styles.cancelBtn}
              onPress={() => onCancel(model.id)}
              accessibilityRole="button"
              accessibilityLabel="İndirmeyi iptal et"
            >
              <ActivityIndicator size="small" color={C.accent} style={{ marginRight: 6 }} />
              <Text style={styles.cancelBtnText}>İptal</Text>
            </Pressable>
          ) : !isComplete ? (
            <Pressable
              style={styles.downloadBtn}
              onPress={() => onStart(model.id)}
              accessibilityRole="button"
              accessibilityLabel={`${model.name} indir`}
            >
              <Text style={styles.downloadBtnText}>↓ İndir</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
});
ModelCard.displayName = 'ModelCard';

// ─── OTAUpdateBanner ──────────────────────────────────────────────────────────

const OTAUpdateBanner = memo(({ count }: { count: number }) => {
  if (count === 0) return null;
  return (
    <View style={styles.otaBanner}>
      <Text style={styles.otaBannerText}>
        🔄 {count} model güncellemesi mevcut
      </Text>
    </View>
  );
});
OTAUpdateBanner.displayName = 'OTAUpdateBanner';

// ─── ModelsScreen ─────────────────────────────────────────────────────────────

export function ModelsScreen({ container }: ModelsScreenProps): React.ReactElement {
  const insets = useSafeAreaInsets();
  const {
    states,
    updateCount,
    permission,
    startDownload,
    cancelDownload,
  } = useModelsScreen(container);

  // Offline modeller
  const offlineModels = useMemo(
    () => AI_MODELS.filter(m => m.variant === AIModelVariant.OFFLINE),
    [],
  );

  // Cloud modeller — sadece CLOUD_ENABLED izni varsa göster
  const cloudModels = useMemo(
    () => permission === 'CLOUD_ENABLED'
      ? AI_MODELS.filter(m => m.variant === AIModelVariant.CLOUD)
      : [],
    [permission],
  );

  // § 23 — keyExtractor
  const keyExtractor = useCallback((item: AIModel) => item.id, []);

  const renderOffline = useCallback(
    ({ item }: { item: AIModel }) => (
      <ModelCard
        model={item}
        state={states[item.id] ?? { modelId: item.id, status: 'idle', receivedMB: 0, totalMB: 0, percent: 0 }}
        onStart={startDownload}
        onCancel={cancelDownload}
        isCloud={false}
      />
    ),
    [states, startDownload, cancelDownload],
  );

  const renderCloud = useCallback(
    ({ item }: { item: AIModel }) => (
      <ModelCard
        model={item}
        state={states[item.id] ?? { modelId: item.id, status: 'idle', receivedMB: 0, totalMB: 0, percent: 0 }}
        onStart={startDownload}
        onCancel={cancelDownload}
        isCloud
      />
    ),
    [states, startDownload, cancelDownload],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* OTA güncelleme banner */}
      <OTAUpdateBanner count={updateCount} />

      {/* Başlık */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Modeller</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Offline modeller */}
        <Text style={styles.sectionTitle}>Cihaz Modelleri</Text>
        <Text style={styles.sectionSub}>İndirilmiş modeller offline çalışır, API anahtarı gerekmez.</Text>

        <FlatList
          data={offlineModels}
          keyExtractor={keyExtractor}
          renderItem={renderOffline}
          scrollEnabled={false}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />

        {/* Cloud modeller */}
        {cloudModels.length > 0 && (
          <>
            <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Bulut Modelleri</Text>
            <Text style={styles.sectionSub}>API anahtarı ile çalışır, internete bağlantı gerektirir.</Text>
            <FlatList
              data={cloudModels}
              keyExtractor={keyExtractor}
              renderItem={renderCloud}
              scrollEnabled={false}
              ItemSeparatorComponent={() => <View style={styles.separator} />}
            />
          </>
        )}

        {permission === 'LOCAL_ONLY' && (
          <View style={styles.cloudDisabledNote}>
            <Text style={styles.cloudDisabledText}>
              🔒 Gizlilik modu aktif — bulut modelleri devre dışı
            </Text>
          </View>
        )}

        <View style={{ height: insets.bottom + 16 }} />
      </ScrollView>
    </View>
  );
}

// ─── Stiller ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:           { flex: 1, backgroundColor: C.bg },
  header:         { paddingHorizontal: 16, paddingVertical: 12,
                    borderBottomWidth: 1, borderBottomColor: C.border,
                    backgroundColor: C.surface },
  headerTitle:    { fontSize: 16, fontWeight: '700', color: C.accent, fontFamily: MONO },
  scroll:         { flex: 1 },
  scrollContent:  { paddingHorizontal: 12, paddingTop: 16 },

  otaBanner:      { backgroundColor: 'rgba(251,191,36,0.12)', paddingHorizontal: 16,
                    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  otaBannerText:  { fontSize: 12, color: C.warn, fontWeight: '600', fontFamily: MONO },

  sectionTitle:   { fontSize: 11, fontWeight: '700', color: C.muted,
                    fontFamily: MONO, letterSpacing: 0.8, marginBottom: 4 },
  sectionSub:     { fontSize: 11, color: C.muted, marginBottom: 12, lineHeight: 16 },
  separator:      { height: 8 },

  card:           { backgroundColor: C.surface, borderRadius: 10,
                    borderWidth: 1, borderColor: C.border,
                    padding: 12 },
  cardHeader:     { flexDirection: 'row', justifyContent: 'space-between',
                    alignItems: 'flex-start', marginBottom: 4 },
  cardTitleRow:   { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  cardName:       { fontSize: 13, fontWeight: '600', color: C.text, fontFamily: MONO },
  cardSize:       { fontSize: 11, color: C.muted, fontFamily: MONO },
  cardMeta:       { fontSize: 11, color: C.muted, marginBottom: 8 },

  cloudBadge:       { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4,
                      backgroundColor: 'rgba(96,165,250,0.12)' },
  cloudBadgeText:   { fontSize: 9, color: C.cloud, fontWeight: '700', fontFamily: MONO },
  completeBadge:    { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4,
                      backgroundColor: 'rgba(52,211,153,0.12)' },
  completeBadgeText:{ fontSize: 9, color: C.success, fontWeight: '700', fontFamily: MONO },

  progressRow:    { marginBottom: 6 },
  progressTrack:  { height: 4, backgroundColor: C.surface2, borderRadius: 2, overflow: 'hidden', marginBottom: 4 },
  progressFill:   { height: 4, backgroundColor: C.accent, borderRadius: 2 },
  progressText:   { fontSize: 10, color: C.muted, fontFamily: MONO },

  errorText:      { fontSize: 11, color: C.error, marginBottom: 6, fontFamily: MONO },

  cardActions:    { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 4 },
  downloadBtn:    { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8,
                    backgroundColor: C.accent },
  downloadBtnText:{ fontSize: 12, color: '#fff', fontWeight: '600', fontFamily: MONO },
  cancelBtn:      { flexDirection: 'row', alignItems: 'center',
                    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8,
                    borderWidth: 1, borderColor: C.border },
  cancelBtnText:  { fontSize: 12, color: C.muted, fontFamily: MONO },

  cloudDisabledNote:  { marginTop: 20, padding: 12, borderRadius: 8,
                        backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border },
  cloudDisabledText:  { fontSize: 11, color: C.muted, fontFamily: MONO, textAlign: 'center' },
});
