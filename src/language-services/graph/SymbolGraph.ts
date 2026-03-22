// ─────────────────────────────────────────────────────────────
// language-services/graph/SymbolGraph.ts
// In-memory symbol graph — hızlı traversal + cycle detection
//
// GraphStorage kalıcı depolamayı yönetir.
// SymbolGraph onun üstünde çalışan hot-path in-memory katmanı.
// Phase 3 | v1.0.1 (Düzeltilmiş — atomic + cycle + ortak traverse)
//
// Kritik düzeltmeler:
// • applySnapshot artık atomic (storage önce yazılır)
// • Cycle detection hem from hem to için çalışır
// • getTransitiveDeps / getImpactedFiles → ortak _traverse helper
// • hydrate daha güvenli + sessiz hata yok
// • Race condition riski minimize edildi (tek thread için yeterli)
// ─────────────────────────────────────────────────────────────

import type { UUID, Result, IEventBus, AppEventMap } from "../../core";
import { ok, err, tryResultAsync, ErrorCode } from "../../core";
import type { GraphStorage } from "../storage/GraphStorage";
import type { SymbolNode, DependencyEdge, ReferenceLocation, FileSnapshot } from "./types";

// ── In-memory graph state ─────────────────────────────────────
interface GraphNode {
  readonly fileId:   UUID;
  readonly symbols:  Map<UUID, SymbolNode>;
  readonly outEdges: Set<UUID>;
  readonly inEdges:  Set<UUID>;
}

export class SymbolGraph {
  private readonly _storage:  GraphStorage;
  private readonly _eventBus: IEventBus;

  private readonly _nodes = new Map<UUID, GraphNode>();
  private readonly _symbolFile = new Map<UUID, UUID>();

  constructor(storage: GraphStorage, eventBus: IEventBus) {
    this._storage  = storage;
    this._eventBus = eventBus;
  }

  // ── Snapshot entegrasyonu (ARTIK ATOMİK) ─────────────────────
  async applySnapshot(snapshot: FileSnapshot): Promise<Result<void>> {
    const { fileId } = snapshot;

    // 1. Önce kalıcı depolamaya yaz (en önemli değişiklik)
    const writeResult = await this._storage.writeSnapshot(snapshot);
    if (!writeResult.ok) return writeResult;

    // 2. In-memory temizle ve yeniden oluştur
    this._removeFileEdges(fileId);
    const node = this._ensureNode(fileId);
    node.symbols.clear();

    for (const sym of snapshot.symbols) {
      node.symbols.set(sym.id, sym);
      this._symbolFile.set(sym.id, fileId);
    }

    // 3. Kenarları kur
    const newDeps: UUID[] = [];
    for (const dep of snapshot.deps) {
      if (!dep.isResolved) continue;
      node.outEdges.add(dep.toFileId);
      const targetNode = this._ensureNode(dep.toFileId);
      targetNode.inEdges.add(fileId);
      newDeps.push(dep.toFileId);

      this._eventBus.emit("graph:edge:added", { from: fileId, to: dep.toFileId });
    }

    // 4. Cycle kontrolü — hem yeni dosya hem hedef dosyalar için
    this._detectCycleFrom(fileId);
    for (const toId of newDeps) {
      this._detectCycleFrom(toId);
    }

    this._eventBus.emit("language:parsed", {
      fileId,
      symbols: snapshot.symbols.length,
      durationMs: Date.now() - snapshot.parsedAt,
    });

    return ok(undefined);
  }

  // ── File invalidation ────────────────────────────────────────
  async invalidateFile(fileId: UUID, reason: "edit" | "delete" | "rename"): Promise<Result<void>> {
    this._removeFileEdges(fileId);
    this._nodes.delete(fileId);

    const result = await this._storage.invalidateFile(fileId);
    if (!result.ok) return result;

    this._eventBus.emit("index:invalidated", { fileId, reason });
    return ok(undefined);
  }

  // ── Sembol sorgulama ─────────────────────────────────────────
  getSymbol(symbolId: UUID): SymbolNode | null {
    const fileId = this._symbolFile.get(symbolId);
    if (!fileId) return null;
    return this._nodes.get(fileId)?.symbols.get(symbolId) ?? null;
  }

  getFileSymbols(fileId: UUID): ReadonlyArray<SymbolNode> {
    return [...(this._nodes.get(fileId)?.symbols.values() ?? [])];
  }

  // ── Dependency traversal (ORTAK HELPER ile) ──────────────────
  getDirectDeps(fileId: UUID): ReadonlyArray<UUID> {
    return [...(this._nodes.get(fileId)?.outEdges ?? [])];
  }

