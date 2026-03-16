/**
 * ota/ModelVersionManifest.ts — T-P10-3: OTA model versiyon yönetimi
 *
 * T-P10-3 KAPANDI:
 *   expo-updates OTA bundle ile model versiyon manifest
 *   ModelDownloadManager.checkForUpdate(manifest)
 *   Semantic versiyon: "gemma-3-1b@1.2.0" → storedBytes resume desteği
 *
 * § 1  : Result<T>
 *
 * Manifest şeması (CDN'de barındırılır, OTA ile güncellenir):
 *   {
 *     "schemaVersion": 1,
 *     "updatedAt": "2026-03-09T00:00:00Z",
 *     "models": [
 *       {
 *         "id": "offline:gemma-3-1b",
 *         "version": "1.2.0",
 *         "filename": "gemma-3-1b-it-Q4_K_M.gguf",
 *         "sizeMB": 700,
 *         "sha256": "abc123...",
 *         "downloadUrl": "https://cdn.example.com/models/gemma-3-1b-v1.2.0.gguf",
 *         "minAppVersion": "1.0.0"
 *       }
 *     ]
 *   }
 *
 * Güncelleme akışı:
 *   1. fetchManifest(manifestUrl) → ModelManifest
 *   2. checkForUpdate(manifest, storage) → UpdateCheckResult[]
 *   3. UI → kullanıcı onayı (isteğe bağlı)
 *   4. ModelDownloadManager.startDownload(model, { forceRedownload: true })
 *      → Resume: storedBytes > 0 → Range header (Phase 8'den)
 */

import { ok, err }   from "../core/Result";
import type { Result } from "../core/Result";
import type { AIModelId } from "../ai/AIModels";
import type { IStorageInfo } from "../download/ModelDownloadManager";

// ─── Manifest tipleri ─────────────────────────────────────────────────────────

export interface ModelManifestEntry {
  id:             AIModelId;
  version:        string;         // semver: "1.2.0"
  filename:       string;
  sizeMB:         number;
  sha256:         string;
  downloadUrl:    string;
  minAppVersion?: string;         // opsiyonel: uygulama sürüm gereksinimi
  releaseNotes?:  string;
}

export interface ModelManifest {
  schemaVersion: number;
  updatedAt:     string;          // ISO 8601
  models:        ModelManifestEntry[];
}

// ─── Güncelleme sonucu ────────────────────────────────────────────────────────

export type UpdateStatus =
  | "up-to-date"      // Yüklü versiyon == manifest versiyonu
  | "update-available" // Manifest'te daha yeni versiyon var
  | "not-installed";  // Model hiç yüklü değil

export interface UpdateCheckResult {
  modelId:       AIModelId;
  currentVersion: string | null;  // null = yüklü değil
  latestVersion: string;
  status:        UpdateStatus;
  entry:         ModelManifestEntry;
}

// ─── Manifest hata kodları ────────────────────────────────────────────────────

export const ManifestErrorCode = {
  FETCH_FAILED:        "MANIFEST_FETCH_FAILED",
  PARSE_FAILED:        "MANIFEST_PARSE_FAILED",
  SCHEMA_MISMATCH:     "MANIFEST_SCHEMA_MISMATCH",
  NETWORK_UNAVAILABLE: "MANIFEST_NETWORK_UNAVAILABLE",
} as const;

// ─── Versiyon depolama ────────────────────────────────────────────────────────

/**
 * Yüklü model versiyonlarını AsyncStorage'da saklar.
 * Key: `model_version_{modelId}` → value: "1.2.0"
 *
 * AsyncStorage arayüzü — inject edilir (test kolaylığı + RN bağımsızlığı).
 */
export interface IVersionStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const versionKey = (modelId: AIModelId) => `model_version_${modelId}`;

export class ModelVersionStore {
  private readonly _store: IVersionStore;
  constructor(store: IVersionStore) { this._store = store; }

  async getVersion(modelId: AIModelId): Promise<string | null> {
    try { return this._store.getItem(versionKey(modelId)); }
    catch { return null; }
  }

  async setVersion(modelId: AIModelId, version: string): Promise<void> {
    try { await this._store.setItem(versionKey(modelId), version); }
    catch { /* storage hatası → sessizce geç */ }
  }

  async clearVersion(modelId: AIModelId): Promise<void> {
    try { await this._store.removeItem(versionKey(modelId)); }
    catch { /* ignore */ }
  }
}

// ─── Semver karşılaştırma ─────────────────────────────────────────────────────

/**
 * Basit semver: "MAJOR.MINOR.PATCH"
 * Returns: -1 (a < b) | 0 (a == b) | 1 (a > b)
 * Geçersiz format → 0 (eşit say, güncelleme tetiklenmesin)
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string): [number, number, number] | null => {
    const parts = v.replace(/^v/, "").split(".").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return parts as [number, number, number];
  };

  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;

  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return  1;
  }
  return 0;
}

// ─── Manifest fetch ───────────────────────────────────────────────────────────

/**
 * CDN'den manifest indir + parse et.
 * Timeout: 10s (manifest küçük JSON, uzun bekleme gerekmez).
 * Cache-Control: CDN tarafından yönetilir; client'ta no-cache (güncel versiyon).
 */
