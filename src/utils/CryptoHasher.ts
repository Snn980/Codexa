/**
 * @file     CryptoHasher.ts
 * @module   utils
 * @version  1.0.0
 * @since    Phase 21 — § 75
 *
 * @description
 *   Platform-bağımsız SHA-256 hesaplayıcı.
 *
 *   Öncelik sırası:
 *     1. Web Crypto API (RN Hermes ≥ 0.73 / modern runtime'da mevcut)
 *     2. Node.js crypto modülü (Jest / Node test ortamı)
 *     3. Saf JS fallback — büyük dosyalarda yavaş, test/geliştirme amaçlı
 *
 *   ModelDownloadManager kullanımı:
 *     const hex = await CryptoHasher.sha256(uint8Array);
 *     if (hex !== expected) → CHECKSUM_MISMATCH hata
 *
 *   IStorageInfo.sha256(filename) arayüzü de bu sınıfı kullanabilir:
 *     1. Dosyayı Uint8Array olarak oku (expo-file-system / OPFS)
 *     2. CryptoHasher.sha256(data) çağır
 *     3. Hex string döndür
 *
 * Tasarım kararları:
 *   • Sınıf değil modül-level fonksiyon — DI gerektirmez, kolay test edilir.
 *   • `subtle.digest` asenkron → tüm path async.
 *   • Test ortamında Web Crypto olmayabilir; Node crypto fallback zorunlu.
 *   • Saf JS fallback: FNV-like değil gerçek SHA-256 (standart uyum için
 *     minimal implementasyon — production'da platform API'si kullanılır).
 */

// ─── Web Crypto tip genişletme ────────────────────────────────────────────────
// RN Hermes ortamında `crypto.subtle` mevcut olabilir ama tipleme eksik.
declare const crypto: { subtle: SubtleCrypto } | undefined;

// ─── CryptoHasher ─────────────────────────────────────────────────────────────

export const CryptoHasher = {

  /**
   * Uint8Array verisinin SHA-256 hex özetini döndürür.
   *
   * @param data — Hash alınacak veri
   * @returns lowercase hex string (64 karakter)
   *
   * @example
   *   const hex = await CryptoHasher.sha256(new Uint8Array([1, 2, 3]));
   *   // "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"
   */
  async sha256(data: Uint8Array): Promise<string> {
    // ── 1. Web Crypto API ─────────────────────────────────────────────────
    if (typeof crypto !== "undefined" && crypto?.subtle) {
      try {
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        return _bufferToHex(new Uint8Array(hashBuffer));
      } catch {
        // subtle.digest başarısız → Node fallback dene
      }
    }

    // ── 2. Node.js crypto (Jest / test ortamı) ────────────────────────────
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodeCrypto = require("crypto") as typeof import("crypto");
      const hash = nodeCrypto.createHash("sha256");
      hash.update(Buffer.from(data));
      return hash.digest("hex");
    } catch {
      // Node crypto yok → saf JS fallback
    }

    // ── 3. Saf JS SHA-256 (RFC 6234 implementasyonu) ──────────────────────
    return _pureSha256(data);
  },

  /**
   * İki SHA-256 hex özetini sabit zamanda karşılaştırır.
   * Timing attack'a karşı güvenli (her byte her zaman karşılaştırılır).
   *
   * @example
   *   if (!CryptoHasher.timingSafeEqual(actual, expected)) {
   *     throw new Error("Checksum mismatch");
   *   }
   */
  timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  },

} as const;

// ─── Yardımcılar ──────────────────────────────────────────────────────────────

function _bufferToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Saf JS SHA-256 — NIST FIPS 180-4 tabanlı.
 * Platform crypto API'si yoksa kullanılır.
 * Kaynak: RFC 6234 referans implementasyonundan uyarlandı.
 */
function _pureSha256(data: Uint8Array): string {
  // SHA-256 sabit değerleri (ilk 64 asal sayının karekök kesir kısımları)
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  // Başlangıç hash değerleri (ilk 8 asal sayının karekök kesir kısımları)
  let [h0, h1, h2, h3, h4, h5, h6, h7] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  // Padding
  const bitLen     = data.length * 8;
  const padLen     = ((55 - data.length) & 63) + 1;
  const padded     = new Uint8Array(data.length + padLen + 8);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLen >>> 0,   false);
  view.setUint32(padded.length - 8, (bitLen / 2**32) >>> 0, false);

  // İşle (512-bit bloklar)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let i = 0; i < padded.length; i += 64) {
    const w = new Uint32Array(64);
    for (let j = 0; j < 16; j++) {
      w[j] = view.getUint32(i + j * 4, false);
    }
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j-15], 7) ^ rotr(w[j-15], 18) ^ (w[j-15] >>> 3);
      const s1 = rotr(w[j-2],  17) ^ rotr(w[j-2],  19) ^ (w[j-2] >>> 10);
      w[j] = (w[j-16] + s0 + w[j-7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];

    for (let j = 0; j < 64; j++) {
      const S1  = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch  = (e & f) ^ (~e & g);
      const t1  = (h + S1 + ch + K[j] + w[j]) >>> 0;
      const S0  = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2  = (S0 + maj) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d+t1)>>>0, c, b, a, (t1+t2)>>>0];
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, "0"))
    .join("");
}
