/**
 * @file     SettingsRepository.ts
 * @module   storage/repositories
 * @version  1.0.0
 * @since    Phase 1 — Foundation
 *
 * @description
 *   ISettings key-value store implementasyonu.
 *   Migration 4'te oluşturulan `settings` tablosu üzerinde çalışır.
 *   Her ayar TEXT olarak saklanır; okuma sırasında tip dönüşümü yapılır.
 *
 * Tasarım kararları:
 *   • get()   → her zaman eksiksiz ISettings döner;
 *               DB'de eksik key varsa DEFAULT_SETTINGS'den tamamlanır
 *   • set()   → partial update; yalnızca gönderilen alanlar UPSERT edilir
 *   • reset() → tüm alanları DEFAULT_SETTINGS'e sıfırlar
 *   • Optimistic lock YOK — settings tek kullanıcı, race condition beklentisi yok
 *   • Seri/deserializasyon:
 *       number  → parseFloat (NaN ise DEFAULT_SETTINGS'den fallback)
 *       boolean → value === "true"
 *       enum    → module-level Set.has(), geçersizse DEFAULT_SETTINGS fallback
 */

import type { AsyncResult, ISettings } from "../../types/core";

import {
  DEFAULT_SETTINGS,
  EditorTheme,
  ErrorCode,
  KeyboardLayout,
} from "../../types/core";

import type { IDatabaseDriver } from "../Database";
import { ok, tryResultAsync } from "../../utils/result";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Module-Level Enum Cache
// ─────────────────────────────────────────────────────────────────────────────

/** Modül yüklenirken bir kez oluşturulur — enum doğrulama O(1). */
const VALID_THEMES          = new Set<string>(Object.values(EditorTheme));
const VALID_KEYBOARD_LAYOUTS = new Set<string>(Object.values(KeyboardLayout));

// ─────────────────────────────────────────────────────────────────────────────
// § 2. Tip Tanımları
// ─────────────────────────────────────────────────────────────────────────────

/** SQLite ham satırı — yalnızca bu modülde kullanılır. */
interface SettingsRow {
  readonly key:   string;
  readonly value: string;
}

type SettingsKey = keyof ISettings;

// ─────────────────────────────────────────────────────────────────────────────
// § 3. SQL Sabitleri
// ─────────────────────────────────────────────────────────────────────────────

const SQL = Object.freeze({
  SELECT_ALL: `
    SELECT key, value FROM settings
  `,
  UPSERT: `
    INSERT INTO settings(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `,
} as const);

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Seri/Deserializasyon
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ham string değerini ISettings[K] tipine dönüştürür.
 * Bilinmeyen veya geçersiz değerlerde DEFAULT_SETTINGS'e düşer.
 */
function deserializeValue<K extends SettingsKey>(key: K, raw: string): ISettings[K] {
  switch (key) {
    // ── Sayılar ────────────────────────────────────────────────
    case "fontSize":
    case "lineHeight":
    case "tabSize":
    case "autoSaveInterval":
    case "maxTabs": {
      const n = parseFloat(raw);
      return (Number.isFinite(n) ? n : DEFAULT_SETTINGS[key]) as ISettings[K];
    }

    // ── Boolean'lar ─────────────────────────────────────────────
    case "insertSpaces":
    case "wordWrap":
    case "showLineNumbers":
    case "showMinimap":
    case "autoRun":          // § 68
      return (raw === "true") as unknown as ISettings[K];

    // ── Enum: EditorTheme ───────────────────────────────────────
    case "theme":
      return (VALID_THEMES.has(raw)
        ? raw
        : DEFAULT_SETTINGS.theme) as ISettings[K];

    // ── Enum: KeyboardLayout ────────────────────────────────────
    case "keyboardLayout":
      return (VALID_KEYBOARD_LAYOUTS.has(raw)
        ? raw
        : DEFAULT_SETTINGS.keyboardLayout) as ISettings[K];

    default:
      return DEFAULT_SETTINGS[key];
  }
}

/**
 * ISettings değerini DB'ye yazılacak string'e dönüştürür.
 * Boolean ve number'lar String() ile; enum'lar zaten string.
 */
function serializeValue(
  _key: SettingsKey,
  value: ISettings[SettingsKey],
): string {
  return String(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. Hydration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DB satırlarından tam ISettings nesnesi oluşturur.
 * DB'de bulunmayan her key DEFAULT_SETTINGS'den tamamlanır.
 */
function hydrateSettings(rows: readonly SettingsRow[]): ISettings {
  const map  = new Map(rows.map((r) => [r.key, r.value]));
  const keys = Object.keys(DEFAULT_SETTINGS) as SettingsKey[];

  const result = {} as Record<SettingsKey, unknown>;

  for (const key of keys) {
    const raw = map.get(key);
    result[key] = raw !== undefined
      ? deserializeValue(key, raw)
      : DEFAULT_SETTINGS[key];
  }

  return Object.freeze(result as ISettings);
}

// ─────────────────────────────────────────────────────────────────────────────
// § 6. Kontrat
// ─────────────────────────────────────────────────────────────────────────────

export interface ISettingsRepository {
  /** Tüm ayarları okur; eksik key'ler DEFAULT_SETTINGS ile tamamlanır. */
  get(): AsyncResult<ISettings>;

  /**
   * Partial update — yalnızca gönderilen alanlar güncellenir.
   * Güncelleme sonrası güncel ISettings döner.
   */
  set(partial: Partial<ISettings>): AsyncResult<ISettings>;

  /** Tüm ayarları DEFAULT_SETTINGS'e sıfırlar. */
  reset(): AsyncResult<ISettings>;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 7. SettingsRepository
// ─────────────────────────────────────────────────────────────────────────────

export class SettingsRepository implements ISettingsRepository {
  constructor(private readonly driver: IDatabaseDriver) {}

  // ── Okuma ─────────────────────────────────────────────────────

  async get(): AsyncResult<ISettings> {
    const result = await tryResultAsync(
      () => this.driver.query<SettingsRow>(SQL.SELECT_ALL, []),
      ErrorCode.DB_QUERY_FAILED,
      "Ayarlar okunamadı",
    );

    if (!result.ok) return result;
    return ok(hydrateSettings(result.data.rows));
  }

  // ── Yazma ─────────────────────────────────────────────────────

  /**
   * Yalnızca değişen alanları UPSERT eder.
   * Boş partial gönderilirse DB'ye dokunmadan mevcut ayarları döner.
   *
   * @example
   *   await settingsRepo.set({ fontSize: 16, theme: EditorTheme.Light });
   */
  async set(partial: Partial<ISettings>): AsyncResult<ISettings> {
    const entries = Object.entries(partial) as [SettingsKey, ISettings[SettingsKey]][];

    for (const [key, value] of entries) {
      if (value === undefined) continue;

      const upsertResult = await tryResultAsync(
        () => this.driver.execute(SQL.UPSERT, [key, serializeValue(key, value)]),
        ErrorCode.DB_QUERY_FAILED,
        `Ayar kaydedilemedi: key="${key}"`,
        { key },
      );

      if (!upsertResult.ok) return upsertResult;
    }

    return this.get();
  }

  /**
   * Tüm ayarları DEFAULT_SETTINGS'e sıfırlar.
   * Migration 4'teki INSERT OR IGNORE değerlerini tekrar yazar.
   *
   * @example
   *   await settingsRepo.reset();
   */
  async reset(): AsyncResult<ISettings> {
    return this.set({ ...DEFAULT_SETTINGS });
  }
}
