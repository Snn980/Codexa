/**
 * monitoring/SentryService.ts
 *
 * § 32 (T-P15-4) — Sentry entegrasyonu.
 *
 * Kapsam: crash + JS error boundary + unhandled promise + breadcrumb + user context.
 * @sentry/react-native opsiyonel import — paket yoksa tüm metodlar no-op.
 * Bu sayede geliştirme ortamında Sentry kurulu olmadan da proje çalışır.
 *
 * Entegrasyon noktaları:
 *   1. App.tsx — SentryService.init() (boot sırasında)
 *   2. NavigationErrorBoundary — onError prop → SentryService.captureError()
 *   3. AppErrorBoundary — aynı
 *   4. AppContainer — unhandledRejection listener
 *   5. useAIOrchestrator — escalation / low_quality event breadcrumb
 *
 * Tasarım kararları:
 *   • DSN ortam değişkeninden gelir (EAS Secret / .env): SENTRY_DSN
 *   • development ortamında tracesSampleRate: 1.0, production'da 0.2
 *   • PII: user.id olarak rastgele anon ID kullanılır, email/name gönderilmez
 *   • Breadcrumb kategorileri: 'navigation' | 'ai' | 'storage' | 'network'
 *
 * § 1  : SentryService metodları throw etmez (monitoring kritik path değil)
 */

import Constants from 'expo-constants';

// ─── Sentry tip tanımları (opsiyonel import için) ─────────────────────────────

interface SentrySDK {
  init(options: Record<string, unknown>): void;
  captureException(error: unknown, hint?: Record<string, unknown>): string;
  captureMessage(message: string, level?: string): string;
  setUser(user: { id: string } | null): void;
  addBreadcrumb(crumb: {
    category:  string;
    message:   string;
    level?:    string;
    data?:     Record<string, unknown>;
  }): void;
  withScope(callback: (scope: { setTag: (k: string, v: string) => void }) => void): void;
  nativeCrash?(): void;
}

// ─── Sabitler ─────────────────────────────────────────────────────────────────

const DEFAULT_TRACES_SAMPLE_RATE = {
  development: 1.0,
  staging:     0.5,
  production:  0.2,
};

// ─── SentryService ────────────────────────────────────────────────────────────

export class SentryService {

  private _sdk:         SentrySDK | null  = null;
  private _initialized = false;
  private _anonId:      string            = this._generateAnonId();

  // ─── init ─────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this._initialized) return;

    const dsn = this._resolveDSN();
    if (!dsn) {
      if (__DEV__) console.log('[SentryService] No DSN configured — monitoring disabled.');
      return;
    }

