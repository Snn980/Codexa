/**
 * src/screens/ModelDownloadScreen.tsx
 *
 * § 67 — Tam ekran model indirme görünümü.
 *         Phase 15 placeholder'ı kaldırıldı.
 *
 * Sorumluluk:
 *   - Aktif indirmeleri listeler (ModelDownloadManager.getState)
 *   - EventBus model:download:* dinleyerek gerçek zamanlı günceller
 *   - Her model için: progress bar, iptal butonu, hız ve kalan süre
 *
 * Fark (ModelsScreen vs ModelDownloadScreen):
 *   ModelsScreen     → tüm model kataloğu, indirme başlatma
 *   ModelDownloadScreen → sadece aktif/bekleyen indirmeler; detay odaklı
 *
 * § 4  : DI — container prop
 * § 8  : useRef + useEffect cleanup
 * § 45 : Semaphore — eş zamanlı maks 3 indirme
 * § 61 : EventBus model:download:* events
 * § 67 : ModelDownloadScreen tam implementasyon
 */

import React, {
  memo,
  useCallback,
  useEffect,
  useReducer,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AppContainer }   from '../app/AppContainer';
import type { AIModelId }      from '../ai/AIModels';
import { AI_MODELS }           from '../ai/AIModels';
import type { DownloadState }  from '../download/ModelDownloadManager';

// ─── Renkler ─────────────────────────────────────────────────────────────────

const C = {
  bg:       '#0f0f0f',
  surface:  '#1a1a1a',
  border:   '#2a2a2a',
  text:     '#e8e8e8',
  muted:    '#666',
  accent:   '#7c6af7',
  danger:   '#ef4444',
  success:  '#22c55e',
  warning:  '#f59e0b',
} as const;

// ─── State ────────────────────────────────────────────────────────────────────

type DownloadMap = Map<AIModelId, DownloadState>;

type Action =
  | { type: 'SET_STATE'; modelId: AIModelId; state: DownloadState }
  | { type: 'INIT'; states: DownloadMap };

function reducer(map: DownloadMap, action: Action): DownloadMap {
  switch (action.type) {
    case 'INIT':
      return new Map(action.states);
    case 'SET_STATE': {
      const next = new Map(map);
      next.set(action.modelId, action.state);
      return next;
    }
    default:
      return map;
  }
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  container: AppContainer;
}

// ─── ModelDownloadScreen ──────────────────────────────────────────────────────

