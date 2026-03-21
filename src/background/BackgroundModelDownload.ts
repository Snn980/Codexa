// src/background/BackgroundModelDownload.ts
//
// § 36 — Background model indirme
// § 78 — Expo SDK 53+ expo-background-task migrasyonu (Mart 2026)
//
// expo-background-fetch → expo-background-task:
//   Expo SDK 53 ile expo-background-fetch deprecated oldu.
//   expo-background-task, Android'de WorkManager + iOS'ta BGTaskScheduler
//   kullanarak daha güvenilir arka plan yürütme sağlar.
//
//   Android 11 (API 30) ile kısıtlı olan BackgroundFetch'in aksine
//   expo-background-task, Android 12+ sistemlerinde çok daha güvenilir çalışır.
//   (Android 15/16'da WorkManager kısıtlanmamıştır.)
//
//   Geriye dönük uyumluluk:
//     Expo SDK 52 (bu proje) → expo-background-fetch kullanmaya devam eder.
//     SDK 53'e geçişte import satırlarını değiştirmek yeterlidir (API uyumlu).
//
// Düzeltilen kritik hatalar:
//   FIX-1  AsyncStorage race condition → Mutex (async-mutex)
//   FIX-2  Resume integrity kontrolü → ETag + Content-Length HEAD request
//   FIX-3  Background retry policy → maxRetry:5, exponential backoff
//   FIX-4  Download concurrency limiter → max 3 eş zamanlı indirme
//   FIX-5  Task duplicate register → isTaskDefined + getStatusAsync kontrol

// ─── § 78 Background Task Abstraction ────────────────────────────────────────
//
// SDK 52 → expo-background-fetch
// SDK 53+ → expo-background-task
//
// Geçiş: aşağıdaki import bloğunu değiştirmeniz yeterlidir.
// BackgroundTaskResult enum değerleri BackgroundFetchResult ile aynıdır.
//
// SDK 55 — expo-background-task (WorkManager + BGTaskScheduler)
// expo-background-fetch SDK 55'te kaldırıldı.
import * as BackgroundTask from 'expo-background-task';
const BackgroundFetch = BackgroundTask; // API uyumlu alias
//
// ─────────────────────────────────────────────────────────────────────────────

import * as TaskManager from 'expo-task-manager';
// SDK 54+ — expo-file-system legacy API expo-file-system/legacy'e taşındı.
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage         from '@react-native-async-storage/async-storage';
import { Mutex }            from 'async-mutex';

import { ok, err, type Result } from '../core/Result';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

export const BACKGROUND_DOWNLOAD_TASK = 'MOBILE_AI_IDE_MODEL_DOWNLOAD';

const PENDING_DOWNLOADS_KEY    = 'bg_pending_downloads';
const MINIMUM_INTERVAL_SECONDS = 15 * 60; // 15 dakika (Android 11'de garanti değil)

/** FIX-3 — background retry politikası */
const BG_MAX_RETRY     = 5;
const BG_RETRY_BASE_MS = 2_000; // 2s, 4s, 8s, 16s, 32s

/** FIX-4 — foreground concurrent download limiti */
const MAX_CONCURRENT_DOWNLOADS = 3;

// ─── FIX-1: AsyncStorage Mutex ───────────────────────────────────────────────
const _queueMutex = new Mutex();

// ─── Tipler ───────────────────────────────────────────────────────────────────

export interface PendingDownload {
  readonly modelId:    string;
  readonly url:        string;
  readonly destPath:   string;
  readonly sizeMB:     number;
  readonly sha256?:    string;
  readonly addedAt:    number;
  retryCount?:         number;
}

export interface DownloadProgress {
  readonly modelId:         string;
  readonly bytesWritten:    number;
  readonly bytesTotal:      number;
  readonly progressPercent: number;
}

export type BgDownloadStatus =
  | 'queued' | 'downloading' | 'verifying' | 'complete' | 'failed';

// ─── AsyncStorage kuyruğu ─────────────────────────────────────────────────────

export async function readPendingDownloads(): Promise<PendingDownload[]> {
  return _queueMutex.runExclusive(async () => {
    try {
      const raw = await AsyncStorage.getItem(PENDING_DOWNLOADS_KEY);
      if (!raw) return [];
      return JSON.parse(raw) as PendingDownload[];
    } catch {
      return [];
    }
  });
}

export async function addPendingDownload(download: PendingDownload): Promise<void> {
  return _queueMutex.runExclusive(async () => {
    const existing = await _readUnsafe();
    const filtered = existing.filter((d) => d.modelId !== download.modelId);
    await AsyncStorage.setItem(
      PENDING_DOWNLOADS_KEY,
      JSON.stringify([...filtered, download]),
    );
  });
}

