/**
 * download/ModelDownloadManager.ts — GGUF model indirme yöneticisi
 *
 * § 1  : Result<T>
 * § 3  : IEventBus — progress eventleri
 * § 45 : Semaphore — max 3 eşzamanlı foreground indirme
 *
 * TAŞINDI: src/ui/model/ModelDownloadManager.ts → src/download/ModelDownloadManager.ts
 *   Business logic UI klasöründe olmamalı. Download yönetimi domain katmanıdır.
 *
 * DÜZELTMELER:
 *   ❗ PARALEL LOCK     : startDownload başında _downloadLock kontrolü.
 *      Aynı model için ikinci çağrı anında ALREADY_DOWNLOADING döner.
 *   💡 RESUME DOWNLOAD  : Content-Range + If-Range header ile kısmi indirme.
 *   💡 CHECKSUM         : indirme tamamlandığında SHA-256 doğrulaması (stub).
 */

import { ok, err }         from '../utils/result';
import type { Result }     from '../utils/result';
import type { IEventBus }  from '../core/Event-bus/EventBus';
import type { AIModelId, GGUFMeta } from '../ai/AIModels';
import { AI_MODELS }       from '../ai/AIModels';

// ─── Storage arayüzü ─────────────────────────────────────────────────────────

export interface IStorageInfo {
  freeSpaceMB(): Promise<number>;
  modelExists(filename: string): Promise<boolean>;
  modelLocalPath(filename: string): string;
  /** § 17.5 RESUME: Kısmen indirilmiş dosyanın bayt sayısı (yoksa 0) */
  storedBytes(filename: string): Promise<number>;
  /** T-NEW-3: Dosyaya chunk yaz (OPFS / expo-file-system) */
  appendChunk(filename: string, chunk: Uint8Array): Promise<void>;
  /** § 47 CHECKSUM: dosyanın SHA-256 hex'ini döndür */
  sha256(filename: string): Promise<string | null>;
}

// ─── GGUFMeta genişletme — checksum ─────────────────────────────────────────

export interface GGUFMetaWithChecksum extends GGUFMeta {
  /** § 47 CHECKSUM: isteğe bağlı SHA-256 hex (HuggingFace model card'dan) */
  sha256?: string;
}

// ─── İndirme durumu ──────────────────────────────────────────────────────────

export type DownloadStatus =
  | 'idle' | 'queued' | 'checking' | 'downloading' | 'verifying'
  | 'complete' | 'error' | 'failed' | 'cancelled';

export interface DownloadState {
  modelId:      AIModelId;
  status:       DownloadStatus;
  receivedMB:   number;
  totalMB:      number;
  percent:      number;
  localPath?:   string;
  errorCode?:   string;
  errorMessage?: string;
  /** § 17.5 RESUME: server Range destekliyorsa true */
  resumable?:   boolean;
}

// ─── Hata kodları ────────────────────────────────────────────────────────────

export const DownloadErrorCode = {
  MODEL_NOT_FOUND:       'DL_MODEL_NOT_FOUND',
  NO_GGUF_META:          'DL_NO_GGUF_META',
  INSUFFICIENT_SPACE:    'DOWNLOAD_INSUFFICIENT_SPACE',
  NETWORK_ERROR:         'DL_NETWORK_ERROR',
  WRITE_ERROR:           'DL_WRITE_ERROR',
  ALREADY_DOWNLOADING:   'DL_ALREADY_DOWNLOADING',
  CANCELLED:             'DL_CANCELLED',
  CHECKSUM_MISMATCH:     'DL_CHECKSUM_MISMATCH',
  UNKNOWN:               'DOWNLOAD_UNKNOWN',
} as const;

const MIN_FREE_BUFFER_MB = 200;

// ─── ModelDownloadManager ────────────────────────────────────────────────────

export class ModelDownloadManager {
  private readonly _eventBus:          IEventBus;
  private readonly _storage:           IStorageInfo;
  private readonly _states            = new Map<AIModelId, DownloadState>();
  private readonly _abortControllers  = new Map<AIModelId, AbortController>();
  /** § 45 PARALEL LOCK */
  private readonly _downloadLock      = new Set<AIModelId>();

  constructor(eventBus: IEventBus, storage: IStorageInfo) {
    this._eventBus = eventBus;
    this._storage  = storage;
  }

  // ─── getState ─────────────────────────────────────────────────────────

  getState(modelId: AIModelId): DownloadState {
    return this._states.get(modelId) ?? {
      modelId, status: 'idle', receivedMB: 0, totalMB: 0, percent: 0,
    };
  }

