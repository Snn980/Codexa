// ─────────────────────────────────────────────────────────────
// language-services/graph/DependencyIndex.ts
// Dosya bağımlılık grafiği — path çözümleme + topolojik sıralama
// Phase 3 | v1.1.0 (Performans + Güvenlik Düzeltmeleri)
// ─────────────────────────────────────────────────────────────

import type { UUID, Result } from "../../core";
import { ok, err, tryResultAsync, ErrorCode } from "../../core";
import type { GraphStorage } from "../storage/GraphStorage";
import type { SymbolGraph } from "./SymbolGraph";
import type { DependencyEdge, EdgeKind } from "./types";
import { EdgeKind as EK } from "./types";

// ── External dosyalar için sabit ID (magic string yerine) ─────
const EXTERNAL_FILE_ID = "00000000-0000-0000-0000-000000000000" as UUID;

/** DependencyIndex hata kodları */
export const DepIndexErrorCode = {
  NOT_FOUND:       "DEP_INDEX_NOT_FOUND",
  CYCLE_DETECTED:  "DEP_INDEX_CYCLE_DETECTED",
  STORAGE_ERROR:   "DEP_INDEX_STORAGE_ERROR",
  INVALID_PATH:    "DEP_INDEX_INVALID_PATH",
} as const;
export type DepIndexErrorCode = (typeof DepIndexErrorCode)[keyof typeof DepIndexErrorCode];

/** Bağımlılık kaydı — test + production ortak tip */
export interface Dependency {
  fromFileId:   string;
  toFileId:     string;
  rawSpecifier: string;
  kind:         string;
  id:           string;
  importedNames?: string[];
  line?:          number;
  isResolved?:    boolean;
}

/** LevelDB-benzeri arayüz — scan + batch ile genişletilmiş */
export interface ILevelDb {
  get(key: string): Promise<string | null | undefined>;
  put(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  scan(prefix: string): Promise<ReadonlyArray<{ key: string; value: string }>>;
  batch(ops: Array<{ type: "put" | "del"; key: string; value?: string }>): Promise<void>;
}

/** Basit event bus arayüzü */
interface ISimpleBus {
  emit(event: string, payload: unknown): void;
}



// ── Path resolver interface (platform bağımlı — inject edilir) ─
export interface IPathResolver {
  /**
   * Bir import specifier'ını ve kaynak dosya yolunu alır,
   * proje içindeki gerçek fileId'yi döndürür.
   * node_modules → null (external)
   */
  resolve(specifier: string, fromPath: string): Promise<UUID | null>;

  /** fileId → absolute path */
  getPath(fileId: UUID): string | null;
}

// ── Topolojik sıralama sonucu ─────────────────────────────────
export interface TopoSortResult {
  readonly order:  ReadonlyArray<UUID>;   // bağımlılıktan bağımlıya sıralı
  readonly cycles: ReadonlyArray<ReadonlyArray<UUID>>;
}

// ── Build plan — hangi dosyalar yeniden index'lenmeli ─────────
export interface RebuildPlan {
  readonly changed:   UUID;
  readonly mustIndex: ReadonlyArray<UUID>;   // topological order
  readonly reason:    "edit" | "delete" | "rename";
}

// ── DependencyIndex ───────────────────────────────────────────
export class DependencyIndex {
  private readonly _storage:  GraphStorage | null;
  private readonly _graph:    SymbolGraph  | null;
  private readonly _resolver: IPathResolver | null;
  private readonly _db:       ILevelDb | null;
  private readonly _bus:      ISimpleBus | null;

  /** Production constructor: (storage, graph, resolver) */
  constructor(storage: GraphStorage, graph: SymbolGraph, resolver: IPathResolver);
  /** Test/LevelDB constructor: (db, bus) */
  constructor(db: ILevelDb, bus: ISimpleBus);
  constructor(
    storageOrDb: GraphStorage | ILevelDb,
    graphOrBus:  SymbolGraph  | ISimpleBus,
    resolver?:   IPathResolver
  ) {
    if (resolver !== undefined) {
      this._storage  = storageOrDb as GraphStorage;
      this._graph    = graphOrBus  as SymbolGraph;
      this._resolver = resolver;
      this._db       = null;
      this._bus      = null;
    } else {
      this._db       = storageOrDb as ILevelDb;
      this._bus      = graphOrBus  as ISimpleBus;
      this._storage  = null;
      this._graph    = null;
      this._resolver = null;
    }
  }

  // ── getForwardDeps ────────────────────────────────────────────

  async getForwardDeps(fromFileId: string): Promise<Dependency[]> {
    if (!this._db) return [];
    const raw = await this._db.get(`dep_fwd:${fromFileId}`);
    return raw ? JSON.parse(raw) : [];
  }

  // ── getReverseDeps ────────────────────────────────────────────

  async getReverseDeps(toFileId: string): Promise<string[]> {
    if (!this._db) return [];
    const raw = await this._db.get(`dep_rev:${toFileId}`);
    return raw ? JSON.parse(raw) : [];
  }