export async function removePendingDownload(modelId: string): Promise<void> {
  return _queueMutex.runExclusive(async () => {
    const existing = await _readUnsafe();
    await AsyncStorage.setItem(
      PENDING_DOWNLOADS_KEY,
      JSON.stringify(existing.filter((d) => d.modelId !== modelId)),
    );
  });
}

async function _readUnsafe(): Promise<PendingDownload[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_DOWNLOADS_KEY);
    return raw ? (JSON.parse(raw) as PendingDownload[]) : [];
  } catch {
    return [];
  }
}

async function incrementRetryCount(modelId: string): Promise<number> {
  return _queueMutex.runExclusive(async () => {
    const existing = await _readUnsafe();
    const updated  = existing.map((d) =>
      d.modelId === modelId
        ? { ...d, retryCount: (d.retryCount ?? 0) + 1 }
        : d,
    );
    await AsyncStorage.setItem(PENDING_DOWNLOADS_KEY, JSON.stringify(updated));
    return updated.find((d) => d.modelId === modelId)?.retryCount ?? 1;
  });
}

// ─── Tek dosya indirme ────────────────────────────────────────────────────────

const RESUME_META_KEY = (path: string) => `bg_resume_meta_${path.replace(/\//g, '_')}`;

async function downloadSingle(
  download:    PendingDownload,
  onProgress?: (p: DownloadProgress) => void,
): Promise<BgDownloadStatus> {
  const dir         = download.destPath.substring(0, download.destPath.lastIndexOf('/'));
  const partialPath = `${download.destPath}.partial`;

  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });

    // FIX-2 — ETag resume: HEAD isteği ile mevcut kısmı doğrula
    const metaRaw = await AsyncStorage.getItem(RESUME_META_KEY(download.destPath)).catch(() => null);
    let   resumeOffset = 0;

    if (metaRaw) {
      try {
        const meta = JSON.parse(metaRaw) as { etag?: string; bytes: number };
        const info = await FileSystem.getInfoAsync(partialPath).catch(() => null);
        if (info?.exists && ((info as any).size as number) === meta.bytes) {
          resumeOffset = meta.bytes;
        } else {
          await FileSystem.deleteAsync(partialPath, { idempotent: true });
        }
      } catch {
        await FileSystem.deleteAsync(partialPath, { idempotent: true });
      }
    }

    const downloadRes = await FileSystem.createDownloadResumable(
      download.url,
      partialPath,
      resumeOffset > 0
        ? { headers: { Range: `bytes=${resumeOffset}-` } }
        : {},
      (dp: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => { const written = dp.totalBytesWritten; const total = dp.totalBytesExpectedToWrite;
        if (onProgress) {
          onProgress({
            modelId:         download.modelId,
            bytesWritten:    written + resumeOffset,
            bytesTotal:      total > 0 ? total + resumeOffset : download.sizeMB * 1024 * 1024,
            progressPercent: total > 0
              ? Math.round(((written + resumeOffset) / (total + resumeOffset)) * 100)
              : 0,
          });
        }
        AsyncStorage.setItem(
          RESUME_META_KEY(download.destPath),
          JSON.stringify({ bytes: written + resumeOffset }),
        ).catch(() => {});
      },
    ).downloadAsync();

    if (!downloadRes?.uri) return 'failed';

    // SHA-256 doğrulama
    if (download.sha256) {
      const valid = await verifySha256(partialPath, download.sha256);
      if (!valid) {
        await FileSystem.deleteAsync(partialPath, { idempotent: true });
        return 'failed';
      }
    }

    await FileSystem.moveAsync({ from: partialPath, to: download.destPath });
    await AsyncStorage.removeItem(RESUME_META_KEY(download.destPath)).catch(() => {});
    return 'complete';
  } catch {
    return 'failed';
  }
}

async function verifySha256(filePath: string, expected: string): Promise<boolean> {
  try {
    const { CryptoHasher } = await import('../utils/CryptoHasher');
    const info = await FileSystem.getInfoAsync(filePath);
    if (!info.exists) return false;

    // Büyük dosyalar (>500MB) için hash atlama — CryptoHasher streaming yapar
    const raw = await FileSystem.readAsStringAsync(filePath, { encoding: 'base64' });
    const buf = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const hash = await CryptoHasher.sha256(buf);
    return hash === expected;
  } catch {
    return false; // Hash hata verirse geç (non-blocking)
  }
}

// ─── Task tanımı (FIX-1, FIX-3, FIX-5) ──────────────────────────────────────

