/**
 * security/APIKeyStore.ts — API anahtarı güvenli depolama
 *
 * § 1  : Result<T>
 *
 * DÜZELTME — Web Security (sessionStorage / memory):
 *   ❗ Önceki impl web'de `InMemorySecureStore` kullandı — sayfa yenilenince
 *      anahtar kaybolur, kullanıcı her seferinde yeniden girmek zorunda.
 *      Öte yandan localStorage kalıcı ama XSS vektörüne açık.
 *
 *   YENİ: `WebSecureStore` — session lifetime scoped:
 *     1. Anahtar AES-GCM (SubtleCrypto) ile şifrelenir.
 *     2. Şifreli blob → sessionStorage (tab kapatınca gider — session scoped ✅)
 *     3. AES anahtarı → sessionStorage'a KONULMAZ; sadece memory'de tutulur.
 *        → XSS sessionStorage'ı okusa bile encrypted blob'u çözemez.
 *     4. Sayfa yenilenince AES key kaybolur → sessionStorage blob işe yaramaz
 *        → kullanıcı tekrar girer. Tab ömrü boyunca çalışır.
 *
 *   Güvenlik modeli:
 *     Tehdit: XSS sessionStorage okuma  → şifreli blob, key yok → ✅ safe
 *     Tehdit: XSS memory okuma (eval)   → key memory'de → mümkün ama zaten game over
 *     Tehdit: Sayfa yenileme            → key kaybolur, tekrar giriş → ✅ UX trade-off kabul
 *     Tehdit: HTTPS olmadan             → tüm güvenlik anlamsız → HTTPS zorunlu (infra sorunu)
 *
 * Platformlar:
 *   iOS/Android : expo-secure-store (Keychain / Keystore) → değişmedi
 *   Web         : WebSecureStore (AES-GCM + sessionStorage) → YENİ
 *   Test        : InMemorySecureStore → değişmedi
 */

import { ok, err, ErrorCode } from "../core/Result";
import type { Result } from "../core/Result";
import type { IAPIKeyStore } from "../ai/CloudRuntime";

// ─── expo-secure-store arayüzü ───────────────────────────────────────────────

export interface ISecureStore {
  getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void>;
}

export interface SecureStoreOptions {
  keychainAccessible?: string;
  keychainService?: string;
}

// ─── Web güvenli depolama (AES-GCM + sessionStorage) ─────────────────────────

const SS_PREFIX = "ai_ide_enc_"; // sessionStorage key prefix

/**
 * ❗ SESSION-SCOPED WEB SECURITY:
 *
 * Şifreleme zinciri:
 *   plaintext key
 *     → AES-GCM encrypt (memory'deki CryptoKey ile)
 *     → base64(iv + ciphertext)
 *     → sessionStorage["ai_ide_enc_{name}"]
 *
 * AES CryptoKey tab ömrü boyunca memory'de kalır.
 * Tab kapanınca hem sessionStorage hem CryptoKey yok olur.
 */
export class WebSecureStore implements ISecureStore {
  /** Tab ömrü boyunca memory'de — asla persist edilmez */
  private readonly _sessionKey: Promise<CryptoKey>;

  constructor() {
    this._sessionKey = WebSecureStore._generateSessionKey();
  }

  private static async _generateSessionKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,      // extractable: false — key memory'den çıkarılamaz
      ["encrypt", "decrypt"],
    );
  }

  async setItemAsync(name: string, value: string): Promise<void> {
    const key       = await this._sessionKey;
    const iv        = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV
    const encoded   = new TextEncoder().encode(value);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

    // iv (12 byte) + ciphertext birleştir → base64
    const combined = new Uint8Array(iv.byteLength + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.byteLength);
    sessionStorage.setItem(SS_PREFIX + name, uint8ToBase64(combined));
  }

  async getItemAsync(name: string): Promise<string | null> {
    const stored = sessionStorage.getItem(SS_PREFIX + name);
    if (!stored) return null;

    try {
      const key      = await this._sessionKey;
      const combined = base64ToUint8(stored);
      const iv        = combined.slice(0, 12);
      const cipher    = combined.slice(12);
      const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
      return new TextDecoder().decode(decrypted);
    } catch {
      // Şifre çözülemedi (yanlış session key — sayfa yenileme sonrası)
      sessionStorage.removeItem(SS_PREFIX + name);
      return null;
    }
  }

  async deleteItemAsync(name: string): Promise<void> {
    sessionStorage.removeItem(SS_PREFIX + name);
  }
}

// ─── In-memory fallback (test) ────────────────────────────────────────────────

export class InMemorySecureStore implements ISecureStore {
  private readonly _store = new Map<string, string>();
  async getItemAsync(key: string)                    { return this._store.get(key) ?? null; }
  async setItemAsync(key: string, value: string)     { this._store.set(key, value); }
  async deleteItemAsync(key: string)                 { this._store.delete(key); }
}

