// ─────────────────────────────────────────────────────────────
// language-services/SymbolIndex.ts
// Public API koordinatörü — Language Intelligence sistemi
//
// SymbolGraph + DependencyIndex + ReferenceIndex orkestrasyonu
// Phase 3 | v1.2.0
// ─────────────────────────────────────────────────────────────

import type { UUID, Result, IEventBus, AppEventMap } from "../core";
import { ok, err, tryResultAsync, ErrorCode } from "../core";

import type { ILevelDB, ISQLiteDriver } from "./storage/GraphStorage";
import { GraphStorage as GraphStorageImpl } from "./storage/GraphStorage";

import { SymbolGraph } from "./graph/SymbolGraph";
import {
  DependencyIndex,
  type IPathResolver,
  type RebuildPlan
} from "./graph/DependencyIndex";

import {
  ReferenceIndex,
  type CursorContext,
  type DefinitionResult,
  type FindReferencesResult,
  type HoverInfo,
  type RenameCandidate
} from "./graph/ReferenceIndex";

import type {
  SymbolNode,
  FileSnapshot,
  GraphStats,
  SymbolMatch,
  Checksum32,
} from "./graph/types";

import { fnv1a } from "../utils/fnv1a";

// ── Ek ErrorCode'lar ─────────────────────────────────────────

export const SymbolIndexErrorCode = {
  SYMBOL_NOT_FOUND:  "SYMBOL_NOT_FOUND"  as import("../types/core").ErrorCode,
  INDEX_READ_FAILED:  "INDEX_READ_FAILED"  as import("../types/core").ErrorCode,
  INDEX_WRITE_FAILED: "INDEX_WRITE_FAILED" as import("../types/core").ErrorCode,
  POS_CACHE_INVALID:  "POS_CACHE_INVALID"  as import("../types/core").ErrorCode,
} as const;


// ── Indexer'dan gelen parse sonucu ───────────────────────────

export interface ParsedFile {
  readonly fileId: UUID;
  readonly version: number;
  readonly content: string;

  readonly symbols: ReadonlyArray<Omit<SymbolNode, "checksum" | "version">>;

  readonly rawImports: ReadonlyArray<{
    specifier: string;
    names: string[];
    kind: import("./graph/types").EdgeKind;
    line: number;
  }>;

  readonly refs: ReadonlyArray<import("./graph/types").ReferenceLocation>;
}


// ── SymbolIndex ──────────────────────────────────────────────

export class SymbolIndex {

  private readonly _storage: GraphStorageImpl;
  private readonly _graph: SymbolGraph;
  private readonly _deps: DependencyIndex;
  private readonly _refs: ReferenceIndex;
  private readonly _eventBus: IEventBus;

  /** LevelDB instance (patch T-2 için gerekli) */
  private readonly _ldb: ILevelDB;

  /** pos cache key set */
  private readonly _posCacheKeys = new Set<string>();

  private _initialized = false;

