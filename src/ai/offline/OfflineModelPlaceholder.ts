/**
 * ai/offline/OfflineModelPlaceholder.ts
 *
 * ── Offline AI — Gelecek Sürüm Planı ─────────────────────────────────────
 *
 * DURUM: Offline çıkarım motoru (MLC/llama.cpp) mevcut aşamada
 * devre dışı bırakılmıştır. Mobil cihazlarda verim %30 seviyesindedir;
 * motor olgunlaştığında aşağıdaki arayüz ve fabrika fonksiyonu
 * CloudRuntime ile aynı pattern'da sisteme entegre edilecektir.
 *
 * ── Hedef Modeller ────────────────────────────────────────────────────────
 *  • Gemma 3 1B   (~700MB,  Q4_K_M) — hafif, temel tamamlama
 *  • Qwen 2.5 Coder 1.5B (~1.2GB) — kodlama odaklı
 *  • Phi-4 Mini   (~2.4GB, Q4_K_M) — reasoning/TypeScript
 *
 * ── Entegrasyon Noktaları ─────────────────────────────────────────────────
 *  1. AIRuntimeFactory.createOfflineRuntime(modelId, keyStore)
 *  2. ModelRouter → LOCAL_ONLY izni ile offline modelleri önceliklendir
 *  3. ParallelExecutor → offline-first + cloud escalation
 *  4. ModelDownloadManager → GGUF indirme + SHA-256 doğrulama (hazır)
 *
 * ── Aktivasyon Koşulları ──────────────────────────────────────────────────
 *  □ @react-native-ai/mlc verim > %70 (benchmark bekleniyor: Q3 2026)
 *  □ Phi-4 Mini / Gemma 3 mobil optimizasyon (Callstack AI repo takibi)
 *  □ OPFS model depolaması iOS/Android stabil (expo-file-system hazır)
 *
 * ── Aktivasyon Adımları (hazır olunca) ───────────────────────────────────
 *  1. src/__mocks__/@react-native-ai/mlc.js mock'unu kaldır
 *  2. AIRuntimeFactory'de `createOfflineRuntime` metodunu aç
 *  3. app.json'da NDK versiyonunu güncelle (mevcut: 28.0.12433566)
 *  4. eas build --profile production (native build zorunlu)
 *
 * § 1  : Result<T> pattern
 * § 34 : IAIWorkerRuntime arayüzü
 */

import type { IAIWorkerRuntime }  from '../IAIWorkerRuntime';
import type { AIModelId }         from '../AIModels';
import { err }                    from '../../core/Result';
import type { Result }            from '../../core/Result';
import type { RuntimeChatRequest, StreamResult } from '../IAIWorkerRuntime';
import { RuntimeErrorCode }       from '../IAIWorkerRuntime';

// ─── Gelecek Arayüz ──────────────────────────────────────────────────────────

/**
 * Offline runtime'ın uygulayacağı ek arayüz.
 * IAIWorkerRuntime'ı extend eder — CloudRuntime ile homojen.
 */
export interface IOfflineRuntime extends IAIWorkerRuntime {
  /** Model cihazda yüklü mü? */
  isModelDownloaded(modelId: AIModelId): Promise<boolean>;

  /** Model RAM'e yükle (inference öncesi) */
  loadModel(modelId: AIModelId): Promise<Result<void>>;

  /** Model RAM'den kaldır */
  unloadModel(modelId: AIModelId): Promise<void>;

  /** Şu an yüklü model */
  readonly loadedModelId: AIModelId | null;
}

// ─── Placeholder Runtime ──────────────────────────────────────────────────────

/**
 * Offline AI henüz hazır olmadığında kullanılan yer tutucu.
 * Tüm çağrılara anlamlı hata döndürür; uygulama çökmez.
 *
 * OfflineModelPlaceholder, AIRuntimeFactory tarafından oluşturulur.
 * Aktivasyon sonrası gerçek MLC runtime ile değiştirilir.
 */
export class OfflineModelPlaceholder implements IOfflineRuntime {
  readonly loadedModelId: AIModelId | null = null;

  isReady(_modelId: AIModelId): boolean {
    return false;
  }

  async *streamChat(
    _request: RuntimeChatRequest,
  ): AsyncGenerator<string, Result<StreamResult>, unknown> {
    return err(
      RuntimeErrorCode.MODEL_NOT_LOADED,
      'Offline AI şu an devre dışı. Lütfen Ayarlar\'dan bir cloud model seçin.',
    );
  }

  async isModelDownloaded(_modelId: AIModelId): Promise<boolean> {
    return false;
  }

  async loadModel(_modelId: AIModelId): Promise<Result<void>> {
    return err(
      RuntimeErrorCode.MODEL_NOT_LOADED,
      'Offline AI motoru bu sürümde aktif değil.',
    );
  }

  async unloadModel(_modelId: AIModelId): Promise<void> {
    // no-op
  }

  dispose(): void {
    // no-op
  }
}

// ─── Fabrika ──────────────────────────────────────────────────────────────────

/**
 * Offline runtime oluşturur.
 * Şu an: OfflineModelPlaceholder döner.
 * Aktivasyon sonrası: MLC tabanlı gerçek runtime döner.
 *
 * @future
 * import { MLCRuntime } from './MLCRuntime';
 * return new MLCRuntime(keyStore);
 */
export function createOfflineRuntime(): IOfflineRuntime {
  return new OfflineModelPlaceholder();
}

// ─── Aktivasyon Takvimi ───────────────────────────────────────────────────────

/**
 * @milestone OFFLINE_AI_V1
 * Hedef: Q3 2026
 *
 * Bağımlılıklar:
 *   - @react-native-ai/mlc >= 1.0 (stabil)
 *   - Callstack AI mobil benchmark >= %70 verim
 *   - GGUF model repo checksum'ları güncellendi
 *
 * Test Planı:
 *   1. src/__tests__/Phase7.test.ts → OfflineRuntime unit test
 *   2. E2E: Samsung Galaxy A55 (Android 15) — Gemma 3 1B inference
 *   3. E2E: iPhone 16 (iOS 26) — Phi-4 Mini inference
 *   4. Bellek: Xcode Instruments + Android Profiler — max 4GB RAM kontrol
 */
