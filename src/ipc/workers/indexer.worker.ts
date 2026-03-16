// ─────────────────────────────────────────────────────────────
// ipc/workers/indexer.worker.ts
// File Watcher + Rebuild Plan Worker
//
// Sorumluluklar:
//   • Dosya değişikliklerini takip et (ana thread + native FS)
//   • Per-file debounce + batch birleştirme
//   • Değişiklik önceliğini hesapla (open > change > fs > close)
//   • Rebuild planı üret → ana thread'e gönder
//   • Ana thread planı language.worker'a iletir (worker'lar birbirini tanımıyor)
//
// Desteklenen mesajlar:
//   Lifecycle  : initialize, dispose
//   Documents  : document:open, document:change, document:close
//   Workspace  : workspace:index, index:rebuild
//   FS         : fs:change
//   Control    : cancel
//
// Phase 3 | v1.1.0
//
// v1.0 → v1.1 değişiklikleri:
//   [IW-1] Batch age kontrolü _scheduleFlush'tan çıkarıldı.
//          Bağımsız _maxAgeTimer debounce'dan ayrı çalışır —
//          ilk trigger'da kurulur, batch flush'ta temizlenir.
//   [IW-2] Delete batch breaker: önce mevcut batch flush,
//          ardından delete planı gönderilir — sıra garantisi.
//   [IW-3] mustIndex 500 dosyalık chunk'lara bölünür.
//          Her chunk ayrı index:plan notification'ı olarak gönderilir.
//
// Mimari not — Rebuild plan yürütme:
//   indexer.worker  →  index:plan notification  →  ana thread
//   ana thread      →  parseFile mesajı          →  language.worker
//   Neden: İki worker doğrudan haberleşmez; ana thread orchestrator.
// ─────────────────────────────────────────────────────────────

import type { UUID } from "../../core";

// ─────────────────────────────────────────────────────────────
// § 1. Protocol types
// ─────────────────────────────────────────────────────────────

type IndexWorkerMessageType =
  | "initialize"
  | "dispose"
  | "document:open"
  | "document:change"
  | "document:close"
  | "workspace:index"
  | "index:rebuild"
  | "fs:change"
  | "cancel";

interface IndexWorkerRequest<P = unknown> {
  readonly id:      string;
  readonly type:    IndexWorkerMessageType;
  readonly payload: P;
}

interface IndexWorkerResponse<T = unknown> {
  readonly id:         string;
  readonly type:       IndexWorkerMessageType;
  readonly ok:         boolean;
  readonly data?:      T;
  readonly error?:     IndexWorkerError;
  readonly cancelled?: true;
}

interface IndexWorkerError {
  readonly code:    string;
  readonly message: string;
}

interface IndexWorkerNotification<T = unknown> {
  readonly type:  "notification";
  readonly event: string;
  readonly data:  T;
}

// ─────────────────────────────────────────────────────────────
// § 2. Payload types
// ─────────────────────────────────────────────────────────────

interface InitializePayload {
  fileIds:   UUID[];
  projectId: UUID;
}

interface DocumentOpenPayload {
  fileId:  UUID;
  content: string;
  version: number;
}

interface DocumentChangePayload {
  fileId:  UUID;
  content: string;
  version: number;
}

interface DocumentClosePayload {
  fileId: UUID;
}

interface WorkspaceIndexPayload {
  fileIds?: UUID[];
  force?:   boolean;
}

interface IndexRebuildPayload {
  fileIds: UUID[];
  reason:  "edit" | "delete" | "rename";
}

interface FsChangePayload {
  fileId:     UUID;
  kind:       "created" | "modified" | "deleted" | "renamed";
  newFileId?: UUID;
  content?:   string;
}

interface CancelPayload {
  targetId: string;
}

// ─────────────────────────────────────────────────────────────
// § 3. Notification payload types
// ─────────────────────────────────────────────────────────────

export interface IndexPlanNotification {
  readonly trigger:    ReadonlyArray<IndexTrigger>;
  /** Topolojik sırayla yeniden index'lenecek dosyalar — max 500 */
  readonly mustIndex:  ReadonlyArray<UUID>;
  readonly mustDelete: ReadonlyArray<UUID>;
  readonly renames:    ReadonlyArray<{ oldId: UUID; newId: UUID }>;
  readonly batchId:    string;
  /** [IW-3] Chunk bilgisi: { index: 0, total: 3 } */
  readonly chunk:      { index: number; total: number };
}

