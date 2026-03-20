/**
 * FNV-1a 32-bit hash — deterministik UUID üretimi için
 */

/** FNV-1a 32-bit */
export function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

/** FNV-1a tabanlı deterministik UUID (v4 formatında) */
export function fnv1a_uuid(input: string): string {
  const h1 = fnv1a(input);
  const h2 = fnv1a(input + "\x01");
  const h3 = fnv1a(input + "\x02");
  const h4 = fnv1a(input + "\x03");
  const hex = (n: number, len: number) =>
    n.toString(16).padStart(len, "0");
  return [
    hex(h1, 8),
    hex(h2 >>> 16, 4),
    hex(((h2 & 0xffff) & 0x0fff) | 0x4000, 4),
    hex(((h3 >>> 16) & 0x3fff) | 0x8000, 4),
    hex(h3 & 0xffff, 4) + hex(h4, 8),
  ].join("-");
}