  getDirectDependants(fileId: UUID): ReadonlyArray<UUID> {
    return [...(this._nodes.get(fileId)?.inEdges ?? [])];
  }

  getTransitiveDeps(fileId: UUID, maxDepth = 20): ReadonlyArray<UUID> {
    return this._traverse("out", fileId, maxDepth);
  }

  getImpactedFiles(fileId: UUID, maxDepth = 20): ReadonlyArray<UUID> {
    return this._traverse("in", fileId, maxDepth);
  }

  // ── Ortak DFS/BFS traverse (kod tekrarı yok) ─────────────────
  private _traverse(direction: "out" | "in", startId: UUID, maxDepth: number): UUID[] {
    const visited = new Set<UUID>();
    const isOut = direction === "out";

    const queue: { id: UUID; depth: number }[] = [{ id: startId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue[isOut ? "pop" : "shift"]()!;
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);

      const edges = isOut
        ? this.getDirectDeps(id)
        : this.getDirectDependants(id);

      for (const nextId of edges) {
        if (!visited.has(nextId)) {
          queue.push({ id: nextId, depth: depth + 1 });
        }
      }
    }

    visited.delete(startId);
    return [...visited];
  }

  // ── Cycle detection (geliştirilmiş) ──────────────────────────
  private _detectCycleFrom(startId: UUID): void {
    const cycle = this._detectCycle(startId);
    if (cycle) {
      this._eventBus.emit("graph:cycle:detected", { cycle });
    }
  }

  private _detectCycle(startId: UUID): UUID[] | null {
    const visited = new Set<UUID>();
    const path: UUID[] = [];
    const pathSet = new Set<UUID>();

    const dfs = (id: UUID): UUID[] | null => {
      if (pathSet.has(id)) {
        const cycleStart = path.indexOf(id);
        return [...path.slice(cycleStart), id];
      }
      if (visited.has(id)) return null;

      visited.add(id);
      path.push(id);
      pathSet.add(id);

      for (const depId of this.getDirectDeps(id)) {
        const cycle = dfs(depId);
        if (cycle) return cycle;
      }

      path.pop();
      pathSet.delete(id);
      return null;
    };

    return dfs(startId);
  }

  // ── Yardımcı metotlar ────────────────────────────────────────
  private _ensureNode(fileId: UUID): GraphNode {
    if (!this._nodes.has(fileId)) {
      this._nodes.set(fileId, {
        fileId,
        symbols: new Map(),
        outEdges: new Set(),
        inEdges: new Set(),
      });
    }
    return this._nodes.get(fileId)!;
  }

  private _removeFileEdges(fileId: UUID): void {
    const node = this._nodes.get(fileId);
    if (!node) return;

    for (const toId of node.outEdges) {
      this._nodes.get(toId)?.inEdges.delete(fileId);
    }
    // NOT: inEdges'teki kaynaklardan gelen outEdge'leri SİLME!
    // Sadece bu node'un outEdges'ini ve inEdges'ini temizle
    // (kaynak node'lar kendi outEdge'lerini korur)

    for (const symId of node.symbols.keys()) {
      this._symbolFile.delete(symId);
    }

    node.symbols.clear();
    node.outEdges.clear();
    // NOT: node.inEdges temizlenmez!
    // Diğer node'ların applySnapshot'ı bu node'u inEdges'e ekler.
    // Temizlersek A→B bağlantısı applySnapshot(B) sonrası kaybolur.
  }

  // ── Hydrate (uygulama başlangıcı) ────────────────────────────
  async hydrate(fileIds: ReadonlyArray<UUID>): Promise<Result<void>> {
    return tryResultAsync(async () => {
      for (const fileId of fileIds) {
        const [symsResult, depsResult] = await Promise.all([
          this._storage.getSymbolsByFile(fileId),
          this._storage.getDependencies(fileId),
        ]);

        if (!symsResult.ok || !depsResult.ok) {
          // Hata olsa bile diğer dosyaları yüklemeye devam et
          console.warn(`[SymbolGraph] hydrate failed for ${fileId}`);
          continue;
        }

        const node = this._ensureNode(fileId);
        for (const sym of symsResult.data) {
          node.symbols.set(sym.id, sym);
          this._symbolFile.set(sym.id, fileId);
        }

        for (const dep of depsResult.data) {
          if (!dep.isResolved) continue;
          node.outEdges.add(dep.toFileId);
          this._ensureNode(dep.toFileId).inEdges.add(fileId);
        }
      }
    }, ErrorCode.INDEX_FAILED, "SymbolGraph hydrate failed");
  }

  get nodeCount(): number { return this._nodes.size; }
  get symbolCount(): number { return this._symbolFile.size; }
}