// ─────────────────────────────────────────────────────────────
// § 4. Internal types
// ─────────────────────────────────────────────────────────────

type TriggerSource =
  | "document:open"
  | "document:change"
  | "fs:change"
  | "index:rebuild"
  | "workspace:index";

interface IndexTrigger {
  readonly fileId:    UUID;
  readonly source:    TriggerSource;
  readonly reason:    "edit" | "delete" | "rename" | "create" | "open" | "full";
  readonly content?:  string;
  readonly version?:  number;
  readonly newFileId?: UUID;
}

/** Düşük sayı = yüksek öncelik */
const TRIGGER_PRIORITY: Record<TriggerSource, number> = {
  "document:open":   0,
  "document:change": 1,
  "index:rebuild":   2,
  "fs:change":       3,
  "workspace:index": 4,
};

interface PendingBatch {
  triggers:      Map<UUID, IndexTrigger>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  // [IW-1] maxAgeTimer — debounce'dan bağımsız, ilk trigger'da kurulur
  maxAgeTimer:   ReturnType<typeof setTimeout> | null;
}

// ─────────────────────────────────────────────────────────────
// § 5. Constants
// ─────────────────────────────────────────────────────────────

const DEBOUNCE_MS: Record<TriggerSource, number> = {
  "document:open":   0,
  "document:change": 400,
  "fs:change":       200,
  "index:rebuild":   0,
  "workspace:index": 0,
};

// [IW-1] Batch'in debounce'a rağmen max bekleyeceği süre.
// Debounce'dan bağımsız timer ile kontrol edilir.
const MAX_BATCH_AGE_MS = 2000;

// [IW-3] Tek plan notification'ındaki max dosya sayısı
const MAX_FILES_PER_BATCH = 500;

// ─────────────────────────────────────────────────────────────
// § 6. Handler type
// ─────────────────────────────────────────────────────────────

type HandlerFn = (payload: unknown, requestId: string) => Promise<unknown>;

// ─────────────────────────────────────────────────────────────
// § 7. IndexerWorker
// ─────────────────────────────────────────────────────────────

class IndexerWorker {
  private _initialized  = false;
  private _cancelledIds = new Set<string>();
  private _knownFiles   = new Set<UUID>();
  private _openDocs     = new Map<UUID, { content: string; version: number }>();

  private _pending: PendingBatch = {
    triggers:      new Map(),
    debounceTimer: null,
    maxAgeTimer:   null,   // [IW-1]
  };

  private readonly _handlers: Record<IndexWorkerMessageType, HandlerFn>;

  constructor() {
    this._handlers = {
      initialize:        (p)  => this._initialize(p as InitializePayload),
      dispose:           ()   => this._dispose(),
      "document:open":   (p)  => this._documentOpen(p as DocumentOpenPayload),
      "document:change": (p)  => this._documentChange(p as DocumentChangePayload),
      "document:close":  (p)  => this._documentClose(p as DocumentClosePayload),
      "workspace:index": (p)  => this._workspaceIndex(p as WorkspaceIndexPayload),
      "index:rebuild":   (p)  => this._indexRebuild(p as IndexRebuildPayload),
      "fs:change":       (p)  => this._fsChange(p as FsChangePayload),
      cancel:            ()   => Promise.resolve(undefined),
    };
  }

  // ── Mesaj girişi ─────────────────────────────────────────────

  async handleMessage(req: IndexWorkerRequest): Promise<void> {
    if (req.type === "cancel") {
      this._cancelledIds.add((req.payload as CancelPayload).targetId);
      return;
    }

    if (this._cancelledIds.has(req.id)) {
      this._cancelledIds.delete(req.id);
      self.postMessage(cancelledResponse(req));
      return;
    }

    let response: IndexWorkerResponse;

    try {
      const data = await this._dispatch(req);

      if (this._cancelledIds.has(req.id)) {
        this._cancelledIds.delete(req.id);
        self.postMessage(cancelledResponse(req));
        return;
      }

      response = { id: req.id, type: req.type, ok: true, data };
    } catch (e: unknown) {
      response = {
        id:    req.id,
        type:  req.type,
        ok:    false,
        error: { code: "INDEXER_ERROR", message: errorMessage(e) },
      };
    }

    self.postMessage(response);
  }

  private async _dispatch(req: IndexWorkerRequest): Promise<unknown> {
    return this._handlers[req.type](req.payload, req.id);
  }