  isDownloading(modelId: AIModelId): boolean {
    return this._downloadLock.has(modelId);
  }

  // ─── startDownload ────────────────────────────────────────────────────

  async startDownload(modelId: AIModelId): Promise<Result<string>> {
    if (this._downloadLock.has(modelId)) {
      return err(DownloadErrorCode.ALREADY_DOWNLOADING, 'Already downloading');
    }

    const model = AI_MODELS.find((m) => m.id === modelId);
    if (!model) return err(DownloadErrorCode.MODEL_NOT_FOUND, `Unknown: ${modelId}`);
    const gguf = model.gguf as GGUFMetaWithChecksum | undefined;
    if (!gguf)  return err(DownloadErrorCode.NO_GGUF_META, 'No GGUF meta');

    // Zaten yüklü mu?
    const exists = await this._storage.modelExists(gguf.filename);
    if (exists) {
      const localPath = this._storage.modelLocalPath(gguf.filename);
      this._setState(modelId, {
        status: 'complete', receivedMB: gguf.sizeMB, totalMB: gguf.sizeMB,
        percent: 100, localPath,
      });
      this._eventBus.emit('model:download:complete', { modelId, localPath });
      return ok(localPath);
    }

    // Storage kontrolü
    this._setState(modelId, { status: 'checking', receivedMB: 0, totalMB: gguf.sizeMB, percent: 0 });
    const freeSpace = await this._storage.freeSpaceMB();
    const required  = gguf.sizeMB + MIN_FREE_BUFFER_MB;

    if (freeSpace < required) {
      const msg = `Yetersiz alan: ${freeSpace} MB mevcut, ${required} MB gerekli`;
      this._setState(modelId, {
        status: 'error', receivedMB: 0, totalMB: gguf.sizeMB, percent: 0,
        errorCode: DownloadErrorCode.INSUFFICIENT_SPACE, errorMessage: msg,
      });
      return err(DownloadErrorCode.INSUFFICIENT_SPACE, msg);
    }

    this._downloadLock.add(modelId);
    const abortCtrl = new AbortController();
    this._abortControllers.set(modelId, abortCtrl);
    this._eventBus.emit('model:download:start', { modelId, sizeMB: gguf.sizeMB });

    let result: Result<string>;
    try {
      result = await this._download(modelId, gguf, abortCtrl.signal);
    } finally {
      this._downloadLock.delete(modelId);
      this._abortControllers.delete(modelId);
    }
    return result;
  }

  // ─── cancel (alias for cancelDownload) ───────────────────────────────

  cancel(modelId: AIModelId): void {
    this.cancelDownload(modelId);
  }

  // ─── startDownloadFromUrl ─────────────────────────────────────────────
  // Manifest entry'den URL kullanarak indir (OTA entegrasyonu, § 11)

  async startDownloadFromUrl(entry: {
    id:          AIModelId;
    filename:    string;
    sizeMB:      number;
    sha256:      string | null;
    downloadUrl: string;
  }): Promise<Result<string>> {
    const modelId = entry.id;

    if (this._downloadLock.has(modelId)) {
      return err(DownloadErrorCode.UNKNOWN, 'Already downloading');
    }

    // Zaten tam indirilmiş mi?
    const exists = await this._storage.modelExists(entry.filename);
    if (exists) {
      const storedBytes = await this._storage.storedBytes(entry.filename);
      const expectedBytes = entry.sizeMB * 1024 * 1024;
      if (storedBytes >= expectedBytes) {
        const localPath = this._storage.modelLocalPath(entry.filename);
        this._setState(modelId, {
          status: 'complete', receivedMB: entry.sizeMB,
          totalMB: entry.sizeMB, percent: 100, localPath,
        });
        this._eventBus.emit('model:download:complete', { modelId, localPath });
        return ok(localPath);
      }
    }

    // Alan kontrolü
    this._setState(modelId, { status: 'checking', receivedMB: 0, totalMB: entry.sizeMB, percent: 0 });
    const freeSpace = await this._storage.freeSpaceMB();
    const required  = entry.sizeMB + MIN_FREE_BUFFER_MB;
    if (freeSpace < required) {
      const msg = `Yetersiz alan: ${freeSpace} MB mevcut, ${required} MB gerekli`;
      this._setState(modelId, {
        status: 'error', receivedMB: 0, totalMB: entry.sizeMB, percent: 0,
        errorCode: DownloadErrorCode.INSUFFICIENT_SPACE, errorMessage: msg,
      });
      return err(DownloadErrorCode.INSUFFICIENT_SPACE, msg);
    }

    this._downloadLock.add(modelId);
    const abortCtrl = new AbortController();
    this._abortControllers.set(modelId, abortCtrl);
    this._eventBus.emit('model:download:start', { modelId, sizeMB: entry.sizeMB });

    let result: Result<string>;
    try {
      result = await this._downloadFromUrl(modelId, entry, abortCtrl.signal);
    } finally {
      this._downloadLock.delete(modelId);
      this._abortControllers.delete(modelId);
    }
    return result;
  }

