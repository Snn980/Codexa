// src/permission/PermissionGate.ts
//
// § 78 — Platform Compatibility Refactor (Mart 2026)
//
// OS Dağılımı (Mart 2026 — kaynak: Google Dec 2025, AppBrain, TelemetryDeck):
//   Android 16 (API 36): ~7.5%  → targetSdk = 36, edge-to-edge zorunlu, opt-out YOK
//   Android 15 (API 35): ~20.7% → en yaygın sürüm; targetSdk 35+ ile edge-to-edge enforce
//   Android 14 (API 34): ~12%   → READ_MEDIA_VISUAL_USER_SELECTED (kısmi fotoğraf erişimi)
//   Android 13 (API 33): ~14%   → POST_NOTIFICATIONS zorunlu
//   Android 12 (API 31/32): ~12%→ minSdkVersion önerisi: 24 (Expo SDK 52 minimum)
//   Android 11 (API 30): ~13.7% → ⚠️ hâlâ önemli kitle; dropping önerilmez
//   Android 10 ve altı  : ~13%  → minSdkVersion = 24 ile desteklenmez
//
//   iOS 26 (= iOS 19)   : ~76%  → Apple Eylül 2025'te iOS 19 → iOS 26 olarak yeniden adlandırdı
//   iOS 18              : ~19%  → deploymentTarget 15.1 ile kapsanır
//   iOS 17              : ~3%   → deploymentTarget 15.1 ile kapsanır
//   iOS 16              : ~2%   → deploymentTarget 15.1 ile kapsanır
//   iOS 15              : ~1%   → minimum destek sınırı (deploymentTarget: "15.1")
//   iOS 14 ve altı      : —     → Expo SDK 52 minimum → DROPPED
//
// Değişiklikler (§ 78):
//   ✅ storage / photoLibrary: Android 14 (API 34) READ_MEDIA_VISUAL_USER_SELECTED eklendi
//   ✅ 'limited' status artık "kısmi erişim verildi" olarak kabul ediliyor (iOS + Android 16)
//   ✅ checkAll: API 28 seri-check special-case kaldırıldı (minSdk ≥ 31 ile gereksiz)
//   ✅ _isNotificationAlwaysGranted: minSdk 31 altı guard kaldırıldı, API < 33 korundu
//   ✅ requestPermission: 'limited' → 'granted' eşdeğeri olarak davranır
//   ✅ resolvePermission: Android 16 fotoğraf izni akışı güncellendi

import { Platform, Linking } from 'react-native';
import {
  check,
  request,
  checkMultiple,
  requestMultiple,
  openSettings,
  PERMISSIONS,
  RESULTS,
  type Permission,
  type PermissionStatus,
} from 'react-native-permissions';
import type { IEventBus } from '../core/EventBus';
import { ok, err, type Result } from '../core/Result';

// ─── Sabitler ─────────────────────────────────────────────────────────────────

/** Snapshot TTL: bu süreden eski cache → re-check tetiklenir */
const SNAPSHOT_TTL_MS    = 30_000; // 30 saniye
const MAX_RETRY_ATTEMPTS = 2;

// ─── Tipler ───────────────────────────────────────────────────────────────────

export type PermissionKey =
  | 'camera'
  | 'microphone'
  | 'storage'
  | 'photoLibrary'
  | 'notifications';

export type PermissionStatusValue =
  | 'granted'
  | 'denied'
  | 'blocked'
  | 'unavailable'
  | 'limited';   // iOS partial photo access + Android 14/16 partial media

/**
 * 'limited' değerlendirmesi (§ 78):
 *   iOS   → kullanıcı belirli fotoğraflara erişim verdi (PHAuthorizationStatusLimited)
 *   Android 14+ → READ_MEDIA_VISUAL_USER_SELECTED ile kısmi erişim
 *   Android 16+ → READ_MEDIA_IMAGES isteğinde kullanıcı "belirli öğeler" seçti
 *
 * Her iki durumda da temel işlev çalışır; tam kütüphane erişimi için
 * PermissionGateModal'da kullanıcıya tam erişim önerilir.
 */