    try {
      const Sentry = await import('@sentry/react-native');
      this._sdk    = Sentry as unknown as SentrySDK;

      const environment = this._resolveEnvironment();
      const tracesSampleRate = DEFAULT_TRACES_SAMPLE_RATE[environment] ?? 0.2;

      this._sdk.init({
        dsn,
        environment,
        tracesSampleRate,
        // Performans: navigation transaction'larını yakala
        enableTracing: true,
        // PII: stack trace'lerde kaynak kodu gönderme (production)
        attachStacktrace: environment !== 'production',
        // Unhandled promise rejection
        enableCaptureFailedRequests: true,
        // Expo release channel
        release: Constants.expoConfig?.version ?? 'unknown',
        dist:    Constants.expoConfig?.runtimeVersion?.toString() ?? undefined,
      });

      // Anonim kullanıcı — PII yok
      this._sdk.setUser({ id: this._anonId });

      this._initialized = true;

      if (__DEV__) console.log('[SentryService] Initialized:', { environment, tracesSampleRate });

    } catch (e) {
      // Paket yok veya init başarısız — no-op, uygulama çalışmaya devam eder
      if (__DEV__) console.warn('[SentryService] init failed:', e);
    }
  }

  // ─── captureError ─────────────────────────────────────────────────────────

  captureError(
    error:   unknown,
    context: Record<string, unknown> = {},
  ): void {
    if (!this._sdk) return;
    try {
      this._sdk.captureException(error, { extra: context });
    } catch { /* monitoring never throws */ }
  }

  // ─── captureMessage ───────────────────────────────────────────────────────

  captureMessage(
    message: string,
    level:   'debug' | 'info' | 'warning' | 'error' = 'info',
    data:    Record<string, unknown> = {},
  ): void {
    if (!this._sdk) return;
    try {
      this._sdk.withScope(scope => {
        scope.setTag('level', level);
        Object.entries(data).forEach(([k, v]) => scope.setTag(k, String(v)));
        this._sdk!.captureMessage(message, level);
      });
    } catch { /* no-op */ }
  }

  // ─── addBreadcrumb ────────────────────────────────────────────────────────

  addBreadcrumb(
    category: 'navigation' | 'ai' | 'storage' | 'network' | 'lifecycle',
    message:  string,
    data:     Record<string, unknown> = {},
    level:    'debug' | 'info' | 'warning' | 'error' = 'info',
  ): void {
    if (!this._sdk) return;
    try {
      this._sdk.addBreadcrumb({ category, message, level, data });
    } catch { /* no-op */ }
  }

  // ─── Navigation error (NavigationErrorBoundary hook) ─────────────────────

  /**
   * NavigationErrorBoundary.onError'dan çağrılır.
   * § 32: nav:error event ile birlikte çalışır.
   */
  captureNavError(error: Error, info: React.ErrorInfo): void {
    if (!this._sdk) return;
    try {
      this._sdk.captureException(error, {
        extra: {
          componentStack: info.componentStack,
          boundary:       'NavigationErrorBoundary',
        },
      });
      this.addBreadcrumb('navigation', `Nav error: ${error.message}`, {}, 'error');
    } catch { /* no-op */ }
  }

  // ─── AI events ────────────────────────────────────────────────────────────

  /**
   * useAIOrchestrator onEvent callback'inden çağrılır.
   */
  captureAIEvent(
    event:  'escalated' | 'low_quality' | 'timeout',
    detail: Record<string, unknown>,
  ): void {
    this.addBreadcrumb('ai', `AI event: ${event}`, detail, 'info');

    // low_quality ve timeout warning olarak ilet
    if (event !== 'escalated') {
      this.captureMessage(`AI ${event}`, 'warning', detail);
    }
  }

  // ─── Unhandled rejection ──────────────────────────────────────────────────

  /**
   * AppContainer init'te çağrılır — global unhandled rejection yakalar.
   * RN'de `global.ErrorUtils` üzerinden çalışır.
   */
  setupUnhandledRejection(): void {
    if (!this._sdk) return;
    try {
      const originalHandler = (global as Record<string, unknown>).onunhandledrejection as
        ((e: PromiseRejectionEvent) => void) | undefined;

      (global as Record<string, unknown>).onunhandledrejection = (e: PromiseRejectionEvent) => {
        this.captureError(e.reason, { type: 'unhandledRejection' });
        originalHandler?.(e);
      };
    } catch { /* no-op */ }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private _resolveDSN(): string | null {
    // EAS Secret veya .env üzerinden
    const dsn =
      (Constants.expoConfig?.extra?.sentryDsn as string | undefined) ??
      process.env['SENTRY_DSN'] ??
      null;
    return dsn && dsn.startsWith('https://') ? dsn : null;
  }

  private _resolveEnvironment(): 'development' | 'staging' | 'production' {
    const env = (Constants.expoConfig?.extra?.environment as string | undefined) ??
      process.env['APP_ENV'] ?? 'staging';
    if (env === 'production') return 'production';
    if (env === 'development') return 'development';
    return 'staging';
  }

  private _generateAnonId(): string {
    // Rastgele 8 hex — PII yok, session izleme için yeterli
    return Array.from({ length: 8 }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join('');
  }
}

// Module-level singleton
export const sentryService = new SentryService();

// React import (captureNavError parametresi için)
import type React from 'react';