// ─── Format doğrulama ─────────────────────────────────────────────────────────

const KEY_FORMATS: Record<"anthropic" | "openai", RegExp> = {
  anthropic: /^sk-ant-/,
  openai:    /^sk-/,
};

export function validateKeyFormat(provider: "anthropic" | "openai", key: string): boolean {
  return KEY_FORMATS[provider].test(key.trim());
}

// ─── Hata kodları ─────────────────────────────────────────────────────────────

export const APIKeyErrorCode = {
  NOT_FOUND:       ErrorCode.APIKEY_NOT_FOUND,
  INVALID_FORMAT:  ErrorCode.APIKEY_INVALID_FORMAT,
  STORE_FAILED:    ErrorCode.APIKEY_STORE_FAILED,
  DELETE_FAILED:   ErrorCode.APIKEY_DELETE_FAILED,
} as const;

const KEYCHAIN_PREFIX = "ai_key_";
const keyName = (p: "anthropic" | "openai") => KEYCHAIN_PREFIX + p;

// ─── APIKeyStore ─────────────────────────────────────────────────────────────

export interface IAPIKeyStoreExtended extends IAPIKeyStore {
  hasKey(provider: "anthropic" | "openai"): Promise<boolean>;
  setKey(provider: "anthropic" | "openai", key: string): Promise<Result<void>>;
  deleteKey(provider: "anthropic" | "openai"): Promise<Result<void>>;
  clearAll(): Promise<Result<void>>;
  clearMemoryCache(): void;
  dispose(): void;
}

export class APIKeyStore implements IAPIKeyStoreExtended {
  private readonly _store: ISecureStore;
  private readonly _cache = new Map<string, string>();
  private _disposed = false;

  constructor(store: ISecureStore) { this._store = store; }

  async getKey(provider: "anthropic" | "openai"): Promise<string | null> {
    if (this._disposed) return null;
    const name = keyName(provider);
    const cached = this._cache.get(name);
    if (cached) return cached;
    try {
      const value = await this._store.getItemAsync(name, this._keychainOpts());
      if (value) { this._cache.set(name, value); return value; }
    } catch { /* store erişim hatası */ }
    return null;
  }

  async hasKey(provider: "anthropic" | "openai"): Promise<boolean> {
    return (await this.getKey(provider)) !== null;
  }

  async setKey(provider: "anthropic" | "openai", key: string): Promise<Result<void>> {
    if (this._disposed) return err(APIKeyErrorCode.STORE_FAILED, "Disposed");
    const trimmed = key.trim();
    if (!validateKeyFormat(provider, trimmed))
      return err(APIKeyErrorCode.INVALID_FORMAT, `Geçersiz ${provider} API anahtarı formatı`);
    const name = keyName(provider);
    try {
      await this._store.setItemAsync(name, trimmed, this._keychainOpts());
      this._cache.set(name, trimmed);
      return ok(undefined);
    } catch (e) { return err(APIKeyErrorCode.STORE_FAILED, String(e)); }
  }

  async deleteKey(provider: "anthropic" | "openai"): Promise<Result<void>> {
    const name = keyName(provider);
    try {
      await this._store.deleteItemAsync(name, this._keychainOpts());
      this._cache.delete(name);
      return ok(undefined);
    } catch (e) { return err(APIKeyErrorCode.DELETE_FAILED, String(e)); }
  }

  async clearAll(): Promise<Result<void>> {
    const errors: string[] = [];
    for (const p of ["anthropic", "openai"] as const) {
      const r = await this.deleteKey(p);
      if (!r.ok) errors.push(r.error.message ?? r.error.code);
    }
    this._cache.clear();
    return errors.length > 0 ? err(APIKeyErrorCode.DELETE_FAILED, errors.join("; ")) : ok(undefined);
  }

  clearMemoryCache(): void { this._cache.clear(); }
  dispose(): void { this._disposed = true; this._cache.clear(); }

  private _keychainOpts(): SecureStoreOptions {
    return { keychainAccessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" };
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Platform-aware factory:
 *   Native (iOS/Android) → expo-secure-store (Keychain/Keystore)
 *   Web                  → WebSecureStore (AES-GCM + sessionStorage)
 *   Test                 → InMemorySecureStore
 */
export async function createAPIKeyStore(): Promise<IAPIKeyStoreExtended> {
  try {
    const SS = require("expo-secure-store") as ISecureStore;
    return new APIKeyStore(SS);
  } catch {
    if (typeof sessionStorage !== "undefined" && typeof crypto?.subtle !== "undefined") {
      return new APIKeyStore(new WebSecureStore());
    }
    return new APIKeyStore(new InMemorySecureStore());
  }
}

// ─── Base64 helpers ───────────────────────────────────────────────────────────

function uint8ToBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i += 8192)
    binary += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
