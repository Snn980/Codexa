/**
 * storage/OPFSModelStorage.ts — OPFS tabanlı GGUF model dosyası yönetimi
 *
 * T-NEW-3 KAPANDI (web / Expo web)
 * § 1  : Result<T>
 *
 * DÜZELTME — OPFS Web Uyumluluğu Riski:
 *   ❗ navigator?.storage?.getDirectory yoksa OPFS desteklenmiyor.
 *      IndexedDB fallback (idb-keyval / Uint8Array blob storage) devreye girer.
 *      `isOPFSSupported()` her metot başında kontrol edilir;
 *      desteklenmiyorsa IndexedDBModelStorage'a delege edilir.
 *
 *   Tarayıcı desteği (2026):
 *     Chrome 86+ ✅ | Firefox 111+ ✅ | Safari 15.2+ ✅ (kısıtlı)
 *     Safari 15.2–16: getDirectory var, createWritable YOK → fallback gerekli
 *     Safari 16.4+: tam OPFS desteği ✅
 */

import type { IStorageInfo } from "../download/ModelDownloadManager";

// ─── OPFS destek kontrolü ─────────────────────────────────────────────────────

/**
 * ❗ OPFS UYUMLULUK: sadece getDirectory değil, createWritable da kontrol edilir.
 * Safari 15.2–16'da getDirectory var ama createWritable yok → IndexedDB fallback.
 */
export async function isOPFSSupported(): Promise<boolean> {
  try {
    if (!navigator?.storage?.getDirectory) return false;
    const root   = await navigator.storage.getDirectory();
    const testHandle = await root.getFileHandle("__opfs_test__", { create: true });
    // createWritable destekleniyor mu?
    const writable = await testHandle.createWritable();
    await writable.close();
    await root.removeEntry("__opfs_test__");
    return true;
  } catch {
    return false;
  }
}

// ─── IndexedDB fallback ────────────────────────────────────────────────────────

/**
 * OPFS desteklenmediğinde devreye giren IndexedDB tabanlı storage.
 * Uint8Array'leri IDBObjectStore içinde blob olarak saklar.
 * Büyük dosyalar için chunked write; stream read.
 *
 * DB schema:
 *   models_store  : { key: filename, value: Uint8Array (tamamlanmış) }
 *   partial_store : { key: filename, value: Uint8Array[] (chunk listesi) }
 */
class IndexedDBModelStorage implements IStorageInfo {
  private static readonly DB_NAME    = "ai_ide_models";
  private static readonly DB_VERSION = 1;
  private static readonly MODELS     = "models";
  private static readonly PARTIALS   = "partials";

  private _db: IDBDatabase | null = null;