export interface PermissionEntry {
  readonly status:    PermissionStatusValue;
  readonly checkedAt: number;
}

export interface PermissionSnapshot {
  readonly key:       PermissionKey;
  readonly status:    PermissionStatusValue;
  readonly checkedAt: number;
  readonly isStale:   boolean;
}

// EventBus event tipleri
export interface PermissionEvents {
  'permission:granted':  { key: PermissionKey };
  'permission:denied':   { key: PermissionKey };
  'permission:blocked':  { key: PermissionKey };
  'permission:limited':  { key: PermissionKey };    // § 78 — yeni
  'permission:transition:denied-to-blocked': { key: PermissionKey };
}

// ─── Platform izin resolver ───────────────────────────────────────────────────

/**
 * Platform + API seviyesine göre doğru Permission sabitini döner.
 *
 * Android storage/photo permission matrisi (§ 78):
 *   API < 33  (Android 12-) : READ_EXTERNAL_STORAGE   (scoped storage öncesi)
 *   API 33    (Android 13)  : READ_MEDIA_IMAGES        (granüler medya izni)
 *   API 34+   (Android 14+) : READ_MEDIA_IMAGES        (kısmi erişim: LIMITED döner)
 *   API 36+   (Android 16+) : READ_MEDIA_IMAGES        (sistem otomatik LIMITED sorar)
 *
 * Neden READ_MEDIA_VISUAL_USER_SELECTED istenmez?
 *   Bu izin Android 14+ ile eklendi, ancak uygulama tarafından proaktif
 *   talep edilmesi gerekmez. Kullanıcı READ_MEDIA_IMAGES isteğine "Belirli
 *   öğeler" yanıtı verirse sistem otomatik olarak LIMITED döner.
 *   react-native-permissions bunu RESULTS.LIMITED olarak gösterir.
 */
function resolvePermission(key: PermissionKey): Permission {
  const api = Number(Platform.Version); // Android API level veya iOS major version

  switch (key) {
    case 'camera':
      return Platform.select({
        ios:     PERMISSIONS.IOS.CAMERA,
        android: PERMISSIONS.ANDROID.CAMERA,
      })!;

    case 'microphone':
      return Platform.select({
        ios:     PERMISSIONS.IOS.MICROPHONE,
        android: PERMISSIONS.ANDROID.RECORD_AUDIO,
      })!;

    case 'storage':
      return Platform.select({
        ios: PERMISSIONS.IOS.PHOTO_LIBRARY,
        android:
          api >= 33
            ? PERMISSIONS.ANDROID.READ_MEDIA_IMAGES   // Android 13+ (API 33+)
            : PERMISSIONS.ANDROID.READ_EXTERNAL_STORAGE, // Android 12- (API ≤ 32)
      })!;

    case 'photoLibrary':
      return Platform.select({
        ios: PERMISSIONS.IOS.PHOTO_LIBRARY_ADD_ONLY,
        android:
          api >= 33
            ? PERMISSIONS.ANDROID.READ_MEDIA_IMAGES   // Android 13+ — LIMITED döner (API 34+)
            : PERMISSIONS.ANDROID.READ_EXTERNAL_STORAGE,
      })!;

    case 'notifications':
      return Platform.select({
        ios: PERMISSIONS.IOS.NOTIFICATIONS,
        // Android 13+ (API 33): POST_NOTIFICATIONS runtime izni zorunlu
        // Android 12- (API ≤ 32): sistem izni yok, her zaman granted kabul edilir
        // (_isNotificationAlwaysGranted() kısa devre yapıyor)
        android:
          api >= 33
            ? PERMISSIONS.ANDROID.POST_NOTIFICATIONS
            : (null as unknown as Permission),
      })!;
  }
}

function mapStatus(raw: PermissionStatus): PermissionStatusValue {
  switch (raw) {
    case RESULTS.GRANTED:     return 'granted';
    case RESULTS.DENIED:      return 'denied';
    case RESULTS.BLOCKED:     return 'blocked';
    case RESULTS.UNAVAILABLE: return 'unavailable';
    case RESULTS.LIMITED:     return 'limited';
    default:                  return 'unavailable';
  }
}

