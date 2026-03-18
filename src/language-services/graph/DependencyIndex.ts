// ─────────────────────────────────────────────────────────────
// language-services/graph/DependencyIndex.ts
// Dosya bağımlılık grafiği — path çözümleme + topolojik sıralama
// Phase 3 | v1.1.0 (Performans + Güvenlik Düzeltmeleri)
// ─────────────────────────────────────────────────────────────

import type { UUID, Result } from "../../core";
import { tryResultAsync, ErrorCode } from "../../core";
import type { GraphStorage } from "../storage/GraphStorage";
import type { SymbolGraph } from "./SymbolGraph";
import type { DependencyEdge, EdgeKind } from "./types";
import { EdgeKind as EK } from "./types";

// ── External dosyalar için sabit ID (magic string yerine) ─────
const EXTERNAL_FILE_ID = "00000000-0000-0000-0000-000000000000" as UUID;

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
  private readonly _storage:  GraphStorage;
  private readonly _graph:    SymbolGraph;
  private readonly _resolver: IPathResolver;

  constructor(
    storage:  GraphStorage,
    graph:    SymbolGraph,
    resolver: IPathResolver
  ) {
    this._storage  = storage;
    this._graph    = graph;
    this._resolver = resolver;
  }

  // ── Import specifier'larını çözümle (PARALEL) ────────────────
  async resolveImports(
    fromFileId: UUID,
    rawEdges: ReadonlyArray<{ specifier: string; names: string[]; kind: EdgeKind; line: number }>
  ): Promise<Result<ReadonlyArray<DependencyEdge>>> {
    return tryResultAsync(async () => {
      const fromPath = this._resolver.getPath(fromFileId);
      if (!fromPath) return [];

      const promises = rawEdges.map(async (raw) => {
        const toFileId = await this._resolver.resolve(raw.specifier, fromPath);

        return {
          fromFileId,
          toFileId:      toFileId ?? EXTERNAL_FILE_ID,
          kind:          raw.kind,
          rawSpecifier:  raw.specifier,
          importedNames: raw.names,
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
        const deps = this._graph.getDirectDeps(id);
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
      const impacted = this._graph.getImpactedFiles(changedFileId);

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
        this._storage.getDependencies(fileId),
        this._storage.getReverseDependencies(fileId),
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
        transitiveDeps:   new Set(this._graph.getTransitiveDeps(fileId)).size,
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

        for (const depId of this._graph.getDirectDeps(id)) {
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