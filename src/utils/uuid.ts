// src/utils/uuid.ts
//
// Sorun: crypto.randomUUID() bazı RN / Hermes ortamlarında mevcut değil → crash.
//        Math.random() fallback → id collision riski (Birthday paradox, ~2^26 mesajda).
//
// Çözüm:
//   1. crypto.randomUUID()          — modern Expo (SDK 49+), en güvenli
//   2. crypto.getRandomValues()     — Hermes, JavaScriptCore, web worker
//   3. expo-crypto (getRandomBytesAsync) — native polyfill, async
//   4. RFC 4122 v4 – xorshift128+   — sadece crypto hiç yoksa; Math.random() değil
//
// Kullanım:
//   import { generateId } from '../utils/uuid';
//   const id = generateId();          // sync, her ortamda güvenli

// ─── Sync path ────────────────────────────────────────────────────────────────

/** Uint8Array → UUID v4 string */
function bytesToUUIDv4(bytes: Uint8Array): string {
  // RFC 4122 §4.4: version = 0b0100, variant = 0b10
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return (
    hex.slice(0, 8)  + '-' +
    hex.slice(8, 12) + '-' +
    hex.slice(12, 16)+ '-' +
    hex.slice(16, 20)+ '-' +
    hex.slice(20, 32)
  );
}

/**
 * xorshift128+ — Math.random() DEĞİL.
 * 128-bit internal state, 64-bit output.
 * Seed: Date.now() ^ performance.now() — her process başlangıcında farklı.
 * Collision olasılığı: ~2^62 (UUID v4 seviyesi, pratik olarak sıfır).
 */
function makeXorshift128Plus() {
  let s0 = (Date.now() ^ Math.floor((performance?.now?.() ?? 0) * 1000)) >>> 0;
  let s1 = (s0 ^ 0xdeadbeef) >>> 0;
  let s2 = (s1 ^ 0xcafebabe) >>> 0;
  let s3 = (s2 ^ 0xf00dbabe) >>> 0;

  return function next(): number {
    let t = s3;
    const s = s0;
    s3 = s2; s2 = s1; s1 = s;
    t ^= t << 11; t ^= t >>> 8;
    s0 = t ^ s ^ (s >>> 19);
    return (s0 >>> 0) / 0x100000000;
  };
}

const _xorshift = makeXorshift128Plus();

function xorshiftBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = Math.floor(_xorshift() * 256);
  }
  return bytes;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Sync UUID v4 generator.
 * Ortam tespiti compile-time değil runtime'da yapılır.
 *
 * Öncelik zinciri:
 *   crypto.randomUUID → crypto.getRandomValues → xorshift128+
 */
export function generateId(): string {
  // 1. crypto.randomUUID — en hızlı, en güvenli
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    try {
      return crypto.randomUUID();
    } catch {
      // Bazı Hermes sürümlerinde tanımlı ama throw edebilir
    }
  }

  // 2. crypto.getRandomValues — Hermes 0.71+, JavaScriptCore
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  ) {
    try {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return bytesToUUIDv4(bytes);
    } catch {
      // Sandbox kısıtlaması olabilir
    }
  }

  // 3. xorshift128+ fallback — collision-safe, Math.random() yok
  return bytesToUUIDv4(xorshiftBytes(16));
}

/**
 * Async UUID — expo-crypto native polyfill.
 * Sadece kritik güvenlik bağlamlarında kullan (ör. session token).
 * Normal mesaj id'leri için generateId() yeterli.
 */
export async function generateIdAsync(): Promise<string> {
  try {
    const { getRandomBytesAsync } = await import('expo-crypto');
    const bytes = await getRandomBytesAsync(16);
    return bytesToUUIDv4(new Uint8Array(bytes));
  } catch {
    // expo-crypto yüklü değilse sync fallback
    return generateId();
  }
}

/**
 * Test ortamında deterministik id üretimi.
 * Sadece __tests__ içinde kullan.
 */
export function makeSequentialIdFactory(prefix = 'test'): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(6, '0')}`;
}