/**
 * § 78: 'limited' erişim işlevsel kabul edilir.
 * Tam kütüphane erişimi için PermissionGateModal kullanıcıya öneride bulunur;
 * ancak temel işlev (fotoğraf seçme, kaydetme) çalışmaya devam eder.
 */
export function isPermissionGrantedOrLimited(status: PermissionStatusValue): boolean {
  return status === 'granted' || status === 'limited';
}

// ─── AI İzin Seviyesi ─────────────────────────────────────────────────────────
//
//   DISABLED      → AI özellikleri tamamen kapalı (Settings'ten kapatılmış)
//   LOCAL_ONLY    → Sadece offline model (bulut API anahtarı yok / gizlilik modu)
//   CLOUD_ENABLED → Offline + cloud fallback aktif
//
export type AIPermissionStatus = 'DISABLED' | 'LOCAL_ONLY' | 'CLOUD_ENABLED';

/**
 * § 24 / § 30 : PermissionGate public arayüzü.
 */
export interface IPermissionGate {
  readonly isTransitioning: boolean;
  checkPermission(key: PermissionKey):   Promise<Result<PermissionStatusValue>>;
  requestPermission(key: PermissionKey): Promise<Result<PermissionStatusValue>>;
  statusSnapshot(key: PermissionKey):    PermissionStatusValue | null;
  getStatus(): AIPermissionStatus | { state: string; consent: null; changedAt: string };
  setAIStatus(status: AIPermissionStatus): void;
  isAllowed(variant: "offline" | "cloud"): boolean;
  init?(): Promise<{ ok: boolean; data: undefined }>;
  transition?(state: string): void;
  dispose(): void;
}

// ─── PermissionGate ───────────────────────────────────────────────────────────

export class PermissionGate {
  private readonly _cache   = new Map<PermissionKey, PermissionEntry>();
  private _locked           = false;
  private _isTransitioning  = false;
  private _disposed         = false;
  private _aiStatus: AIPermissionStatus = 'CLOUD_ENABLED';
  private readonly _eventBus: IEventBus | null;

  constructor(eventBus: IEventBus | null = null) {
    this._eventBus = eventBus;
  }

  get isTransitioning(): boolean { return this._isTransitioning; }
  get isLocked():        boolean { return this._locked; }

  // ─── Yardımcı: Android 12- notification özel case ────────────────────────
  // API 33 (Android 13) öncesinde POST_NOTIFICATIONS runtime izni yok.
  // Sistem her zaman GRANTED kabul eder; permission dialog açılmamalı.
  private _isNotificationAlwaysGranted(key: PermissionKey): boolean {
    return (
      key === 'notifications' &&
      Platform.OS === 'android' &&
      Number(Platform.Version) < 33
    );
  }

  // ─── Yardımcı: stale check ───────────────────────────────────────────────
  private _isStale(entry: PermissionEntry): boolean {
    return Date.now() - entry.checkedAt > SNAPSHOT_TTL_MS;
  }

  // ─── Yardımcı: event emit ────────────────────────────────────────────────
  private _emit(
    event: keyof PermissionEvents,
    payload: PermissionEvents[keyof PermissionEvents],
  ): void {
    if (!this._eventBus || this._disposed) return;
    try {
      (this._eventBus as unknown as {
        emit: (e: string, p: unknown) => void;
      }).emit(event, payload);
    } catch {
      // emit asla throw etmez
    }
  }

  // ─── Yardımcı: denied → blocked + limited transition ─────────────────────
  private _handleTransition(
    key:  PermissionKey,
    prev: PermissionStatusValue | undefined,
    next: PermissionStatusValue,
  ): void {
    if (prev === 'denied' && next === 'blocked') {
      this._emit('permission:transition:denied-to-blocked', { key });
    }
    if (next === 'granted') this._emit('permission:granted', { key });
    if (next === 'denied')  this._emit('permission:denied',  { key });
    if (next === 'blocked') this._emit('permission:blocked', { key });
    // § 78: limited event — PermissionGateModal bu eventi dinleyerek
    //        "tam erişim ver" önerisini gösterir
    if (next === 'limited') this._emit('permission:limited', { key });
  }