export async function fetchManifest(
  manifestUrl: string,
  opts?: { timeoutMs?: number },
): Promise<Result<ModelManifest>> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  try {
    const signal   = AbortSignal.timeout(timeoutMs);
    const response = await fetch(manifestUrl, {
      signal,
      headers: { "Cache-Control": "no-cache" },
    });

    if (!response.ok) {
      return err(
        ManifestErrorCode.FETCH_FAILED,
        `HTTP ${response.status} — ${manifestUrl}`,
      );
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return err(ManifestErrorCode.PARSE_FAILED, "JSON parse hatası");
    }

    // Şema doğrulaması
    if (
      typeof raw !== "object" || raw === null ||
      !("schemaVersion" in raw) || !("models" in raw) ||
      (raw as any).schemaVersion !== 1
    ) {
      return err(ManifestErrorCode.SCHEMA_MISMATCH, "Geçersiz manifest şeması");
    }

    return ok(raw as ModelManifest);
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes("AbortError") || msg.includes("timeout")) {
      return err(ManifestErrorCode.FETCH_FAILED, `Timeout (${timeoutMs}ms)`);
    }
    if (msg.includes("NetworkError") || msg.includes("Failed to fetch")) {
      return err(ManifestErrorCode.NETWORK_UNAVAILABLE, "Ağ erişimi yok");
    }
    return err(ManifestErrorCode.FETCH_FAILED, msg);
  }
}

// ─── Güncelleme kontrolü ─────────────────────────────────────────────────────

/**
 * T-P10-3 KAPANDI: checkForUpdate
 *
 * Manifest'teki her model için:
 *   1. Yüklü mü? (IStorageInfo.modelExists)
 *   2. Yüklü versiyon manifest versiyonundan eski mi? (semver)
 *   3. UpdateCheckResult üret
 *
 * Resume desteği:
 *   update-available → ModelDownloadManager.startDownload(entry)
 *   storedBytes > 0  → Range: bytes=N- header ile kaldığı yerden devam
 */
export async function checkForUpdate(
  manifest:     ModelManifest,
  storage:      IStorageInfo,
  versionStore: ModelVersionStore,
): Promise<UpdateCheckResult[]> {
  const results: UpdateCheckResult[] = [];

  for (const entry of manifest.models) {
    const [exists, currentVersion] = await Promise.all([
      storage.modelExists(entry.filename).catch(() => false),
      versionStore.getVersion(entry.id).catch(() => null),
    ]);

    let status: UpdateStatus;
    if (!exists) {
      status = "not-installed";
    } else if (!currentVersion) {
      // Yüklü ama versiyon kaydı yok → güncelleme önerilebilir (güvenli taraf)
      status = "update-available";
    } else {
      status = compareSemver(currentVersion, entry.version) < 0
        ? "update-available"
        : "up-to-date";
    }

    results.push({
      modelId:        entry.id,
      currentVersion: exists ? (currentVersion ?? "unknown") : null,
      latestVersion:  entry.version,
      status,
      entry,
    });
  }

  return results;
}

// ─── ModelUpdateCoordinator ───────────────────────────────────────────────────

/**
 * Manifest fetch + güncelleme kontrolü + download başlatma koordinatörü.
 * UI katmanı bu sınıfı kullanır.
 */
export class ModelUpdateCoordinator {
  private readonly _manifestUrl:   string;
  private readonly _storage:       IStorageInfo;
  private readonly _versionStore:  ModelVersionStore;
  private _lastManifest:           ModelManifest | null = null;
  private _checking = false;

  constructor(opts: {
    manifestUrl:  string;
    storage:      IStorageInfo;
    versionStore: ModelVersionStore;
  }) {
    this._manifestUrl  = opts.manifestUrl;
    this._storage      = opts.storage;
    this._versionStore = opts.versionStore;
  }

  /**
   * Manifest'i indir ve güncellemeleri kontrol et.
   * Eş zamanlı çağrılara karşı guard: _checking bayrağı.
   */
  async check(): Promise<Result<UpdateCheckResult[]>> {
    if (this._checking) return ok([]); // zaten kontrol ediliyor
    this._checking = true;

    try {
      const manifestResult = await fetchManifest(this._manifestUrl);
      if (!manifestResult.ok) return manifestResult as Result<UpdateCheckResult[]>;

      this._lastManifest = manifestResult.data;
      const results = await checkForUpdate(
        manifestResult.data,
        this._storage,
        this._versionStore,
      );
      return ok(results);
    } finally {
      this._checking = false;
    }
  }

  /**
   * Model başarıyla indirilince çağrılır — versiyon kaydını günceller.
   */
  async onDownloadComplete(modelId: AIModelId): Promise<void> {
    if (!this._lastManifest) return;
    const entry = this._lastManifest.models.find((m) => m.id === modelId);
    if (entry) {
      await this._versionStore.setVersion(modelId, entry.version);
    }
  }

  /**
   * Model silinince versiyon kaydını temizle.
   */
  async onModelDeleted(modelId: AIModelId): Promise<void> {
    await this._versionStore.clearVersion(modelId);
  }

  get lastManifest(): ModelManifest | null { return this._lastManifest; }
}