  // ─────────────────────────────────────────────────────────────
  // § 8. Lifecycle handlers
  // ─────────────────────────────────────────────────────────────

  private async _initialize(p: InitializePayload): Promise<{ ok: boolean; fileCount: number }> {
    if (this._initialized) return { ok: true, fileCount: this._knownFiles.size };

    for (const id of p.fileIds) this._knownFiles.add(id);
    this._initialized = true;

    return { ok: true, fileCount: this._knownFiles.size };
  }

  private async _dispose(): Promise<{ ok: boolean }> {
    this._clearBatchTimers();
    this._pending.triggers.clear();
    this._openDocs.clear();
    this._initialized = false;
    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────
  // § 9. Document event handlers
  // ─────────────────────────────────────────────────────────────

  private async _documentOpen(p: DocumentOpenPayload): Promise<{ ok: boolean }> {
    this._guardInit("document:open");

    this._knownFiles.add(p.fileId);
    this._openDocs.set(p.fileId, { content: p.content, version: p.version });

    this._enqueueTrigger({
      fileId:  p.fileId,
      source:  "document:open",
      reason:  "open",
      content: p.content,
      version: p.version,
    });

    return { ok: true };
  }

  private async _documentChange(p: DocumentChangePayload): Promise<{ ok: boolean }> {
    this._guardInit("document:change");

    const existing = this._openDocs.get(p.fileId);
    if (existing && p.version <= existing.version) return { ok: true };

    this._openDocs.set(p.fileId, { content: p.content, version: p.version });

    this._enqueueTrigger({
      fileId:  p.fileId,
      source:  "document:change",
      reason:  "edit",
      content: p.content,
      version: p.version,
    });

    return { ok: true };
  }

  private async _documentClose(p: DocumentClosePayload): Promise<{ ok: boolean }> {
    this._openDocs.delete(p.fileId);
    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────
  // § 10. Workspace & rebuild handlers
  // ─────────────────────────────────────────────────────────────

  private async _workspaceIndex(
    p: WorkspaceIndexPayload
  ): Promise<{ ok: boolean; queued: number }> {
    this._guardInit("workspace:index");

    const targets = p.fileIds?.length ? p.fileIds : [...this._knownFiles];
    if (targets.length === 0) return { ok: true, queued: 0 };

    for (const fileId of targets) {
      this._enqueueTrigger(
        { fileId, source: "workspace:index", reason: "full" },
        /* skipSchedule */ true,
      );
    }

    this._scheduleFlush("workspace:index");
    return { ok: true, queued: targets.length };
  }

  private async _indexRebuild(
    p: IndexRebuildPayload
  ): Promise<{ ok: boolean; queued: number }> {
    this._guardInit("index:rebuild");

    for (const fileId of p.fileIds) {
      this._enqueueTrigger(
        { fileId, source: "index:rebuild", reason: p.reason },
        /* skipSchedule */ true,
      );
    }

    this._scheduleFlush("index:rebuild");
    return { ok: true, queued: p.fileIds.length };
  }

  // ─────────────────────────────────────────────────────────────
  // § 11. FS change handler
  // ─────────────────────────────────────────────────────────────

  private async _fsChange(p: FsChangePayload): Promise<{ ok: boolean }> {
    this._guardInit("fs:change");

    switch (p.kind) {
      case "created":
        this._knownFiles.add(p.fileId);
        this._enqueueTrigger({
          fileId:  p.fileId,
          source:  "fs:change",
          reason:  "create",
          content: p.content,
        });
        break;

      case "modified":
        // Editörde açıksa yoksay — document:change daha güncel
        if (!this._openDocs.has(p.fileId)) {
          this._enqueueTrigger({
            fileId:  p.fileId,
            source:  "fs:change",
            reason:  "edit",
            content: p.content,
          });
        }
        break;

      // [IW-2] Delete & rename batch breaker:
      // Önce mevcut batch'i flush et (sıra garantisi),
      // ardından kendi planını gönder.
      case "deleted":
        this._knownFiles.delete(p.fileId);
        this._openDocs.delete(p.fileId);
        this._pending.triggers.delete(p.fileId);
        // Bekleyen varsa önce onları gönder
        this._flushBatchIfPending();
        // Sonra delete planını gönder
        this._emitDeletePlan(p.fileId);
        break;

      case "renamed":
        if (!p.newFileId) break;
        this._knownFiles.delete(p.fileId);
        this._knownFiles.add(p.newFileId);
        // Bekleyen varsa önce onları gönder
        this._flushBatchIfPending();
        // Sonra rename planını gönder
        this._emitRenamePlan(p.fileId, p.newFileId);
        break;
    }

    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────
  // § 12. Trigger enqueue & debounce
  // ─────────────────────────────────────────────────────────────

  private _enqueueTrigger(trigger: IndexTrigger, skipSchedule = false): void {
    const existing = this._pending.triggers.get(trigger.fileId);

    if (existing) {
      const existingPrio = TRIGGER_PRIORITY[existing.source];
      const newPrio      = TRIGGER_PRIORITY[trigger.source];

      if (newPrio <= existingPrio) {
        // Yeni daha öncelikli — replace et, içeriği koru
        this._pending.triggers.set(trigger.fileId, {
          ...trigger,
          content: trigger.content ?? existing.content,
        });
      } else {
        // Mevcut daha öncelikli — sadece içeriği güncelle
        if (trigger.content !== undefined) {
          this._pending.triggers.set(trigger.fileId, {
            ...existing,
            content: trigger.content,
            version: trigger.version ?? existing.version,
          });
        }
      }
    } else {
      this._pending.triggers.set(trigger.fileId, trigger);

      // [IW-1] İlk trigger geldiğinde maxAgeTimer'ı kur.
      // Bu timer debounce'dan bağımsız — ne kadar debounce
      // uzasa da MAX_BATCH_AGE_MS sonra batch kesinlikle flush edilir.
      if (this._pending.maxAgeTimer === null) {
        this._pending.maxAgeTimer = setTimeout(() => {
          this._pending.maxAgeTimer = null;
          this._flushBatch();
        }, MAX_BATCH_AGE_MS);
      }
    }

    if (!skipSchedule) {
      this._scheduleFlush(trigger.source);
    }
  }

  /**
   * [IW-1] _scheduleFlush artık sadece debounce yönetir.
   * Batch age kontrolü _enqueueTrigger içindeki maxAgeTimer'a taşındı.
   */
  private _scheduleFlush(source: TriggerSource): void {
    const delay = DEBOUNCE_MS[source];

    if (delay === 0) {
      // Yüksek öncelikli kaynak — anında flush
      if (this._pending.debounceTimer !== null) {
        clearTimeout(this._pending.debounceTimer);
        this._pending.debounceTimer = null;
      }
      this._flushBatch();
      return;
    }

    // Debounce: önceki timer'ı iptal et, yenisini kur
    if (this._pending.debounceTimer !== null) {
      clearTimeout(this._pending.debounceTimer);
    }

    this._pending.debounceTimer = setTimeout(() => {
      this._pending.debounceTimer = null;
      this._flushBatch();
    }, delay);
  }

  // ─────────────────────────────────────────────────────────────
  // § 13. Batch flush
  // ─────────────────────────────────────────────────────────────

  private _flushBatch(): void {
    if (this._pending.triggers.size === 0) return;

    const triggers = [...this._pending.triggers.values()];

    // Batch'i sıfırla
    this._clearBatchTimers();
    this._pending.triggers.clear();

    // Plan oluştur ve chunk'la
    this._buildAndEmitPlan(triggers);
  }

  /**
   * [IW-2] Sadece pending varsa flush — delete/rename öncesi sıra garantisi.
   */
  private _flushBatchIfPending(): void {
    if (this._pending.triggers.size > 0) {
      this._flushBatch();
    }
  }

  /**
   * [IW-2] Batch breaker: delete planını bağımsız emit et.
   */
  private _emitDeletePlan(fileId: UUID): void {
    const batchId = generateBatchId();
    const plan: IndexPlanNotification = {
      trigger:    [{ fileId, source: "fs:change", reason: "delete" }],
      mustIndex:  [],
      mustDelete: [fileId],
      renames:    [],
      batchId,
      chunk:      { index: 0, total: 1 },
    };
    this._postNotification("index:plan", plan);
  }

  /**
   * [IW-2] Batch breaker: rename planını bağımsız emit et.
   */
  private _emitRenamePlan(oldId: UUID, newId: UUID): void {
    const batchId = generateBatchId();
    const plan: IndexPlanNotification = {
      trigger:    [{ fileId: oldId, source: "fs:change", reason: "rename", newFileId: newId }],
      mustIndex:  [newId],
      mustDelete: [oldId],
      renames:    [{ oldId, newId }],
      batchId,
      chunk:      { index: 0, total: 1 },
    };
    this._postNotification("index:plan", plan);
  }

  // ─────────────────────────────────────────────────────────────
  // § 14. Plan builder + chunking
  // ─────────────────────────────────────────────────────────────

  /**
   * [IW-3] mustIndex 500'lük chunk'lara bölünür.
   * Her chunk için ayrı index:plan notification gönderilir.
   * mustDelete ve renames sadece ilk chunk'ta bulunur.
   *
   * Phase 3.5: DependencyIndex inject edilince mustIndex
   * topological order ile genişleyecek.
   */
  private _buildAndEmitPlan(triggers: IndexTrigger[]): void {
    // Önceliğe göre sırala
    const sorted = [...triggers].sort((a, b) =>
      TRIGGER_PRIORITY[a.source] - TRIGGER_PRIORITY[b.source]
    );

    const mustIndex:  UUID[] = [];
    const mustDelete: UUID[] = [];
    const renames:    Array<{ oldId: UUID; newId: UUID }> = [];

    for (const t of sorted) {
      if (t.reason === "delete") {
        mustDelete.push(t.fileId);
      } else if (t.reason === "rename" && t.newFileId) {
        mustDelete.push(t.fileId);
        mustIndex.push(t.newFileId);
        renames.push({ oldId: t.fileId, newId: t.newFileId });
      } else {
        mustIndex.push(t.fileId);
      }
    }

    const uniqueIndex  = dedupe(mustIndex);
    const uniqueDelete = dedupe(mustDelete);

    // [IW-3] mustIndex'i chunk'lara böl
    const chunks  = chunkArray(uniqueIndex, MAX_FILES_PER_BATCH);
    const total   = Math.max(chunks.length, 1);
    const batchId = generateBatchId();

    if (chunks.length === 0) {
      // Sadece delete/rename varsa tek plan gönder
      const plan: IndexPlanNotification = {
        trigger:    sorted,
        mustIndex:  [],
        mustDelete: uniqueDelete,
        renames,
        batchId,
        chunk: { index: 0, total: 1 },
      };
      this._postNotification("index:plan", plan);
      return;
    }

    for (let i = 0; i < chunks.length; i++) {
      const plan: IndexPlanNotification = {
        trigger:    sorted,
        mustIndex:  chunks[i],
        // mustDelete ve renames sadece ilk chunk'ta — tekrar işlenmesin
        mustDelete: i === 0 ? uniqueDelete : [],
        renames:    i === 0 ? renames      : [],
        batchId,
        chunk: { index: i, total },
      };
      this._postNotification("index:plan", plan);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // § 15. Guards & helpers
  // ─────────────────────────────────────────────────────────────

  private _guardInit(caller: string): void {
    if (!this._initialized) {
      throw new Error(`IndexerWorker not initialized (caller: ${caller})`);
    }
  }

  /**
   * [IW-1] Her iki timer'ı da temizle — dispose ve flush'ta çağrılır.
   */
  private _clearBatchTimers(): void {
    if (this._pending.debounceTimer !== null) {
      clearTimeout(this._pending.debounceTimer);
      this._pending.debounceTimer = null;
    }
    if (this._pending.maxAgeTimer !== null) {
      clearTimeout(this._pending.maxAgeTimer);
      this._pending.maxAgeTimer = null;
    }
  }

  private _postNotification<T>(event: string, data: T): void {
    const msg: IndexWorkerNotification<T> = { type: "notification", event, data };
    self.postMessage(msg);
  }
}

// ─────────────────────────────────────────────────────────────
// § 16. Worker bootstrap
// ─────────────────────────────────────────────────────────────

const worker = new IndexerWorker();

self.addEventListener("message", (event: MessageEvent<IndexWorkerRequest>) => {
  worker.handleMessage(event.data).catch(e => {
    console.error("[IndexerWorker] unhandled:", e);
  });
});

// ─────────────────────────────────────────────────────────────
// § 17. Utilities
// ─────────────────────────────────────────────────────────────

function cancelledResponse(req: IndexWorkerRequest): IndexWorkerResponse {
  return { id: req.id, type: req.type, ok: false, cancelled: true };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function generateBatchId(): string {
  return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** [IW-3] Diziyi n'lik parçalara böler */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