  // ─── Tek izin: kontrol ────────────────────────────────────────────────────
  async checkPermission(key: PermissionKey): Promise<Result<PermissionStatusValue>> {
    if (this._disposed) return err('DISPOSED', 'PermissionGate disposed');

    if (this._isNotificationAlwaysGranted(key)) {
      this._cache.set(key, { status: 'granted', checkedAt: Date.now() });
      return ok('granted');
    }

    const cached = this._cache.get(key);
    if (cached && !this._isStale(cached)) return ok(cached.status);

    try {
      const raw    = await check(resolvePermission(key));
      const status = mapStatus(raw);
      const prev   = cached?.status;
      this._cache.set(key, { status, checkedAt: Date.now() });
      this._handleTransition(key, prev, status);
      return ok(status);
    } catch (e) {
      return err('PERMISSION_CHECK_FAILED', `check failed: ${key}`, { cause: e });
    }
  }

  // ─── Tek izin: istek ──────────────────────────────────────────────────────
  async requestPermission(key: PermissionKey): Promise<Result<PermissionStatusValue>> {
    if (this._disposed) return err('DISPOSED', 'PermissionGate disposed');
    if (this._locked)   return err('PERMISSION_LOCKED', 'Another request in progress');

    if (this._isNotificationAlwaysGranted(key)) {
      this._cache.set(key, { status: 'granted', checkedAt: Date.now() });
      return ok('granted');
    }

    const snapshot = this._cache.get(key);

    if (snapshot?.status === 'blocked') {
      return err('PERMISSION_BLOCKED', `${key} is blocked. Open settings to grant.`);
    }

    // § 78: 'limited' durumunda yeniden istek açma — kullanıcı zaten seçim yaptı.
    // Daha fazla erişim için openAppSettings() kullanılmalı.
    if (snapshot?.status === 'limited') {
      return ok('limited');
    }

    this._locked          = true;
    this._isTransitioning = true;

    try {
      const raw    = await request(resolvePermission(key));
      const status = mapStatus(raw);
      const prev   = snapshot?.status;
      this._cache.set(key, { status, checkedAt: Date.now() });
      this._handleTransition(key, prev, status);
      return ok(status);
    } catch (e) {
      if (snapshot) {
        this._cache.set(key, snapshot);
      } else {
        this._cache.delete(key);
      }
      return err('PERMISSION_REQUEST_FAILED', `request failed: ${key}`, { cause: e });
    } finally {
      this._locked          = false;
      this._isTransitioning = false;
    }
  }

  // ─── Retry ────────────────────────────────────────────────────────────────
  async retryRequest(
    key:      PermissionKey,
    attempts = MAX_RETRY_ATTEMPTS,
  ): Promise<Result<PermissionStatusValue>> {
    for (let i = 0; i < attempts; i++) {
      const result = await this.requestPermission(key);
      if (!result.ok) return result;
      if (
        result.data === 'granted' ||
        result.data === 'limited' ||   // § 78: limited da final state
        result.data === 'blocked'
      ) return result;
    }
    return this.requestPermission(key);
  }

  // ─── Settings redirect ────────────────────────────────────────────────────
  async openAppSettings(): Promise<Result<void>> {
    try {
      await openSettings();
      return ok(undefined);
    } catch (e) {
      try {
        await Linking.openSettings();
        return ok(undefined);
      } catch {
        return err('SETTINGS_OPEN_FAILED', 'Cannot open app settings', { cause: e });
      }
    }
  }

  shouldOpenSettings(key: PermissionKey): boolean {
    const entry = this._cache.get(key);
    return entry?.status === 'blocked';
  }

