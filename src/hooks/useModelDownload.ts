// src/hooks/useModelDownload.ts
// § 36 — Model indirme hook (foreground + background)
//
// Kural:
//   - Foreground: progress gösterilir, uygulama açıkken
//   - Background: uygulama kapalıyken expo-background-fetch devam eder
//   - Resume: storedBytes > 0 → Range header (§ 17.5)
//   - mountedRef: unmount sonrası setState çağrılmaz (§ 8)
//   - _downloadLock: paralel aynı model download'ı engeller (§ 17.5)
//   - EventBus 'model:download:complete' emit (§ 22.3)

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { IEventBus }      from '../core/EventBus';
import type { AIModelId }      from '../models/AIModels';
import {
  downloadModelForeground,
  enqueuePendingDownload,
  readPendingDownloads,
  type DownloadProgress,
  type PendingDownload,
} from '../background/BackgroundModelDownload';

// ─── Tipler ───────────────────────────────────────────────────────────────────

export type DownloadStatus =
  | 'idle'
  | 'queued'        // background kuyruğuna alındı
  | 'downloading'
  | 'verifying'
  | 'complete'
  | 'failed';

export interface ModelDownloadState {
  readonly status:          DownloadStatus;
  readonly progressPercent: number;
  readonly bytesWritten:    number;
  readonly bytesTotal:      number;
  readonly errorMessage:    string | null;
}

const INITIAL_STATE: ModelDownloadState = {
  status:          'idle',
  progressPercent: 0,
  bytesWritten:    0,
  bytesTotal:      0,
  errorMessage:    null,
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseModelDownloadOptions {
  eventBus:   IEventBus;
  destDir?:   string; // varsayılan: FileSystem.documentDirectory + 'models/'
}

export interface UseModelDownloadReturn {
  states:               Readonly<Record<string, ModelDownloadState>>;
  startDownload:        (modelId: AIModelId, download: PendingDownload) => Promise<void>;
  enqueueBackground:    (modelId: AIModelId, download: PendingDownload) => Promise<void>;
  cancelDownload:       (modelId: AIModelId) => void;
  getState:             (modelId: AIModelId) => ModelDownloadState;
  pendingCount:         number;
}

export function useModelDownload(
  opts: UseModelDownloadOptions,
): UseModelDownloadReturn {
  const { eventBus } = opts;

  const [states, setStates] = useState<Record<string, ModelDownloadState>>({});

  // § 8 — mountedRef
  const mountedRef  = useRef(true);
  const lockRef     = useRef(new Set<string>()); // § 17.5 — _downloadLock
  const abortMap    = useRef(new Map<string, AbortController>());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Tüm aktif download'ları iptal et
      for (const ctrl of abortMap.current.values()) ctrl.abort();
    };
  }, []);

  // Background'dan tamamlananları foreground'a bildir
  useEffect(() => {
    const unsub = eventBus.on(
      'model:download:complete',
      ({ modelId }: { modelId: string }) => {
        if (!mountedRef.current) return;
        setStates((prev) => ({
          ...prev,
          [modelId]: {
            ...INITIAL_STATE,
            status: 'complete',
          },
        }));
      },
    );
    return unsub;
  }, [eventBus]);

  // ── State güncelleme yardımcısı ──
  const updateState = useCallback(
    (modelId: string, patch: Partial<ModelDownloadState>) => {
      if (!mountedRef.current) return;
      setStates((prev) => ({
        ...prev,
        [modelId]: { ...(prev[modelId] ?? INITIAL_STATE), ...patch },
      }));
    },
    [],
  );

  // ── Foreground download ──
  const startDownload = useCallback(
    async (modelId: AIModelId, download: PendingDownload): Promise<void> => {
      // § 17.5 — paralel aynı model koruması
      if (lockRef.current.has(modelId)) return;
      lockRef.current.add(modelId);

      updateState(modelId, { status: 'downloading', errorMessage: null });

      const onProgress = (p: DownloadProgress) => {
        updateState(modelId, {
          status:          'downloading',
          progressPercent: p.progressPercent,
          bytesWritten:    p.bytesWritten,
          bytesTotal:      p.bytesTotal,
        });
      };

      try {
        updateState(modelId, { status: 'verifying' });
        const result = await downloadModelForeground(download, onProgress);

        if (result.ok) {
          updateState(modelId, { status: 'complete', progressPercent: 100 });
          // § 22.3 — eventBus zinciri
          eventBus.emit('model:download:complete', {
            modelId,
            localPath: result.data,
          });
        } else {
          updateState(modelId, {
            status:       'failed',
            errorMessage: result.message,
          });
          eventBus.emit('model:download:failed', { modelId, error: result.message });
        }
      } finally {
        lockRef.current.delete(modelId);
        abortMap.current.delete(modelId);
      }
    },
    [eventBus, updateState],
  );

  // ── Background download kuyruğu ──
  const enqueueBackground = useCallback(
    async (modelId: AIModelId, download: PendingDownload): Promise<void> => {
      const result = await enqueuePendingDownload(download);
      if (result.ok) {
        updateState(modelId, { status: 'queued' });
      } else {
        updateState(modelId, { status: 'failed', errorMessage: result.message });
      }
    },
    [updateState],
  );

  // ── Cancel ──
  const cancelDownload = useCallback((modelId: AIModelId) => {
    abortMap.current.get(modelId)?.abort();
    abortMap.current.delete(modelId);
    lockRef.current.delete(modelId);
    updateState(modelId, INITIAL_STATE);
  }, [updateState]);

  // ── Getter ──
  const getState = useCallback(
    (modelId: AIModelId): ModelDownloadState =>
      states[modelId] ?? INITIAL_STATE,
    [states],
  );

  // ── Pending count ──
  const [pendingCount, setPendingCount] = useState(0);
  useEffect(() => {
    readPendingDownloads()
      .then((list) => {
        if (mountedRef.current) setPendingCount(list.length);
      })
      .catch(() => {});
  }, [states]); // states değişince (tamamlama/hata) yeniden say

  return {
    states,
    startDownload,
    enqueueBackground,
    cancelDownload,
    getState,
    pendingCount,
  };
}