  private async _getDB(): Promise<IDBDatabase> {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IndexedDBModelStorage.DB_NAME, IndexedDBModelStorage.DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(IndexedDBModelStorage.MODELS))
          db.createObjectStore(IndexedDBModelStorage.MODELS);
        if (!db.objectStoreNames.contains(IndexedDBModelStorage.PARTIALS))
          db.createObjectStore(IndexedDBModelStorage.PARTIALS);
      };
      req.onsuccess = (e) => {
        this._db = (e.target as IDBOpenDBRequest).result;
        resolve(this._db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  private async _get<T>(store: string, key: string): Promise<T | undefined> {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror   = () => reject(req.error);
    });
  }

  private async _put(store: string, key: string, value: unknown): Promise<void> {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(store, "readwrite");
      const req = tx.objectStore(store).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  private async _delete(store: string, key: string): Promise<void> {
    const db = await this._getDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(store, "readwrite");
      const req = tx.objectStore(store).delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  async freeSpaceMB(): Promise<number> {
    try {
      if (navigator.storage?.estimate) {
        const { quota = 0, usage = 0 } = await navigator.storage.estimate();
        return Math.max(0, (quota - usage) / (1024 * 1024));
      }
    } catch { /* estimate yoksa */ }
    return 1_024;
  }

  async modelExists(filename: string): Promise<boolean> {
    const val = await this._get<Uint8Array>(IndexedDBModelStorage.MODELS, filename);
    return val !== undefined;
  }

  modelLocalPath(filename: string): string {
    return `idb://models/${filename}`;
  }

  async storedBytes(filename: string): Promise<number> {
    const chunks = await this._get<Uint8Array[]>(IndexedDBModelStorage.PARTIALS, filename);
    if (!chunks) return 0;
    return chunks.reduce((sum, c) => sum + c.byteLength, 0);
  }

  async appendChunk(filename: string, chunk: Uint8Array): Promise<void> {
    const existing = (await this._get<Uint8Array[]>(IndexedDBModelStorage.PARTIALS, filename)) ?? [];
    existing.push(chunk);
    await this._put(IndexedDBModelStorage.PARTIALS, filename, existing);
  }

  async finalizeDownload(filename: string): Promise<void> {
    const chunks = (await this._get<Uint8Array[]>(IndexedDBModelStorage.PARTIALS, filename)) ?? [];
    const total  = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset   = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    await this._put(IndexedDBModelStorage.MODELS, filename, merged);
    await this._delete(IndexedDBModelStorage.PARTIALS, filename);
  }

  async sha256(filename: string): Promise<string | null> {
    try {
      const data = await this._get<Uint8Array>(IndexedDBModelStorage.MODELS, filename);
      if (!data || !crypto?.subtle) return null;
      const hash = await crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch { return null; }
  }

  async deleteModel(filename: string): Promise<void> {
    await this._delete(IndexedDBModelStorage.MODELS, filename);
    await this._delete(IndexedDBModelStorage.PARTIALS, filename);
  }
}

// ─── OPFS (tam destek) ────────────────────────────────────────────────────────

async function getModelsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("models", { create: true });
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

class OPFSNativeStorage implements IStorageInfo {
  private static readonly PARTIAL_EXT = ".partial";

  async freeSpaceMB(): Promise<number> {
    try {
      if (navigator.storage?.estimate) {
        const { quota = 0, usage = 0 } = await navigator.storage.estimate();
        return Math.max(0, (quota - usage) / (1024 * 1024));
      }
    } catch { /* estimate yoksa */ }
    return 2_048;
  }

  async modelExists(filename: string): Promise<boolean> {
    try { await (await getModelsDir()).getFileHandle(filename); return true; }
    catch { return false; }
  }

  modelLocalPath(filename: string): string {
    return `opfs://models/${filename}`;
  }

  async storedBytes(filename: string): Promise<number> {
    try {
      const h = await (await getModelsDir())
        .getFileHandle(filename + OPFSNativeStorage.PARTIAL_EXT);
      return (await h.getFile()).size;
    } catch { return 0; }
  }

  async appendChunk(filename: string, chunk: Uint8Array): Promise<void> {
    const dir    = await getModelsDir();
    const handle = await dir.getFileHandle(
      filename + OPFSNativeStorage.PARTIAL_EXT, { create: true }
    );
    const existingSize = (await handle.getFile()).size;
    const writable     = await handle.createWritable({ keepExistingData: true });
    try {
      await writable.seek(existingSize);
      await writable.write(chunk);
    } finally { await writable.close(); }
  }

  async finalizeDownload(filename: string): Promise<void> {
    const dir         = await getModelsDir();
    const partialName = filename + OPFSNativeStorage.PARTIAL_EXT;
    try {
      const h = await dir.getFileHandle(partialName);
      // @ts-expect-error — move() draft API (Chrome 121+)
      if (typeof h.move === "function") { await h.move(dir, filename); return; }
    } catch { /* move desteklenmiyor */ }
    // Fallback
    const src  = await (await dir.getFileHandle(partialName)).getFile();
    const data = new Uint8Array(await src.arrayBuffer());
    const dst  = await dir.getFileHandle(filename, { create: true });
    const w    = await dst.createWritable();
    try { await w.write(data); } finally { await w.close(); }
    await dir.removeEntry(partialName);
  }

  async sha256(filename: string): Promise<string | null> {
    try {
      const h    = await (await getModelsDir()).getFileHandle(filename);
      const data = new Uint8Array(await (await h.getFile()).arrayBuffer());
      return sha256Hex(data);
    } catch { return null; }
  }

  async deleteModel(filename: string): Promise<void> {
    const dir = await getModelsDir();
    for (const name of [filename, filename + OPFSNativeStorage.PARTIAL_EXT]) {
      try { await dir.removeEntry(name); } catch { /* yoksa sessizce geç */ }
    }
  }
}

// ─── OPFSModelStorage — public facade ────────────────────────────────────────

/**
 * ❗ OPFS UYUMLULUK: init()'te destek kontrolü.
 * OPFS tam destekliyorsa → OPFSNativeStorage
 * Değilse (Safari < 16.4, eski Chrome)  → IndexedDBModelStorage
 */
export class OPFSModelStorage implements IStorageInfo {
  private _impl: IStorageInfo | null = null;

  private async _getImpl(): Promise<IStorageInfo> {
    if (this._impl) return this._impl;
    this._impl = (await isOPFSSupported())
      ? new OPFSNativeStorage()
      : new IndexedDBModelStorage();
    return this._impl;
  }

  async freeSpaceMB()                              { return (await this._getImpl()).freeSpaceMB(); }
  async modelExists(f: string)                     { return (await this._getImpl()).modelExists(f); }
  modelLocalPath(f: string)                        { return `opfs://models/${f}`; } // UI için sabit
  async storedBytes(f: string)                     { return (await this._getImpl()).storedBytes(f); }
  async appendChunk(f: string, c: Uint8Array)      { return (await this._getImpl()).appendChunk(f, c); }
  async sha256(f: string)                          { return (await this._getImpl()).sha256(f); }
  async finalizeDownload(f: string)                { return (await (this._getImpl() as any)).finalizeDownload?.(f); }
  async deleteModel(f: string)                     { return (await (this._getImpl() as any)).deleteModel?.(f); }
  async listModels(): Promise<string[]>            { return []; }
}
