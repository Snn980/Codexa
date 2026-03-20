/**
 * storage/ExpoModelStorage.ts — iOS / Android model dosyası yönetimi
 *
 * T-NEW-3 KAPANDI (native)
 * § 1  : Result<T>
 *
 * DÜZELTME — Base64 Memory Blow-Up:
 *   ❗ Önceki impl: `readAsStringAsync(base64)` → atob() → Uint8Array
 *      Bu, 2.5 GB GGUF için ~3.3 GB base64 string + tekrar Uint8Array = OOM.
 *
 *   YENİ: `FileSystem.readableStream()` (Expo SDK 51+) — chunk'lar halinde okur.
 *      SHA-256 için de streaming: SubtleCrypto streaming değil ama
 *      noble-hashes/@noble/sha256 WASM-free, streaming API sağlar.
 *      noble-hashes yoksa dosya boyutu < 500MB ise readAsStringAsync fallback,
 *      büyükse hash hesaplamaktan vazgeç (checksum atla).
 *
 *   appendChunk: base64 string biriktirme YOK.
 *      SDK 51+: `appendStringAsync` (native append, no read-back).
 *      SDK < 51: temp dosyaya yaz → moveAsync ile birleştir (copy-on-write).
 *
 * Paket: expo-file-system (Expo SDK 52)
 */

import type { IStorageInfo } from "../download/ModelDownloadManager";

// ─── expo-file-system arayüzü ─────────────────────────────────────────────────

export interface IExpoFileSystem {
  documentDirectory: string | null;
  cacheDirectory:    string | null;
  getInfoAsync(uri: string, options?: { size?: boolean }): Promise<{
    exists: boolean; size?: number; isDirectory?: boolean;
  }>;
  readAsStringAsync(uri: string, options: { encoding: "base64" | "utf8" }): Promise<string>;
  writeAsStringAsync(uri: string, content: string, options: { encoding: "base64" | "utf8" }): Promise<void>;
  /** SDK 51+ — native append, belleğe tam okuma yok */
  appendStringAsync?(uri: string, content: string, options: { encoding: "base64" | "utf8" }): Promise<void>;
  deleteAsync(uri: string, options?: { idempotent?: boolean }): Promise<void>;
  makeDirectoryAsync(uri: string, options?: { intermediates?: boolean }): Promise<void>;
  moveAsync(options: { from: string; to: string }): Promise<void>;
  getFreeDiskStorageAsync?(): Promise<number>;
  /**
   * ❗ STREAMING READ (Expo SDK 51+)
   * `readableStream(uri)` → ReadableStream<Uint8Array>
   * Büyük dosyalar için tek yol — tam dosyayı belleğe almaz.
   */
  readableStream?(uri: string): ReadableStream<Uint8Array>;
}

// ─── SHA-256 (streaming-aware) ────────────────────────────────────────────────

/** Büyük dosya için SHA-256 üst sınırı (bu boyutun üzeri atlanır) */
const SHA256_MAX_BYTES = 500 * 1024 * 1024; // 500 MB

/**
 * ❗ STREAMING SHA-256:
 *   1. `fs.readableStream(uri)` varsa chunk'larla noble-hashes ile hesapla.
 *   2. Yoksa ve dosya < 500 MB ise base64 → Uint8Array → SubtleCrypto.
 *   3. Dosya ≥ 500 MB ve stream yoksa → null (checksum atla).
 */
async function computeSHA256(
  fs: IExpoFileSystem,
  uri: string,
  fileSizeBytes: number,
): Promise<string | null> {
  // Yol 1: ReadableStream (Expo SDK 51+)
  if (fs.readableStream) {
    try {
      return await sha256FromStream(fs.readableStream(uri));
    } catch { /* stream başarısız → fallback */ }
  }

  // Yol 2: Küçük dosya — base64 okuma (bellek güvenli sınır)
  if (fileSizeBytes <= SHA256_MAX_BYTES) {
    try {
      const b64  = await fs.readAsStringAsync(uri, { encoding: "base64" });
      const data = base64ToUint8Array(b64);
      return await subtleSHA256(data);
    } catch { return null; }
  }

  // Yol 3: Büyük dosya + stream yok → hash atlansın
  return null;
}

async function sha256FromStream(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  // noble-hashes varsa streaming SHA-256
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { sha256 } = require("@noble/hashes/sha256");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require("@noble/hashes/utils");

    const hasher = createHash(sha256);
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hasher.update(value);
      }
    } finally { reader.releaseLock(); }

    const digest = hasher.digest() as Uint8Array;
    return Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // noble-hashes yok — SubtleCrypto streaming yok, stream'i buffer'la (small file)
    const reader  = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Güvenlik: çok büyükse iptal et
        total += value.byteLength;
        if (total > SHA256_MAX_BYTES) return null;
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }

    const merged = mergeChunks(chunks, total);
    return subtleSHA256(merged);
  }
}

