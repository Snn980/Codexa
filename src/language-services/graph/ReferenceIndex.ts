// ─────────────────────────────────────────────────────────────
// language-services/graph/ReferenceIndex.ts
// Sembol kullanım haritası — go-to-definition + find-all-references
// Phase 3 | v1.1.1 (Fixed)
// ─────────────────────────────────────────────────────────────

import type { UUID, Result } from "../../core";
import { ok, err, tryResultAsync, ErrorCode } from "../../core";
import type { GraphStorage } from "../storage/GraphStorage";
import type { SymbolGraph } from "./SymbolGraph";
import type { ReferenceLocation, SymbolNode, SymbolKind } from "./types";

// ── Cooked query result tipleri ───────────────────────────────

export interface DefinitionResult {
  readonly symbol:   SymbolNode;
  readonly location: ReferenceLocation;
  readonly fileId:   UUID;
}

export interface FindReferencesResult {
  readonly symbol:     SymbolNode;
  readonly references: ReadonlyArray<ReferenceLocation>;
  readonly writeCount: number;
  readonly readCount:  number;
}

export interface HoverInfo {
  readonly symbol:     SymbolNode;
  readonly signature:  string;
  readonly docComment: string | null;
  readonly location:   ReferenceLocation;
}

// ── Position → SymbolNode eşleştirme ─────────────────────────

export interface CursorContext {
  readonly fileId: UUID;
  readonly line:   number;
  readonly col:    number;
}

// ── ReferenceIndex ────────────────────────────────────────────

export class ReferenceIndex {

  private readonly _storage: GraphStorage;
  private readonly _graph:   SymbolGraph;

  // fileId → (line:col → symbolId)
  private readonly _posCache = new Map<UUID, Map<string, UUID>>();

  constructor(storage: GraphStorage, graph: SymbolGraph) {
    this._storage = storage;
    this._graph   = graph;
  }

  // ── Cache ───────────────────────────────────────────────────

  buildPosCache(fileId: UUID): void {

    const symbols = this._graph.getFileSymbols(fileId);
    const posMap  = new Map<string, UUID>();

    for (const sym of symbols) {

      posMap.set(posKey(sym.line, sym.col), sym.id);

      if (sym.endCol - sym.col <= 30) {
        for (let col = sym.col; col <= sym.endCol; col++) {
          posMap.set(posKey(sym.line, col), sym.id);
        }
      }

    }

    this._posCache.set(fileId, posMap);
  }

  invalidatePosCache(fileId: UUID): void {
    this._posCache.delete(fileId);
  }

  // ── Cursor → Symbol ─────────────────────────────────────────

  getSymbolAtCursor(ctx: CursorContext): SymbolNode | null {

    const posMap = this._posCache.get(ctx.fileId);

    if (!posMap) {
      return this._manualSearch(ctx);
    }

    let symId = posMap.get(posKey(ctx.line, ctx.col));

    if (symId) {
      return this._graph.getSymbol(symId);
    }

    symId = this._findSymbolInLine(posMap, ctx);

    if (symId) {
      return this._graph.getSymbol(symId);
    }

    return this._manualSearch(ctx);
  }

  private _findSymbolInLine(
    posMap: Map<string, UUID>,
    ctx: CursorContext
  ): UUID | undefined {

    const min = Math.max(0, ctx.col - 50);

    for (let c = ctx.col; c >= min; c--) {

      const id = posMap.get(posKey(ctx.line, c));

      if (id) return id;

    }

    return undefined;
  }

  private _manualSearch(ctx: CursorContext): SymbolNode | null {

    const symbols = this._graph.getFileSymbols(ctx.fileId);

    for (const sym of symbols) {

      if (
        sym.line === ctx.line &&
        ctx.col >= sym.col &&
        ctx.col <= sym.endCol
      ) {
        return sym;
      }

    }

    return null;
  }

  // ── Reference sorgu yardımcı ─────────────────────────────────

  private async _fetchReferences(symId: UUID): Promise<ReferenceLocation[]> {

    const result = await this._storage.getReferences(symId);

    if (!result.ok) return [];

    return result.data;
  }

  // ── Go-to-definition ─────────────────────────────────────────

  async findDefinition(
    ctx: CursorContext
  ): Promise<Result<DefinitionResult | null>> {

    return tryResultAsync(async () => {

      const sym = this.getSymbolAtCursor(ctx);

      if (!sym) return null;

      const defs = await this._fetchReferences(sym.id);

      if (defs.length === 0) return null;

      const primaryDef = defs.find(d => d.isDecl) ?? defs[0];

      return {
        symbol:   sym,
        location: primaryDef,
        fileId:   primaryDef.fileId
      };

    }, ErrorCode.SYMBOL_NOT_FOUND, "findDefinition failed");
  }

  // ── Find all references ──────────────────────────────────────

