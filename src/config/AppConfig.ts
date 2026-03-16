/**
 * config/AppConfig.ts — Uygulama konfigürasyonu
 *
 * Phase 11: MANIFEST_URL env değişkeni + prod/staging ayrımı.
 *
 * Expo config plugin ile app.config.ts'den inject edilir:
 *   extra: {
 *     manifestUrl: process.env.MANIFEST_URL ?? DEFAULT_MANIFEST_URL_STAGING,
 *     environment: process.env.APP_ENV ?? "staging",
 *   }
 *
 * Constants.expoConfig.extra üzerinden okunur.
 *
 * § 4  : AppContainer DI — AppConfig singleton
 */

import Constants from "expo-constants";

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const DEFAULT_MANIFEST_URL_PROD    = "https://cdn.example.com/models/manifest.json";
const DEFAULT_MANIFEST_URL_STAGING = "https://cdn-staging.example.com/models/manifest.json";

export type AppEnvironment = "production" | "staging" | "development";

// ─── AppConfig ────────────────────────────────────────────────────────────────

export interface IAppConfig {
  environment:  AppEnvironment;
  manifestUrl:  string;
  /** OTA güncelleme aralığı (ms). 0 = devre dışı */
  updateCheckIntervalMs: number;
  /** § 36: Arka plan model indirme (expo-background-fetch). Default: true */
  enableBackgroundDownload: boolean;
  /**
   * § 65 — file:saved event'inde terminali otomatik çalıştır.
   * TerminalScreen bunu dinler; Settings ekranında toggle edilir.
   * Default: false
   */
  autoRun: boolean;
}

function resolveEnvironment(): AppEnvironment {
  const env = (Constants.expoConfig?.extra?.environment as string | undefined)
    ?? process.env["APP_ENV"]
    ?? "staging";

  if (env === "production") return "production";
  if (env === "development") return "development";
  return "staging";
}

function resolveManifestUrl(environment: AppEnvironment): string {
  // Önce Expo extra'dan oku (EAS Build'de set edilir)
  const fromExtra = Constants.expoConfig?.extra?.manifestUrl as string | undefined;
  if (fromExtra) return fromExtra;

  // Sonra env değişkeni (yerel geliştirme)
  const fromEnv = process.env["MANIFEST_URL"];
  if (fromEnv) return fromEnv;

  // Varsayılan: ortama göre
  return environment === "production"
    ? DEFAULT_MANIFEST_URL_PROD
    : DEFAULT_MANIFEST_URL_STAGING;
}

/**
 * Singleton AppConfig — AppContainer'da bir kez oluşturulur.
 *
 * Kullanım:
 *   const config = createAppConfig();
 *   config.manifestUrl   // → "https://cdn.example.com/..."
 *   config.environment   // → "production"
 */
export function createAppConfig(): IAppConfig {
  const environment = resolveEnvironment();
  const manifestUrl = resolveManifestUrl(environment);

  return {
    environment,
    manifestUrl,
    updateCheckIntervalMs:    environment === "development" ? 0 : 6 * 60 * 60 * 1000, // 6 saat
    enableBackgroundDownload: environment !== "development",
    autoRun:                  false, // § 65 — default kapalı, Settings ile açılır
  };
}
