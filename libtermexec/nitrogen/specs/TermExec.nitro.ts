/**
 * @file     TermExec.nitro.ts
 * @module   libtermexec/nitrogen/specs
 * @version  1.0.0
 *
 * @description
 *   Nitro Module spec — libtermexec HybridObject arayüzü.
 *
 *   Bu dosya `nitrogen` CLI tarafından okunur ve platform-spesifik
 *   HybridObject skeleton'larını (Kotlin + Swift) üretir.
 *
 *   Tasarım kararları:
 *   • Her session bağımsız bir PTY sürecine karşılık gelir.
 *   • Callback'ler null-able — Nitro'nun olay modeline uygun.
 *   • resize() SIGWINCH gönderir; terminal emülatör (RN tarafı) yanıt alır.
 *   • data string olarak gelir (UTF-8); ANSI escape dahil ham çıktı.
 *
 *   Android → Kotlin  (openpty + ProcessBuilder + JNI okuma döngüsü)
 *   iOS     → Swift   (wasm3 + WASI stdio bridge — Phase 2)
 */

import type { HybridObject } from 'react-native-nitro-modules';

// ─── Session config ───────────────────────────────────────────────────────────

export interface SessionConfig {
  /** Çalıştırılacak shell/binary yolu. Android default: /system/bin/sh */
  shellPath: string;
  /** Shell argümanları. Örn: ["-l"] */
  args:      string[];
  /** Ortam değişkenleri. PATH, HOME, TERM dahil edilmeli. */
  env:       Record<string, string>;
  /** Çalışma dizini. */
  cwd:       string;
  /** Başlangıç terminal genişliği (kolon sayısı). */
  cols:      number;
  /** Başlangıç terminal yüksekliği (satır sayısı). */
  rows:      number;
}

// ─── HybridObject interface ───────────────────────────────────────────────────

export interface TermExec extends HybridObject<{ android: 'kotlin'; ios: 'swift' }> {

  // ── Session lifecycle ──────────────────────────────────────────────────────

  /**
   * Yeni PTY session açar.
   * @returns sessionId — UUID string, diğer metodlara referans.
   * @throws  SESSION_LIMIT_REACHED | SHELL_NOT_FOUND | PTY_OPEN_FAILED
   */
  createSession(config: SessionConfig): string;

  /**
   * Kullanıcı girdisini PTY master fd'ye yazar (stdin).
   * "\r" → Enter, "\x03" → Ctrl-C, "\x04" → Ctrl-D
   */
  writeInput(sessionId: string, data: string): void;

  /**
   * Terminal boyutunu günceller → SIGWINCH gönderir.
   * Ekran döndürme / split-pane resize'da çağrılmalı.
   */
  resizeTerminal(sessionId: string, cols: number, rows: number): void;

  /**
   * Session'ı sonlandırır.
   * @param signal POSIX signal numarası. Default: 9 (SIGKILL)
   */
  killSession(sessionId: string, signal: number): void;

  /**
   * Session'ı temiz kapatır — önce SIGTERM, 500ms sonra SIGKILL.
   */
  closeSession(sessionId: string): void;

  /**
   * Aktif session ID'lerini döner.
   */
  listSessions(): string[];

  // ── Event callbacks ────────────────────────────────────────────────────────

  /**
   * PTY'den gelen ham veri (stdout + stderr birleşik, ANSI dahil).
   * Çok sık tetiklenebilir — RN thread'de batching önerilir.
   */
  onSessionData:  ((sessionId: string, data: string) => void) | null;

  /**
   * Session sonlandığında — exit code ile.
   * exitCode === null → sinyal ile öldürüldü.
   */
  onSessionExit:  ((sessionId: string, exitCode: number) => void) | null;

  /**
   * Native katman hatası — PTY okuma hatası, fork başarısız vb.
   */
  onSessionError: ((sessionId: string, error: string) => void) | null;
}