  // ─── _downloadFromUrl ─────────────────────────────────────────────────

  private async _downloadFromUrl(
    modelId: AIModelId,
    entry: { filename: string; sizeMB: number; sha256: string | null; downloadUrl: string },
    signal: AbortSignal,
  ): Promise<Result<string>> {
    const storedBytes = await this._storage.storedBytes(entry.filename);
    const headers: Record<string, string> = {};
    if (storedBytes > 0) {
      headers['Range']    = `bytes=${storedBytes}-`;
      headers['If-Range'] = entry.filename;
    }

    let response: Response;
    try {
      response = await fetch(entry.downloadUrl, { signal, headers });
    } catch (e) {
      if (signal.aborted) return err(DownloadErrorCode.CANCELLED, 'Cancelled');
      return this._emitError(modelId, entry.sizeMB, DownloadErrorCode.NETWORK_ERROR, String(e));
    }

    const isPartial = response.status === 206;
    if (!response.ok && !isPartial) {
      return this._emitError(modelId, entry.sizeMB, DownloadErrorCode.NETWORK_ERROR, `HTTP ${response.status}`);
    }

    const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10);
    const totalBytes    = isPartial ? storedBytes + contentLength : contentLength;
    const totalMB       = totalBytes > 0 ? totalBytes / (1024 * 1024) : entry.sizeMB;
    let receivedBytes   = isPartial ? storedBytes : 0;
    const resumable     = isPartial;

    this._setState(modelId, {
      status: 'downloading', receivedMB: receivedBytes / (1024 * 1024),
      totalMB, percent: 0, resumable,
    });

    const reader = response.body?.getReader();
    if (!reader) return this._emitError(modelId, totalMB, DownloadErrorCode.NETWORK_ERROR, 'No body');

    try {
      while (true) {
        if (signal.aborted) { reader.cancel(); return err(DownloadErrorCode.CANCELLED, 'Cancelled'); }
        const { done, value } = await reader.read();
        if (done) break;
        await this._storage.appendChunk(entry.filename, value);
        receivedBytes += value.byteLength;
        const receivedMB = receivedBytes / (1024 * 1024);
        const percent    = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0;
        this._setState(modelId, { status: 'downloading', receivedMB, totalMB, percent, resumable });
        this._eventBus.emit('model:download:progress', { modelId, receivedMB, totalMB, percent });
      }
    } catch (e) {
      if (signal.aborted) return err(DownloadErrorCode.CANCELLED, 'Cancelled');
      return this._emitError(modelId, totalMB, DownloadErrorCode.NETWORK_ERROR, String(e));
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }

    // Checksum
    if (entry.sha256) {
      this._setState(modelId, { status: 'verifying', receivedMB: totalMB, totalMB, percent: 100 });
      const actual = await this._storage.sha256(entry.filename);
      if (actual && actual.toLowerCase() !== entry.sha256.toLowerCase()) {
        return this._emitError(modelId, totalMB, DownloadErrorCode.CHECKSUM_MISMATCH,
          `Checksum mismatch: expected ${entry.sha256}, got ${actual}`);
      }
    }