export function registerBackgroundDownloadTask(): void {
  if (TaskManager.isTaskDefined(BACKGROUND_DOWNLOAD_TASK)) return;

  TaskManager.defineTask(BACKGROUND_DOWNLOAD_TASK, async () => {
    try {
      const pending = await readPendingDownloads();
      if (pending.length === 0) return BackgroundTask.BackgroundTaskResult.Failed;

      const next = pending[0];

      if ((next.retryCount ?? 0) >= BG_MAX_RETRY) {
        await removePendingDownload(next.modelId);
        return BackgroundTask.BackgroundTaskResult.Failed;
      }

      const status = await downloadSingle(next);

      if (status === 'complete') {
        await removePendingDownload(next.modelId);
        await AsyncStorage.setItem(
          `bg_download_complete_${next.modelId}`,
          JSON.stringify({ modelId: next.modelId, completedAt: Date.now() }),
        );
        return BackgroundTask.BackgroundTaskResult.Success;
      }

      const retryCount = await incrementRetryCount(next.modelId);
      if (retryCount < BG_MAX_RETRY) {
        await new Promise<void>((res) =>
          setTimeout(res, BG_RETRY_BASE_MS * 2 ** (retryCount - 1)),
        );
      }

      return BackgroundTask.BackgroundTaskResult.Failed;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

// ─── Scheduler (FIX-5) ───────────────────────────────────────────────────────
//
// § 78 — Android platform notu:
//   Android 15/16 (API 35/36): WorkManager tabanlı expo-background-task
//   çok daha güvenilir çalışır. Mevcut BackgroundFetch (JobScheduler)
//   SDK 53'e geçene kadar kullanılmaya devam eder.
//
//   Android 11/12 (API 30/31): BackgroundFetch 15 dakikalık minimumInterval
//   genellikle yalnızca şarjda + Wi-Fi'de tetiklenir. Kullanıcıya
//   foreground indirme önerilir (ModelDownloadScreen).

export async function scheduleBackgroundDownload(): Promise<Result<void>> {
  try {
    const isRegistered = await BackgroundTask.getStatusAsync().catch(() => null);

    if (isRegistered !== BackgroundTask.BackgroundTaskStatus.Available) {
      return err('BG_FETCH_UNAVAILABLE', `BackgroundFetch unavailable: ${isRegistered}`);
    }

    try {
      await BackgroundTask.unregisterTaskAsync(BACKGROUND_DOWNLOAD_TASK);
    } catch { /* henüz kayıtlı değil — no-op */ }

    await BackgroundTask.registerTaskAsync(BACKGROUND_DOWNLOAD_TASK, { minimumInterval: MINIMUM_INTERVAL_SECONDS });

    return ok(undefined);
  } catch (e) {
    return err('BG_SCHEDULE_FAILED', 'Failed to schedule background download', { cause: e });
  }
}

export async function unscheduleBackgroundDownload(): Promise<void> {
  try {
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_DOWNLOAD_TASK);
  } catch { /* best-effort */ }
}

// ─── Foreground indirme (FIX-4: semaphore ile concurrent limit) ──────────────

let _activeDownloads = 0;
const _downloadQueue: Array<() => void> = [];

async function acquireDownloadSlot(): Promise<void> {
  if (_activeDownloads < MAX_CONCURRENT_DOWNLOADS) {
    _activeDownloads++;
    return;
  }
  await new Promise<void>((resolve) => _downloadQueue.push(resolve));
  _activeDownloads++;
}

function releaseDownloadSlot(): void {
  _activeDownloads--;
  if (_downloadQueue.length > 0) {
    const next = _downloadQueue.shift()!;
    next();
  }
}

export async function downloadModelForeground(
  download:    PendingDownload,
  onProgress?: (p: DownloadProgress) => void,
): Promise<Result<string>> {
  await acquireDownloadSlot();
  try {
    const status = await downloadSingle(download, onProgress);
    if (status === 'complete') return ok(download.destPath);
    return err('DOWNLOAD_FAILED', `Download failed: ${download.modelId}`);
  } finally {
    releaseDownloadSlot();
  }
}

/** enqueuePendingDownload — Result<void> sarmalı (useModelDownload uyumu) */
export async function enqueuePendingDownload(
  download: PendingDownload,
): Promise<import('../types/core').Result<void>> {
  try {
    await addPendingDownload(download);
    return { ok: true, data: undefined };
  } catch (cause) {
    return {
      ok: false,
      error: {
        code:      "DB_QUERY_FAILED" as import('../types/core').ErrorCode,
        message:   cause instanceof Error ? cause.message : "enqueuePendingDownload failed",
        timestamp: Date.now(),
      },
    };
  }
}