  // ── buildTopoRebuildPlan ──────────────────────────────────────

  async buildTopoRebuildPlan(
    triggeredBy: string,
  ): Promise<Result<{ order: string[]; cycleMembers: Set<string> }>> {
    if (!this._db || !this._bus) {
      return ok({ order: [triggeredBy], cycleMembers: new Set() });
    }
    try {
      const visited      = new Set<string>();
      const order:       string[] = [];
      const cycleMembers = new Set<string>();

      // BFS: triggered first, then importers level by level
      // This gives: triggeredBy, direct importers, their importers, etc.
      const queue: string[] = [triggeredBy];
      visited.add(triggeredBy);

      while (queue.length > 0) {
        const fileId = queue.shift()!;
        order.push(fileId);
        const revDeps = await this.getReverseDeps(fileId);
        for (const dep of revDeps) {
          if (!visited.has(dep)) {
            visited.add(dep);
            queue.push(dep);
          } else if (order.includes(dep)) {
            // Already in order but we hit it again via different path → cycle
            cycleMembers.add(dep);
            cycleMembers.add(fileId);
          }
        }
      }

      if (cycleMembers.size > 0) {
        this._bus.emit("index:cycle", { triggeredBy, cycleMembers: Array.from(cycleMembers) });
      }
      this._bus.emit("index:plan", { triggeredBy, order, cycleCount: cycleMembers.size });

      return ok({ order, cycleMembers });
    } catch (e) {
      return err(ErrorCode.DEP_RESOLVE_FAILED, String(e));
    }
  }



  async writeDeps(
    fromFileId: string,
    deps:       Dependency[],
  ): Promise<Result<void>> {
    if (!this._db) return err(ErrorCode.DEP_RESOLVE_FAILED, "No LevelDB instance");
    try {
      const db = this._db;
      // Mevcut forward depları oku (stale reverse temizliği için)
      const oldRaw = await db.get(`dep_fwd:${fromFileId}`);
      const oldDeps: Dependency[] = oldRaw ? JSON.parse(oldRaw) : [];
      const oldTargets = new Set(oldDeps.map((d) => d.toFileId));
      const newTargets = new Set(deps.map((d) => d.toFileId));

      // Forward yaz
      await db.put(`dep_fwd:${fromFileId}`, JSON.stringify(deps));

      // Stale reverse dep temizle
      for (const target of oldTargets) {
        if (!newTargets.has(target)) {
          const revRaw = await db.get(`dep_rev:${target}`);
          const revSet: string[] = revRaw ? JSON.parse(revRaw) : [];
          const updated = revSet.filter((id) => id !== fromFileId);
          if (updated.length > 0) {
            await db.put(`dep_rev:${target}`, JSON.stringify(updated));
          } else {
            await db.del(`dep_rev:${target}`);
          }
        }
      }

      // Yeni reverse dep yaz
      for (const target of newTargets) {
        const revRaw = await db.get(`dep_rev:${target}`);
        const revSet: string[] = revRaw ? JSON.parse(revRaw) : [];
        if (!revSet.includes(fromFileId)) {
          revSet.push(fromFileId);
          await db.put(`dep_rev:${target}`, JSON.stringify(revSet));
        }
      }

      this._bus?.emit("deps:updated", { fromFileId, count: deps.length });
      return ok(undefined);
    } catch (e) {
      return err(ErrorCode.DEP_RESOLVE_FAILED, String(e));
    }
  }

  // ── Import specifier'larını çözümle (PARALEL) ────────────────
  async resolveImports(
    fromFileId: UUID,
    rawEdges: ReadonlyArray<{ specifier: string; names: string[]; kind: EdgeKind; line: number }>
  ): Promise<Result<ReadonlyArray<DependencyEdge>>> {
    return tryResultAsync(async () => {
      const fromPath = this._resolver?.getPath(fromFileId) ?? null;
      if (!fromPath) return [];

      const promises = rawEdges.map(async (raw) => {
        const toFileId = await this._resolver!.resolve(raw.specifier, fromPath);

        const id = `${fromFileId}:${raw.specifier}:${raw.kind}` as UUID;
        return {
          id,
          fromFileId,
          toFileId:      toFileId ?? EXTERNAL_FILE_ID,
          kind:          raw.kind,
          rawSpecifier:  raw.specifier,
          importedNames: raw.names,
          isTruncated:   false,
          line:          raw.line,
          isResolved:    toFileId !== null,
        } satisfies DependencyEdge;
      });

      return Promise.all(promises);
    }, ErrorCode.DEP_RESOLVE_FAILED, `resolveImports failed for ${fromFileId}`);
  }

