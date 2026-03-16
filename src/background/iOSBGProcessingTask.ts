/**
 * background/iOSBGProcessingTask.ts
 *
 * § 36 (T-P15-5) — iOS BGProcessingTask: uzun model indirme için.
 * § 78 — iOS 26 uyumluluk güncellemesi (Mart 2026)
 *
 * Neden BGProcessingTask?
 *   BackgroundFetch: maks ~30s çalışma garantisi, 15 dakika minimum aralık.
 *   BGProcessingTask: birkaç dakika çalışabilir, güç kaynağına bağlıyken
 *   daha uzun süre alabilir — GGUF dosyaları (700MB–2.5GB) için zorunlu.
 *
 * Platform davranışı:
 *   iOS 15.1+  → BGProcessingTask (expo-task-manager + BGProcessingTaskOptions)
 *   iOS 26   → Aynı API, değişiklik yok. iOS 26 = Apple'ın iOS 19 için
 *              kullandığı yeni adlandırma; BGTaskScheduler API'si değişmedi.
 *   Android  → no-op, BackgroundFetch (SDK 52) / expo-background-task (SDK 53+)
 *   Simulator → task kayıt başarısız olur, uygulama çalışmaya devam eder
 *
 * § 78 — iOS 26 notları:
 *   • BGProcessingTask API değişmedi — mevcut kod iOS 26'da sorunsuz çalışır.
 *   • iOS 26 Liquid Glass UI: arka plan indirme progress UI'ı etkilemez.
 *   • deploymentTarget "15.1" → iPhone 6s ve üzeri (A9+) destekleniyor.
 *     iOS 14 ve altı Expo SDK 52 minimum kısıtı ile DROPPED.
 *   • Privacy Manifest (PrivacyInfo.xcprivacy): expo-build-properties ile
 *     otomatik eklenmekte; ekstra adım gerekmez.
 *
 * Kurulum gereksinimleri (app.json):
 *   {
 *     "ios": {
 *       "deploymentTarget": "15.1",           ← Expo SDK 52 minimum
 *       "infoPlist": {
 *         "BGTaskSchedulerPermittedIdentifiers": [
 *           "com.mobileaiide.model.processing"
 *         ]
 *       },
 *       "entitlements": {
 *         "com.apple.developer.background-task": true
 *       }
 *     }
 *   }
 *
 * § 1  : Result<T> — scheduleIOSProcessingTask throw etmez
 */

import * as TaskManager from 'expo-task-manager';
import { Platform }     from 'react-native';
import { ok, err }      from '../core/Result';
import type { Result }  from '../core/Result';
import {
  readPendingDownloads,
  removePendingDownload,
  downloadModelForeground,
}                       from './BackgroundModelDownload';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

export const IOS_BG_PROCESSING_TASK = 'com.mobileaiide.model.processing';

/**
 * BGProcessingTask için minimum ertelenme süresi (saniye).
 * 0 = "mümkün olan en kısa sürede" — iOS scheduler'ın takdirine bırakılır.
 * Genellikle 1-5 dakika içinde tetiklenir (cihaz boşta, şarjda).
 */
const EARLIEST_BEGIN_DATE_SECONDS = 0;

// ─── Task tanımı ──────────────────────────────────────────────────────────────

/**
 * BGProcessingTask'ı tanımla.
 * AppContainer.init() sırasında çağrılır (iOS'ta).
 * Tekrar çağrılırsa isTaskDefined guard'ı erken döner.
 */
export function registerIOSProcessingTask(): void {
  if (Platform.OS !== 'ios') return;
  if (TaskManager.isTaskDefined(IOS_BG_PROCESSING_TASK)) return;

  TaskManager.defineTask(IOS_BG_PROCESSING_TASK, async ({ error }) => {
    if (error) {
      console.warn('[BGProcessingTask] Task error:', error);
      return;
    }

    try {
      const pending = await readPendingDownloads();
      if (pending.length === 0) {
        if (__DEV__) console.log('[BGProcessingTask] No pending downloads.');
        return;
      }

      // En büyük dosyayı önce indir (processingTask daha uzun süre alır)
      const sorted = [...pending].sort((a, b) => b.sizeMB - a.sizeMB);
      const target = sorted[0];

      if (__DEV__) {
        console.log(`[BGProcessingTask] Downloading: ${target.modelId} (${target.sizeMB}MB)`);
      }

      const result = await downloadModelForeground(target, (progress) => {
        if (__DEV__) {
          console.log(`[BGProcessingTask] ${target.modelId}: ${progress.progressPercent}%`);
        }
      });

      if (result.ok) {
        await removePendingDownload(target.modelId);
        if (__DEV__) console.log(`[BGProcessingTask] Complete: ${target.modelId}`);
      } else {
        console.warn(`[BGProcessingTask] Failed: ${target.modelId}`, result.error.message);
      }

    } catch (e) {
      console.warn('[BGProcessingTask] Unhandled error:', e);
    }
  });
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

/**
 * iOS BGProcessingTask'ı zamanla.
 *
 * expo-task-manager v0.18+: BGProcessingTaskOptions desteği.
 * iOS 15.1+ gerektirir (deploymentTarget = "15.1" ile garanti).
 *
 * Android'de no-op döner.
 *
 * § 78 — iOS 26 notu:
 *   scheduleBGProcessingTaskAsync iOS 26'da değişmedi.
 *   Liquid Glass UI geçişi background scheduling'i etkilemez.
 */
export async function scheduleIOSProcessingTask(): Promise<Result<void>> {
  if (Platform.OS !== 'ios') {
    return ok(undefined);
  }

  try {
    const TaskManagerModule = TaskManager as typeof TaskManager & {
      scheduleBGProcessingTaskAsync?: (
        taskIdentifier: string,
        options?: {
          earliestBeginDate?:         number;
          requiresNetworkConnectivity?: boolean;
          requiresExternalPower?:       boolean;
        },
      ) => Promise<void>;
    };

    if (typeof TaskManagerModule.scheduleBGProcessingTaskAsync !== 'function') {
      if (__DEV__) {
        console.log('[BGProcessingTask] scheduleBGProcessingTaskAsync not available.');
      }
      return ok(undefined);
    }

    await TaskManagerModule.scheduleBGProcessingTaskAsync(IOS_BG_PROCESSING_TASK, {
      earliestBeginDate:          EARLIEST_BEGIN_DATE_SECONDS,
      requiresNetworkConnectivity: true,
      requiresExternalPower:       false,
    });

    if (__DEV__) console.log('[BGProcessingTask] Scheduled:', IOS_BG_PROCESSING_TASK);
    return ok(undefined);

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (__DEV__) console.warn('[BGProcessingTask] Schedule failed (normal in Simulator):', msg);
    return err('BG_PROCESSING_SCHEDULE_FAILED', msg);
  }
}

/**
 * Tüm bekleyen indirmeler tamamlandığında çağrılır.
 * BGProcessingTask'ı iptal eder.
 */
export async function cancelIOSProcessingTask(): Promise<void> {
  if (Platform.OS !== 'ios') return;

  try {
    const TaskManagerModule = TaskManager as typeof TaskManager & {
      cancelBGProcessingTaskAsync?: (taskIdentifier: string) => Promise<void>;
    };

    if (typeof TaskManagerModule.cancelBGProcessingTaskAsync === 'function') {
      await TaskManagerModule.cancelBGProcessingTaskAsync(IOS_BG_PROCESSING_TASK);
    }
  } catch { /* best-effort */ }
}