  async findAllReferences(
    ctx: CursorContext,
    opts: { includeDeclaration?: boolean } = {}
  ): Promise<Result<FindReferencesResult | null>> {

    return tryResultAsync(async () => {

      const sym = this.getSymbolAtCursor(ctx);

      if (!sym) return null;

      let refs = await this._fetchReferences(sym.id);

      if (!opts.includeDeclaration) {
        refs = refs.filter(r => !r.isDecl);
      }

      const writeCount = refs.filter(r => r.isWrite).length;

      const readCount =
        refs.filter(r => !r.isWrite && !r.isDecl).length;

      return {
        symbol:     sym,
        references: refs,
        writeCount,
        readCount
      };

    }, ErrorCode.SYMBOL_NOT_FOUND, "findAllReferences failed");
  }

  // ── Rename hazırlığı ─────────────────────────────────────────

  async prepareRename(
    ctx: CursorContext
  ): Promise<Result<RenameCandidate | null>> {

    return tryResultAsync(async () => {

      const sym = this.getSymbolAtCursor(ctx);

      if (!sym) return null;

      const allRefs = await this._fetchReferences(sym.id);

      const byFile = new Map<UUID, ReferenceLocation[]>();

      for (const ref of allRefs) {

        const list = byFile.get(ref.fileId) ?? [];

        list.push(ref);

        byFile.set(ref.fileId, list);

      }

      return {
        symbol:      sym,
        currentName: sym.name,
        locations:   Object.fromEntries(byFile),
        fileCount:   byFile.size,
        refCount:    allRefs.length
      };

    }, ErrorCode.SYMBOL_NOT_FOUND, "prepareRename failed");
  }

  // ── Hover bilgisi ─────────────────────────────────────────────

  async getHoverInfo(
    ctx: CursorContext
  ): Promise<Result<HoverInfo | null>> {

    return tryResultAsync(async () => {

      const sym = this.getSymbolAtCursor(ctx);

      if (!sym) return null;

      const defs = await this._fetchReferences(sym.id);

      const location = defs.find(d => d.isDecl) ?? defs[0];

      if (!location) return null;

      const signature  = buildSignature(sym);
      const docComment = null;

      return {
        symbol:     sym,
        signature,
        docComment,
        location
      };

    }, ErrorCode.SYMBOL_NOT_FOUND, "getHoverInfo failed");
  }

  // ── Hot symbols ─────────────────────────────────────────────

  async getHotSymbols(
    fileId: UUID,
    limit = 10
  ): Promise<Result<ReadonlyArray<SymbolUsageStats>>> {

    return tryResultAsync(async () => {

      const symbols = this._graph.getFileSymbols(fileId);

      const promises = symbols.map(async sym => {

        const refs = await this._fetchReferences(sym.id);

        const writeCount =
          refs.filter(r => r.isWrite).length;

        const readCount =
          refs.filter(r => !r.isWrite && !r.isDecl).length;

        const crossFile =
          new Set(refs.map(r => r.fileId)).size > 1;

        return {
          symbol: sym,
          totalRefs: refs.length,
          writeCount,
          readCount,
          crossFileUsage: crossFile
        } as SymbolUsageStats;

      });

      const stats = await Promise.allSettled(promises);

      return stats
        .filter(
          (r): r is PromiseFulfilledResult<SymbolUsageStats> =>
            r.status === "fulfilled"
        )
        .map(r => r.value)
        .sort((a, b) => b.totalRefs - a.totalRefs)
        .slice(0, limit);

    }, ErrorCode.INDEX_FAILED, "getHotSymbols failed");
  }

}

// ── Helpers ───────────────────────────────────────────────────

function posKey(line: number, col: number): string {
  return `${line}:${col}`;
}

function buildSignature(sym: SymbolNode): string {

  const kindLabel: Record<SymbolKind, string> = {
    function: "function",
    class: "class",
    interface: "interface",
    variable: "let",
    constant: "const",
    type_alias: "type",
    enum: "enum",
    enum_member: "enum member",
    method: "method",
    property: "property",
    import: "import",
    export: "export",
    namespace: "namespace",
    parameter: "parameter"
  };

  const label = kindLabel[sym.kind] ?? sym.kind;

  const exported = sym.exportedAs ? "export " : "";

  return `${exported}${label} ${sym.name}`;
}

// ── Ek tipler ────────────────────────────────────────────────

export interface RenameCandidate {
  readonly symbol:      SymbolNode;
  readonly currentName: string;
  readonly locations:
    Readonly<Record<UUID, ReadonlyArray<ReferenceLocation>>>;
  readonly fileCount: number;
  readonly refCount:  number;
}

export interface SymbolUsageStats {
  readonly symbol:         SymbolNode;
  readonly totalRefs:      number;
  readonly writeCount:     number;
  readonly readCount:      number;
  readonly crossFileUsage: boolean;
}