  constructor(
    level: ILevelDB,
    sql: ISQLiteDriver,
    resolver: IPathResolver,
    eventBus: IEventBus
  ) {

    this._storage = new GraphStorageImpl(level, sql);
    this._graph = new SymbolGraph(this._storage, eventBus);
    this._deps = new DependencyIndex(this._storage, this._graph, resolver);
    this._refs = new ReferenceIndex(this._storage, this._graph);

    this._eventBus = eventBus;
    this._ldb = level;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async init(existingFileIds: ReadonlyArray<UUID> = []): Promise<Result<void>> {

    if (this._initialized) return ok(undefined);

    const storageResult = await this._storage.init();

    if (!storageResult.ok) {
      return err(
        ErrorCode.STORAGE_INIT,
        "SymbolIndex storage init failed",
        { cause: storageResult.error }
      );
    }

    if (existingFileIds.length > 0) {
      await this._graph.hydrate(existingFileIds);
    }

    this._initialized = true;

    this.safeEmit("language:ready", {
      languages: ["javascript", "typescript"]
    });

    return ok(undefined);
  }

  async dispose(): Promise<void> {
    await this._storage.dispose();
    this._initialized = false;
  }

  // ── Ana indexleme API'si ───────────────────────────────────

  async indexFile(parsed: ParsedFile): Promise<Result<void>> {

    if (!this._initialized) {
      return err(ErrorCode.STORAGE_INIT, "Not initialized");
    }

    const startTime = Date.now();

    this.safeEmit("index:started", {
      fileId: parsed.fileId
    });

    // 1. Import resolve

    const depsResult = await this._deps.resolveImports(
      parsed.fileId,
      parsed.rawImports
    );

    if (!depsResult.ok) {

      this.safeEmit("index:error", {
        fileId: parsed.fileId,
        error: depsResult.error
      });

      return depsResult;
    }

    // 2. Symbol checksum

    const symbols: SymbolNode[] = parsed.symbols.map((sym: Omit<SymbolNode, 'version' | 'checksum'>) => ({
      ...sym,
      checksum: fnv1a(
        `${sym.fileId}:${sym.name}:${sym.line}:${sym.col}`
      ) as Checksum32,
      version: 1
    }));


    // 3. Snapshot

    const snapshot: FileSnapshot = {

      fileId: parsed.fileId,
      version: parsed.version,

      checksum: fnv1a(parsed.content) as Checksum32,

      symbols,
      deps: depsResult.data,
      refs: parsed.refs,

      parsedAt: startTime
    };


    // 4. Graph apply

    const applyResult = await this._graph.applySnapshot(snapshot);

    if (!applyResult.ok) {

      this.safeEmit("index:error", {
        fileId: parsed.fileId,
        error: applyResult.error
      });

      return applyResult;
    }

    // 5. Position cache

    this._refs.buildPosCache(parsed.fileId);
    this._posCacheKeys.add(parsed.fileId);

    this.safeEmit("index:finished", {
      fileId: parsed.fileId,
      durationMs: Date.now() - startTime,
      symbolCount: symbols.length
    });

    return ok(undefined);
  }

  // ── Public Cache API (T-1) ──────────────────────────────────

  async invalidatePosCache(fileId: UUID): Promise<Result<void>> {

    return tryResultAsync(async () => {

      await this._ldb.del(`snap:${fileId}`);

      this._posCacheKeys.delete(fileId);

      this._refs.invalidatePosCache(fileId);

    }, SymbolIndexErrorCode.POS_CACHE_INVALID,
       `Failed to invalidate pos cache for: ${fileId}`);
  }

  // ── File events ─────────────────────────────────────────────

  async onFileChanged(fileId: UUID): Promise<Result<RebuildPlan>> {

    await this.invalidatePosCache(fileId);

    await this._graph.invalidateFile(fileId, "edit");

    return this._deps.buildRebuildPlan(fileId, "edit");
  }

  async onFileDeleted(fileId: UUID): Promise<Result<void>> {

    await this.invalidatePosCache(fileId);

    return this._graph.invalidateFile(fileId, "delete");
  }

  async onFileRenamed(oldId: UUID, newId: UUID): Promise<Result<void>> {

    await this.invalidatePosCache(oldId);

    const result = await this._graph.invalidateFile(oldId, "rename");

    if (!result.ok) return result;

    if (typeof (this._deps as any).onFileRenamed === "function") {
      await (this._deps as any).onFileRenamed(oldId, newId);
    }

    return ok(undefined);
  }

  // ── Editor Features ─────────────────────────────────────────

  async findDefinition(
    ctx: CursorContext
  ): Promise<Result<DefinitionResult | null>> {

    return this._refs.findDefinition(ctx);
  }

  async findAllReferences(
    ctx: CursorContext,
    opts?: { includeDeclaration?: boolean }
  ): Promise<Result<FindReferencesResult | null>> {

    return this._refs.findAllReferences(ctx, opts);
  }

  async getHoverInfo(
    ctx: CursorContext
  ): Promise<Result<HoverInfo | null>> {

    return this._refs.getHoverInfo(ctx);
  }

  async prepareRename(
    ctx: CursorContext
  ): Promise<Result<RenameCandidate | null>> {

    return this._refs.prepareRename(ctx);
  }

  // ── Symbol lookup (T-2) ─────────────────────────────────────

  async getSymbol(symbolId: string): Promise<Result<SymbolNode | null>> {

    return tryResultAsync(async () => {

      const raw = await this._ldb.get(`gsym:${symbolId}`);

      if (!raw) return null;

      return JSON.parse(raw) as SymbolNode;

    }, SymbolIndexErrorCode.INDEX_READ_FAILED,
       `Failed to get symbol: ${symbolId}`);
  }

  // ── Arama ───────────────────────────────────────────────────

  async searchSymbols(
    query: string,
    opts?: {
      kind?: import("./graph/types").SymbolKind;
      limit?: number;
    }
  ): Promise<Result<ReadonlyArray<SymbolMatch>>> {

    return tryResultAsync(async () => {

      const result = await this._storage.findSymbolsByName(query, {
        kind: opts?.kind
      });

      if (!result.ok) return [];

      return result.data
        .map((sym: Omit<SymbolNode, 'version' | 'checksum'>) => ({
          symbol: { ...sym, checksum: 0 as Checksum32, version: 0 },
          fileId: sym.fileId,
          score: fuzzyScore(query, sym.name)
        }))
        .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
        .slice(0, opts?.limit ?? 50);

    }, ErrorCode.INDEX_FAILED, `searchSymbols failed: ${query}`);
  }

  // ── Graph queries ───────────────────────────────────────────

  getDirectDeps(fileId: UUID) {
    return this._graph.getDirectDeps(fileId);
  }

  getDirectDependants(fileId: UUID) {
    return this._graph.getDirectDependants(fileId);
  }

  getTransitiveDeps(fileId: UUID) {
    return this._graph.getTransitiveDeps(fileId);
  }

  getImpactedFiles(fileId: UUID) {
    return this._graph.getImpactedFiles(fileId);
  }

  getFileSymbols(fileId: UUID) {
    return this._graph.getFileSymbols(fileId);
  }

  async topoSort(fileIds: ReadonlyArray<UUID>) {
    return this._deps.topoSort(fileIds);
  }

  async getStats(): Promise<Result<GraphStats>> {
    return this._storage.getStats();
  }

  // ── EventBus ────────────────────────────────────────────────

  private safeEmit<K extends keyof AppEventMap>(
    event: K,
    payload: AppEventMap[K]
  ) {

    try {
      this._eventBus.emit(event, payload);
    } catch {
      // ignore listener errors
    }
  }
}


// ── Fuzzy search score ───────────────────────────────────────

function fuzzyScore(query: string, target: string): number {

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  if (t === q) return 1.0;
  if (t.startsWith(q)) return 0.9;
  if (t.includes(q)) return 0.7;

  let qi = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }

  return qi === q.length ? 0.5 : 0.0;
}