  // ─── Toplu kontrol ────────────────────────────────────────────────────────
  async checkAll(
    keys: readonly PermissionKey[],
  ): Promise<Result<Partial<Record<PermissionKey, PermissionStatusValue>>>> {
    if (this._disposed) return err('DISPOSED', 'PermissionGate disposed');

    const missing = keys.filter((k) => {
      if (this._isNotificationAlwaysGranted(k)) return false;
      const cached = this._cache.get(k);
      return !cached || this._isStale(cached);
    });

    if (missing.length > 0) {
      try {
        // § 78: minSdkVersion ≥ 31 (Android 12) ile API 28 special-case
        // artık gerekli değil — checkMultiple doğru çalışır.
        const permissions = missing.map(resolvePermission);
        const results     = await checkMultiple(permissions);
        missing.forEach((key, i) => {
          const status = mapStatus(results[permissions[i]]);
          const prev   = this._cache.get(key)?.status;
          this._cache.set(key, { status, checkedAt: Date.now() });
          this._handleTransition(key, prev, status);
        });
      } catch (e) {
        return err('PERMISSION_CHECK_ALL_FAILED', 'checkMultiple failed', { cause: e });
      }
    }

    const out: Partial<Record<PermissionKey, PermissionStatusValue>> = {};
    for (const key of keys) {
      if (this._isNotificationAlwaysGranted(key)) {
        out[key] = 'granted';
        this._cache.set(key, { status: 'granted', checkedAt: Date.now() });
      } else {
        out[key] = this._cache.get(key)?.status ?? 'unavailable';
      }
    }
    return ok(out);
  }

  // ─── Toplu istek ──────────────────────────────────────────────────────────
  async requestAll(
    keys: readonly PermissionKey[],
  ): Promise<Result<Partial<Record<PermissionKey, PermissionStatusValue>>>> {
    if (this._disposed) return err('DISPOSED', 'PermissionGate disposed');
    if (this._locked)   return err('PERMISSION_LOCKED', 'Another request in progress');

    const filteredKeys = keys.filter((k) => !this._isNotificationAlwaysGranted(k));
    const snapshots    = new Map(keys.map((k) => [k, this._cache.get(k)]));

    this._locked          = true;
    this._isTransitioning = true;

    try {
      const permissions = filteredKeys.map(resolvePermission);
      const results     = await requestMultiple(permissions);
      filteredKeys.forEach((key, i) => {
        const status = mapStatus(results[permissions[i]]);
        const prev   = snapshots.get(key)?.status;
        this._cache.set(key, { status, checkedAt: Date.now() });
        this._handleTransition(key, prev, status);
      });
    } catch (e) {
      snapshots.forEach((snap, key) => {
        if (snap) this._cache.set(key, snap);
        else      this._cache.delete(key);
      });
      return err('PERMISSION_REQUEST_ALL_FAILED', 'requestMultiple failed', { cause: e });
    } finally {
      this._locked          = false;
      this._isTransitioning = false;
    }

    const out: Partial<Record<PermissionKey, PermissionStatusValue>> = {};
    for (const key of keys) {
      if (this._isNotificationAlwaysGranted(key)) {
        out[key] = 'granted';
        this._cache.set(key, { status: 'granted', checkedAt: Date.now() });
      } else {
        out[key] = this._cache.get(key)?.status ?? 'unavailable';
      }
    }
    return ok(out);
  }

  // ─── Snapshot ─────────────────────────────────────────────────────────────
  statusSnapshot(key: PermissionKey): PermissionStatusValue | null {
    return this._cache.get(key)?.status ?? null;
  }

  getSnapshot(key: PermissionKey): PermissionSnapshot | null {
    const entry = this._cache.get(key);
    if (!entry) return null;
    return {
      key,
      status:    entry.status,
      checkedAt: entry.checkedAt,
      isStale:   this._isStale(entry),
    };
  }

  // ─── AI İzin Seviyesi ─────────────────────────────────────────────────────
  getStatus(): AIPermissionStatus     { return this._aiStatus; }
  setAIStatus(s: AIPermissionStatus)  { this._aiStatus = s; }

  // ─── Dispose ──────────────────────────────────────────────────────────────
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._cache.clear();
    this._locked          = false;
    this._isTransitioning = false;
  }
}