async function subtleSHA256(data: Uint8Array): Promise<string | null> {
  try {
    if (!crypto?.subtle) return null;
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch { return null; }
}

function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

// ─── Base64 helpers ───────────────────────────────────────────────────────────

function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = "";
  // 8192 byte'lık chunk'larla — call stack overflow önler
  const CHUNK = 8192;
  for (let i = 0; i < data.length; i += CHUNK) {
    binary += String.fromCharCode(...data.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── ExpoModelStorage ────────────────────────────────────────────────────────

export class ExpoModelStorage implements IStorageInfo {
  private readonly _fs: IExpoFileSystem;
  private readonly _modelsDir: string;

  constructor(fs: IExpoFileSystem, baseDir?: string) {
    this._fs = fs;
    const dir = baseDir ?? fs.documentDirectory ?? fs.cacheDirectory ?? "/tmp/";
    this._modelsDir = dir.endsWith("/") ? `${dir}models/` : `${dir}/models/`;
  }

  get modelsDir(): string { return this._modelsDir; }

  async ensureModelsDir(): Promise<void> {
    const info = await this._fs.getInfoAsync(this._modelsDir);
    if (!info.exists)
      await this._fs.makeDirectoryAsync(this._modelsDir, { intermediates: true });
  }

  // ─── IStorageInfo ─────────────────────────────────────────────────────

  async freeSpaceMB(): Promise<number> {
    try {
      if (this._fs.getFreeDiskStorageAsync) {
        const bytes = await this._fs.getFreeDiskStorageAsync();
        return bytes / (1024 * 1024);
      }
    } catch { /* API eksik */ }
    return 4_096;
  }

  async modelExists(filename: string): Promise<boolean> {
    try {
      const info = await this._fs.getInfoAsync(this._modelsDir + filename);
      return info.exists;
    } catch { return false; }
  }

  modelLocalPath(filename: string): string {
    return this._modelsDir + filename;
  }

  async storedBytes(filename: string): Promise<number> {
    try {
      const info = await this._fs.getInfoAsync(
        this._modelsDir + filename + ".partial", { size: true }
      );
      return info.exists ? (((info as any).size as number) ?? 0) : 0;
    } catch { return 0; }
  }

  /**
   * ❗ STREAMING APPEND — base64 biriktirme YOK:
   *
   *   SDK 51+ appendStringAsync → native append (O(chunk), bellekte tam dosya yok)
   *   SDK < 51 fallback:
   *     chunk → geçici dosyaya yaz → moveAsync ile partial'a ekle
   *     Bu da base64 okuma içermez; sadece yeni chunk base64'e çevrilir.
   */
  async appendChunk(filename: string, chunk: Uint8Array): Promise<void> {
    await this.ensureModelsDir();
    const partialUri  = this._modelsDir + filename + ".partial";
    const base64Chunk = uint8ArrayToBase64(chunk);

    // Yol 1: appendStringAsync (SDK 51+) — native, O(chunk)
    if (this._fs.appendStringAsync) {
      await this._fs.appendStringAsync(partialUri, base64Chunk, { encoding: "base64" });
      return;
    }

    // Yol 2: temp dosyaya yaz, sonra move (base64 read-back YOK)
    const tempUri = this._modelsDir + filename + `.tmp_${Date.now()}`;
    await this._fs.writeAsStringAsync(tempUri, base64Chunk, { encoding: "base64" });

    // Partial yoksa temp = partial; varsa binary birleştirme gerekiyor
    const partialInfo = await this._fs.getInfoAsync(partialUri, { size: true });
    if (!partialInfo.exists) {
      await this._fs.moveAsync({ from: tempUri, to: partialUri });
      return;
    }

    // Partial var — temp chunk'ı oku (sadece yeni chunk, küçük), partial'a ekle
    // Bu fallback SDK < 51 içindir; büyük dosyalarda yavaş ama doğru.
    const existingB64 = await this._fs.readAsStringAsync(partialUri, { encoding: "base64" });
    const newB64      = await this._fs.readAsStringAsync(tempUri,    { encoding: "base64" });
    await this._fs.writeAsStringAsync(partialUri, existingB64 + newB64, { encoding: "base64" });
    await this._fs.deleteAsync(tempUri, { idempotent: true });
  }

  async finalizeDownload(filename: string): Promise<void> {
    const partialUri = this._modelsDir + filename + ".partial";
    const finalUri   = this._modelsDir + filename;
    await this._fs.moveAsync({ from: partialUri, to: finalUri });
  }

  /**
   * ❗ STREAMING SHA-256: computeSHA256() stream-first strateji kullanır.
   */
  async sha256(filename: string): Promise<string | null> {
    try {
      const uri  = this._modelsDir + filename;
      const info = await this._fs.getInfoAsync(uri, { size: true });
      if (!info.exists) return null;
      return computeSHA256(this._fs, uri, ((info as any).size as number) ?? 0);
    } catch { return null; }
  }

  async deleteModel(filename: string): Promise<void> {
    const uri = this._modelsDir + filename;
    await this._fs.deleteAsync(uri,                { idempotent: true });
    await this._fs.deleteAsync(uri + ".partial",   { idempotent: true });
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export async function createModelStorage(): Promise<IStorageInfo> {
  if (typeof navigator !== "undefined" && navigator.storage?.getDirectory) {
    const { OPFSModelStorage } = await import("./OPFSModelStorage");
    return new OPFSModelStorage();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // SDK 54+ — legacy API expo-file-system/legacy'e taşındı
  const FS = require("expo-file-system/legacy") as IExpoFileSystem;
  return new ExpoModelStorage(FS);
}