    const localPath = this._storage.modelLocalPath(entry.filename);
    this._setState(modelId, { status: 'complete', receivedMB: totalMB, totalMB, percent: 100, localPath });
    this._eventBus.emit('model:download:complete', { modelId, localPath });
    return ok(localPath);
  }

  // ─── cancelDownload ───────────────────────────────────────────────────

  cancelDownload(modelId: AIModelId): void {
    const ctrl = this._abortControllers.get(modelId);
    if (!ctrl) return;
    ctrl.abort();
    const current = this._states.get(modelId);
    this._setState(modelId, {
      status: 'cancelled',
      receivedMB: current?.receivedMB ?? 0,
      totalMB: current?.totalMB ?? 0,
      percent: current?.percent ?? 0,
    });
    this._eventBus.emit('model:download:cancel', { modelId });
  }

  // ─── _download ────────────────────────────────────────────────────────

  private async _download(
    modelId: AIModelId,
    gguf: GGUFMetaWithChecksum,
    signal: AbortSignal,
  ): Promise<Result<string>> {
    const url = `https://huggingface.co/${gguf.huggingFaceRepo}/resolve/main/${gguf.filename}`;

    // § 17.5 RESUME: kısmi indirme varsa Range header ekle
    const storedBytes = await this._storage.storedBytes(gguf.filename);
    const headers: Record<string, string> = {};
    if (storedBytes > 0) {
      headers['Range']    = `bytes=${storedBytes}-`;
      headers['If-Range'] = gguf.filename;
    }

    let response: Response;
    try {
      response = await fetch(url, { signal, headers });
    } catch (e) {
      if (signal.aborted) return err(DownloadErrorCode.CANCELLED, 'Cancelled');
      return this._emitError(modelId, gguf.sizeMB, DownloadErrorCode.NETWORK_ERROR, String(e));
    }

    const isPartial = response.status === 206;
    if (!response.ok && !isPartial) {
      return this._emitError(
        modelId, gguf.sizeMB, DownloadErrorCode.NETWORK_ERROR, `HTTP ${response.status}`,
      );
    }

    const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10);
    const totalBytes    = isPartial ? storedBytes + contentLength : contentLength;
    const totalMB       = totalBytes > 0 ? totalBytes / (1024 * 1024) : gguf.sizeMB;
    let receivedBytes   = isPartial ? storedBytes : 0;
    const resumable     = isPartial;

    this._setState(modelId, {
      status: 'downloading', receivedMB: receivedBytes / (1024 * 1024),
      totalMB, percent: 0, resumable,
    });

    const reader = response.body?.getReader();
    if (!reader) return this._emitError(modelId, totalMB, DownloadErrorCode.NETWORK_ERROR, 'No body');

    try {
      while (true) {
        if (signal.aborted) { reader.cancel(); return err(DownloadErrorCode.CANCELLED, 'Cancelled'); }
        const { done, value } = await reader.read();
        if (done) break;

        await this._storage.appendChunk(gguf.filename, value);

        receivedBytes += value.byteLength;
        const receivedMB = receivedBytes / (1024 * 1024);
        const percent    = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0;
        this._setState(modelId, { status: 'downloading', receivedMB, totalMB, percent, resumable });
        this._eventBus.emit('model:download:progress', { modelId, receivedMB, totalMB, percent });
      }
    } catch (e) {
      if (signal.aborted) return err(DownloadErrorCode.CANCELLED, 'Cancelled');
      return this._emitError(modelId, totalMB, DownloadErrorCode.NETWORK_ERROR, String(e));
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }

    // § 47 CHECKSUM
    if (gguf.sha256) {
      this._setState(modelId, { status: 'verifying', receivedMB: totalMB, totalMB, percent: 100 });
      const actual = await this._storage.sha256(gguf.filename);
      if (actual && actual.toLowerCase() !== gguf.sha256.toLowerCase()) {
        const msg = `Checksum mismatch: expected ${gguf.sha256}, got ${actual}`;
        return this._emitError(modelId, totalMB, DownloadErrorCode.CHECKSUM_MISMATCH, msg);
      }
    }

    const localPath = this._storage.modelLocalPath(gguf.filename);
    this._setState(modelId, {
      status: 'complete', receivedMB: totalMB, totalMB, percent: 100, localPath,
    });
    this._eventBus.emit('model:download:complete', { modelId, localPath });
    return ok(localPath);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private _emitError(
    modelId: AIModelId,
    totalMB: number,
    code: string,
    message: string,
  ): Result<string> {
    this._setState(modelId, {
      status: 'error',
      receivedMB: this._states.get(modelId)?.receivedMB ?? 0,
      totalMB,
      percent: this._states.get(modelId)?.percent ?? 0,
      errorCode: code,
      errorMessage: message,
    });
    this._eventBus.emit('model:download:error', { modelId, code, message });
    return err(code, message);
  }

  private _setState(
    modelId: AIModelId,
    partial: Partial<Omit<DownloadState, 'modelId'>>,
  ): void {
    const current = this._states.get(modelId) ?? {
      modelId, status: 'idle' as DownloadStatus, receivedMB: 0, totalMB: 0, percent: 0,
    };
    this._states.set(modelId, { ...current, ...partial });
  }
}