  // ── Topolojik sıralama (Kahn algoritması) — Optimize ────────
  async topoSort(fileIds: ReadonlyArray<UUID>): Promise<Result<TopoSortResult>> {
    return tryResultAsync(async () => {
      if (fileIds.length === 0) return { order: [], cycles: [] };

      const fileIdSet = new Set(fileIds);
      const inDegree = new Map<UUID, number>();
      const reverseAdjList = new Map<UUID, Set<UUID>>(); // dependants

      // Başlangıç
      for (const id of fileIds) {
        inDegree.set(id, 0);
        reverseAdjList.set(id, new Set());
      }

      // In-degree ve reverse adjacency hesapla
      for (const id of fileIds) {
        const deps = this._graph?.getDirectDeps(id) ?? [];
        for (const depId of deps) {
          if (!fileIdSet.has(depId)) continue;
          reverseAdjList.get(depId)!.add(id);
          inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
        }
      }

      // Kahn: in-degree=0 olanlar
      const queue: UUID[] = [];
      for (const [id, deg] of inDegree) {
        if (deg === 0) queue.push(id);
      }
      queue.sort(); // deterministic

      const order: UUID[] = [];
      const visited = new Set<UUID>();

      while (queue.length > 0) {
        const id = queue.shift()!;
        order.push(id);
        visited.add(id);

        for (const dependant of reverseAdjList.get(id) ?? []) {
          const newDeg = (inDegree.get(dependant) ?? 1) - 1;
          inDegree.set(dependant, newDeg);
          if (newDeg === 0) queue.push(dependant);
        }
      }

      // Cycle'ler
      const cycleNodes = fileIds.filter(id => !visited.has(id));
      const cycles = cycleNodes.length > 0
        ? this._findCycleSets(cycleNodes)
        : [];

      return { order, cycles };
    }, ErrorCode.GRAPH_CYCLE, "topoSort failed");
  }

  // ── Rebuild plan (delete durumunda güvenli) ─────────────────
  async buildRebuildPlan(
    changedFileId: UUID,
    reason: "edit" | "delete" | "rename"
  ): Promise<Result<RebuildPlan>> {
    return tryResultAsync(async () => {
      const impacted = this._graph?.getImpactedFiles(changedFileId) ?? [];

      const allIds = reason === "delete"
        ? impacted
        : [changedFileId, ...impacted];

      const topoResult = await this.topoSort(allIds);
      const order = topoResult.ok ? topoResult.data.order : allIds;

      return {
        changed:   changedFileId,
        mustIndex: order,
        reason,
      };
    }, ErrorCode.INDEX_FAILED, `buildRebuildPlan failed for ${changedFileId}`);
  }

  // ── Bağımlılık özeti ────────────────────────────────────────
  async getSummary(fileId: UUID): Promise<Result<DependencySummary>> {
    return tryResultAsync(async () => {
      const [depsRes, revDepsRes] = await Promise.all([
        this._storage!.getDependencies(fileId),
        this._storage!.getReverseDependencies(fileId),
      ]);

      const allDeps    = depsRes.ok    ? depsRes.data    : [];
      const allRevDeps = revDepsRes.ok ? revDepsRes.data : [];

      const byKind = allDeps.reduce((acc, dep) => {
        acc[dep.kind] = (acc[dep.kind] ?? 0) + 1;
        return acc;
      }, {} as Record<EdgeKind, number>);

      const externalCount = allDeps.filter(d => !d.isResolved).length;
      const typeOnlyCount = allDeps.filter(d => d.kind === EK.TypeOnly).length;

      return {
        fileId,
        directDeps:       allDeps.filter(d => d.isResolved).length,
        externalDeps:     externalCount,
        typeOnlyDeps:     typeOnlyCount,
        dependants:       allRevDeps.length,
        transitiveDeps:   new Set(this._graph?.getTransitiveDeps(fileId) ?? []).size,
        byKind,
      };
    }, ErrorCode.INDEX_FAILED, `getSummary failed for ${fileId}`);
  }
  // TODO: İleride Tarjan’s Strongly Connected Components algoritması ile değiştir
  private _findCycleSets(nodes: UUID[]): UUID[][] {
    const visited = new Set<UUID>();
    const nodeSet = new Set(nodes);
    const result: UUID[][] = [];

    for (const start of nodes) {
      if (visited.has(start)) continue;

      const component: UUID[] = [];
      const stack: UUID[] = [start];

      while (stack.length > 0) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;

        visited.add(id);
        component.push(id);

        for (const depId of this._graph?.getDirectDeps(id) ?? []) {
          if (nodeSet.has(depId) && !visited.has(depId)) {
            stack.push(depId);
          }
        }
      }

      if (component.length > 1) result.push(component);
    }

    return result;
  }
}

// ── Özet tipi ────────────────────────────────────────────────
export interface DependencySummary {
  readonly fileId:         UUID;
  readonly directDeps:     number;
  readonly externalDeps:   number;
  readonly typeOnlyDeps:   number;
  readonly dependants:     number;
  readonly transitiveDeps: number;
  readonly byKind:         Readonly<Partial<Record<EdgeKind, number>>>;
}