export const ModelDownloadScreen = memo(({ container }: Props): React.ReactElement => {
  const insets = useSafeAreaInsets();
  const { downloadManager, eventBus } = container;

  // ─── State: tüm modellerin download durumu ────────────────────────────────

  const [stateMap, dispatch] = useReducer(reducer, new Map<AIModelId, DownloadState>());

  // İlk yükleme
  useEffect(() => {
    const initial = new Map<AIModelId, DownloadState>();
    for (const m of AI_MODELS) {
      initial.set(m.id, downloadManager.getState(m.id));
    }
    dispatch({ type: 'INIT', states: initial });
  }, [downloadManager]);

  // EventBus dinleyicileri — § 61
  useEffect(() => {
    const offProgress = eventBus.on('model:download:progress', (payload) => {
      const p = payload as { modelId: AIModelId; state: DownloadState };
      dispatch({ type: 'SET_STATE', modelId: p.modelId, state: p.state });
    });
    const offComplete = eventBus.on('model:download:complete', (payload) => {
      const p = payload as { modelId: AIModelId };
      const s = downloadManager.getState(p.modelId);
      dispatch({ type: 'SET_STATE', modelId: p.modelId, state: s });
    });
    const offError = eventBus.on('model:download:error', (payload) => {
      const p = payload as { modelId: AIModelId };
      const s = downloadManager.getState(p.modelId);
      dispatch({ type: 'SET_STATE', modelId: p.modelId, state: s });
    });
    const offCancel = eventBus.on('model:download:cancel', (payload) => {
      const p = payload as { modelId: AIModelId };
      const s = downloadManager.getState(p.modelId);
      dispatch({ type: 'SET_STATE', modelId: p.modelId, state: s });
    });

    return () => { offProgress(); offComplete(); offError(); offCancel(); };
  }, [downloadManager, eventBus]);

  // ─── Aktif indirme listesi ────────────────────────────────────────────────

  const activeItems = React.useMemo(() => {
    const result: Array<{ modelId: AIModelId; state: DownloadState; label: string }> = [];
    for (const [modelId, state] of stateMap) {
      if (state.status === 'idle' || state.status === 'complete') continue;
      const model = AI_MODELS.find(m => m.id === modelId);
      result.push({ modelId, state, label: model?.displayName ?? modelId });
    }
    return result;
  }, [stateMap]);

  const handleCancel = useCallback((modelId: AIModelId) => {
    downloadManager.cancelDownload(modelId);
  }, [downloadManager]);

  // ─── Render ───────────────────────────────────────────────────────────────

  if (activeItems.length === 0) {
    return (
      <View style={[styles.center, { paddingBottom: insets.bottom }]}>
        <Text style={styles.emptyIcon}>📦</Text>
        <Text style={styles.emptyTitle}>Aktif indirme yok</Text>
        <Text style={styles.emptyDesc}>
          Modeller sekmesinden indirme başlatabilirsin.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <Text style={styles.header}>İndirmeler</Text>
      <FlatList
        data={activeItems}
        keyExtractor={(item) => item.modelId}
        renderItem={({ item }) => (
          <DownloadItem
            label={item.label}
            state={item.state}
            onCancel={() => handleCancel(item.modelId)}
          />
        )}
        contentContainerStyle={styles.list}
        testID="download-list"
      />
    </View>
  );
});
ModelDownloadScreen.displayName = 'ModelDownloadScreen';

// ─── DownloadItem ─────────────────────────────────────────────────────────────

interface DownloadItemProps {
  label:    string;
  state:    DownloadState;
  onCancel: () => void;
}

function DownloadItem({ label, state, onCancel }: DownloadItemProps): React.ReactElement {
  const { status, percent } = state;

  const statusLabel = STATUS_LABELS[status] ?? status;
  const statusColor = STATUS_COLORS[status] ?? C.muted;
  const showProgress = status === 'downloading';
  const showSpinner  = status === 'verifying' || status === 'checking';
  const showCancel   = status === 'downloading' || status === 'queued';

  return (
    <View style={styles.item}>
      <View style={styles.itemTop}>
        <Text style={styles.itemName} numberOfLines={1}>{label}</Text>
        <Text style={[styles.itemStatus, { color: statusColor }]}>{statusLabel}</Text>
      </View>

      {showProgress && (
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${percent}%` }]} />
        </View>
      )}

      {showSpinner && (
        <ActivityIndicator size="small" color={C.accent} style={styles.spinner} />
      )}

      {status === 'failed' && (
        <Text style={styles.errorText}>İndirme başarısız. Modeller sekmesinden tekrar dene.</Text>
      )}

      <View style={styles.itemFooter}>
        {showProgress && (
          <Text style={styles.percentText}>{percent.toFixed(0)}%</Text>
        )}
        {showCancel && (
          <Pressable
            style={styles.cancelBtn}
            onPress={onCancel}
            accessibilityRole="button"
            accessibilityLabel="İndirmeyi iptal et"
            testID={`cancel-download-${label}`}
          >
            <Text style={styles.cancelBtnText}>✕ İptal</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ─── Sabitler ────────────────────────────────────────────────────────────────

const STATUS_LABELS: Partial<Record<DownloadState['status'], string>> = {
  queued:      '⏳ Kuyrukta',
  checking:    '🔍 Kontrol ediliyor',
  downloading: '⬇ İndiriliyor',
  verifying:   '🔍 Doğrulanıyor',
  complete:    '✓ Tamamlandı',
  failed:      '⚠ Başarısız',
  cancelled:   '✕ İptal edildi',
};

const STATUS_COLORS: Partial<Record<DownloadState['status'], string>> = {
  queued:      C.muted,
  checking:    C.muted,
  downloading: C.accent,
  verifying:   C.warning,
  complete:    C.success,
  failed:      C.danger,
  cancelled:   C.muted,
};

// ─── Stiller ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:         { flex: 1, backgroundColor: C.bg },
  center:       { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: 32 },
  header:       { color: C.text, fontSize: 20, fontWeight: '700', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  list:         { padding: 12, gap: 8 },

  emptyIcon:    { fontSize: 48, textAlign: 'center', marginBottom: 12 },
  emptyTitle:   { color: C.text, fontSize: 18, fontWeight: '600', textAlign: 'center', marginBottom: 8 },
  emptyDesc:    { color: C.muted, fontSize: 14, textAlign: 'center', lineHeight: 20 },

  item:         { backgroundColor: C.surface, borderRadius: 10, padding: 14, borderWidth: 1, borderColor: C.border },
  itemTop:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  itemName:     { color: C.text, fontSize: 15, fontWeight: '600', flex: 1, marginRight: 8 },
  itemStatus:   { fontSize: 12, fontWeight: '500' },
  itemFooter:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },

  progressTrack: { height: 4, backgroundColor: C.border, borderRadius: 2, overflow: 'hidden' },
  progressFill:  { height: 4, backgroundColor: C.accent, borderRadius: 2 },

  spinner:      { marginTop: 4, alignSelf: 'flex-start' },
  errorText:    { color: C.danger, fontSize: 12, marginTop: 4 },
  percentText:  { color: C.muted, fontSize: 12 },

  cancelBtn:    {
    paddingHorizontal: 12,
    paddingVertical:   6,
    backgroundColor:   'rgba(239,68,68,0.15)',
    borderRadius:      6,
    borderWidth:       1,
    borderColor:       C.danger,
  },
  cancelBtnText: { color: C.danger, fontSize: 12, fontWeight: '600' },
});
