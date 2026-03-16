// ─────────────────────────────────────────────────────────────
// language-services/ScopeAnalyzer.ts
// Kapsam zinciri analizi — rename güvenlik kontrolü için
//
// Sorumluluklar:
//   • Dosya içeriğinden scope ağacı çıkar (stub — Phase 4 Tree-sitter)
//   • Cursor pozisyonundaki scope zincirini döndür
//   • Rename öncesi shadow / conflict kontrolü yap
//   • Bir sembolün hangi scope'larda görünür olduğunu belirle
//
// ReferenceIndex.prepareRename() bu sınıfı çağırır:
//   isSafeToRename() → false dönerse rename reddedilir
//
// Phase 3 | v1.0.1
//
// v1.0.0 → v1.0.1:
//   [SA-1] getVisibleScopes: target.isExported → target.exportedAs !== null
//          (SymbolNode'da isExported alanı yok — types.ts v1.1.0 ile hizalandı)
// ─────────────────────────────────────────────────────────────

import type { UUID, Result } from "../core";
import { ok, err, ErrorCode } from "../core";
import type { SymbolNode, SymbolKind } from "./graph/types";

// ─────────────────────────────────────────────────────────────
// § 1. Scope types
// ─────────────────────────────────────────────────────────────

export type ScopeKind =
  | "global"      // Worker global scope
  | "module"      // Dosya top-level — ES module boundary
  | "function"    // function / arrow / method body
  | "block"       // if / for / while / switch / bare {}
  | "class"       // class body
  | "namespace";  // TS namespace / module declaration

export interface Scope {
  readonly id:       string;           // scope içinde unique
  readonly kind:     ScopeKind;
  readonly name?:    string;           // function/class/namespace adı
  readonly parentId: string | null;    // null = global root
  /** Scope'un açıldığı satır (dahil) */
  readonly startLine: number;
  readonly startCol:  number;
  /** Scope'un kapandığı satır (dahil) */
  readonly endLine:   number;
  readonly endCol:    number;
  /** Bu scope'ta tanımlanan sembol ID'leri */
  readonly symbolIds: ReadonlySet<UUID>;
}

/** Scope ağacının tamamı — tek dosya için */
export interface ScopeTree {
  readonly fileId: UUID;
  readonly scopes: ReadonlyMap<string, Scope>;
  readonly root:   string;   // global scope id'si
}

// ─────────────────────────────────────────────────────────────
// § 2. Rename analiz sonuçları
// ─────────────────────────────────────────────────────────────

export interface RenameConflict {
  readonly kind:     "shadow" | "shadowed_by" | "same_scope";
  readonly newName:  string;
  readonly scopeId:  string;
  /** Çakışan sembol (varsa) */
  readonly conflictingSymbol?: SymbolNode;
  readonly message:  string;
}

export interface RenameAnalysis {
  readonly symbolId:   UUID;
  readonly newName:    string;
  readonly isSafe:     boolean;
  readonly conflicts:  ReadonlyArray<RenameConflict>;
  /** Rename'den etkilenecek scope'lar */
  readonly affectedScopeIds: ReadonlyArray<string>;
}

// ─────────────────────────────────────────────────────────────
// § 3. Scope visibility
// ─────────────────────────────────────────────────────────────

export interface ScopeChain {
  /** Cursor'dan global'e doğru sıralı scope listesi */
  readonly chain:    ReadonlyArray<Scope>;
  /** En iç scope */
  readonly innermost: Scope;
}

// ─────────────────────────────────────────────────────────────
// § 4. ScopeAnalyzer
// ─────────────────────────────────────────────────────────────

export class ScopeAnalyzer {

  /** fileId → ScopeTree önbelleği */
  private readonly _cache = new Map<UUID, ScopeTree>();

  // ── Cache yönetimi ───────────────────────────────────────────

  invalidate(fileId: UUID): void {
    this._cache.delete(fileId);
  }

  hasCached(fileId: UUID): boolean {
    return this._cache.has(fileId);
  }

  // ── Scope ağacı oluştur ──────────────────────────────────────

  /**
   * Dosya içeriği + sembollerden scope ağacı çıkarır.
   * Sonuç cache'lenir; aynı fileId için tekrar çağrılırsa
   * cache geçerlidir (invalidate() çağrılmadıkça).
   *
   * Phase 4: Tree-sitter AST ile değiştirilecek.
   * Şimdilik: brace matching + keyword analizi (stub).
   */
  buildScopeTree(
    fileId:  UUID,
    content: string,
    symbols: ReadonlyArray<SymbolNode>
  ): Result<ScopeTree> {
    try {
      const cached = this._cache.get(fileId);
      if (cached) return ok(cached);

      const tree = this._buildTree(fileId, content, symbols);
      this._cache.set(fileId, tree);
      return ok(tree);
    } catch (e) {
      return err(ErrorCode.PARSE_ERROR, e instanceof Error ? e.message : String(e));
    }
  }

  // ── Cursor pozisyonundaki scope zinciri ──────────────────────

  /**
   * Verilen satır/sütun pozisyonuna göre scope zincirini döndürür.
   * En iç scope'tan global'e doğru sıralıdır.
   */
  getScopeChainAt(
    fileId:  UUID,
    content: string,
    symbols: ReadonlyArray<SymbolNode>,
    line:    number,
    col:     number
  ): Result<ScopeChain> {
    const treeResult = this.buildScopeTree(fileId, content, symbols);
    if (!treeResult.ok) return treeResult;

    const tree = treeResult.data;
    const chain = this._buildChainAt(tree, line, col);

    if (chain.length === 0) {
      return err(ErrorCode.SYMBOL_NOT_FOUND, `No scope at ${line}:${col}`);
    }

    return ok({ chain, innermost: chain[0] });
  }

  // ── Rename güvenlik analizi ───────────────────────────────────

  /**
   * Bir sembolün yeni adla yeniden adlandırılmasının güvenli olup
   * olmadığını kontrol eder.
   *
   * Kontroller:
   *   1. same_scope  — aynı scope'ta yeni ad zaten var
   *   2. shadow      — iç scope'larda yeni ad tanımlı → orayı gizler
   *   3. shadowed_by — dış scope'larda yeni ad tanımlı → bu gizlenir
   */
  analyzeRename(
    fileId:  UUID,
    content: string,
    symbols: ReadonlyArray<SymbolNode>,
    symbolId: UUID,
    newName:  string
  ): Result<RenameAnalysis> {
    const treeResult = this.buildScopeTree(fileId, content, symbols);
    if (!treeResult.ok) return treeResult;

    const tree   = treeResult.data;
    const target = symbols.find(s => s.id === symbolId);

    if (!target) {
      return err(ErrorCode.SYMBOL_NOT_FOUND, `Symbol ${symbolId} not found`);
    }

    const targetScope = this._findScopeForSymbol(tree, symbolId);
    if (!targetScope) {
      return err(ErrorCode.SYMBOL_NOT_FOUND, `Scope for ${symbolId} not found`);
    }

    const conflicts: RenameConflict[] = [];
    const affectedScopeIds = new Set<string>();
    const symbolMap = new Map(symbols.map(s => [s.id, s]));

    // 1. same_scope — aynı scope'ta yeni isim var mı?
    for (const sId of targetScope.symbolIds) {
      if (sId === symbolId) continue;
      const s = symbolMap.get(sId);
      if (s?.name === newName) {
        conflicts.push({
          kind:              "same_scope",
          newName,
          scopeId:           targetScope.id,
          conflictingSymbol: s,
          message:           `'${newName}' already declared in same scope (${targetScope.name ?? targetScope.kind})`,
        });
      }
    }

    // 2. shadow — child scope'larda yeni isim tanımlı mı?
    const childScopes = this._getDescendantScopes(tree, targetScope.id);
    for (const scope of childScopes) {
      for (const sId of scope.symbolIds) {
        const s = symbolMap.get(sId);
        if (s?.name === newName) {
          affectedScopeIds.add(scope.id);
          conflicts.push({
            kind:              "shadow",
            newName,
            scopeId:           scope.id,
            conflictingSymbol: s,
            message:           `'${newName}' in inner scope (${scope.name ?? scope.kind}) would be shadowed`,
          });
        }
      }
    }

    // 3. shadowed_by — parent scope'larda yeni isim tanımlı mı?
    const parentScopes = this._getAncestorScopes(tree, targetScope.id);
    for (const scope of parentScopes) {
      for (const sId of scope.symbolIds) {
        const s = symbolMap.get(sId);
        if (s?.name === newName) {
          affectedScopeIds.add(scope.id);
          conflicts.push({
            kind:              "shadowed_by",
            newName,
            scopeId:           scope.id,
            conflictingSymbol: s,
            message:           `'${newName}' in outer scope (${scope.name ?? scope.kind}) would shadow this`,
          });
        }
      }
    }

    // Rename'in etkilediği scope'lar = target + children
    affectedScopeIds.add(targetScope.id);
    for (const s of childScopes) affectedScopeIds.add(s.id);

    return ok({
      symbolId,
      newName,
      isSafe:           conflicts.length === 0,
      conflicts,
      affectedScopeIds: [...affectedScopeIds],
    });
  }

  /**
   * Hızlı boolean kontrol — `prepareRename` için.
   * Detay istemiyorsan `analyzeRename` yerine bunu kullan.
   */
  isSafeToRename(
    fileId:   UUID,
    content:  string,
    symbols:  ReadonlyArray<SymbolNode>,
    symbolId: UUID,
    newName:  string
  ): boolean {
    const result = this.analyzeRename(fileId, content, symbols, symbolId, newName);
    return result.ok && result.data.isSafe;
  }

  // ── Sembolün göründüğü scope'lar ────────────────────────────

  /**
   * Bir sembolün hangi scope'lardan erişilebilir olduğunu döndürür.
   * Export edilmişse module scope + tüm child scope'lar.
   * Local ise sadece tanımlı scope + child scope'lar.
   */
  getVisibleScopes(
    fileId:   UUID,
    content:  string,
    symbols:  ReadonlyArray<SymbolNode>,
    symbolId: UUID
  ): Result<ReadonlyArray<Scope>> {
    const treeResult = this.buildScopeTree(fileId, content, symbols);
    if (!treeResult.ok) return treeResult;

    const tree   = treeResult.data;
    const target = symbols.find(s => s.id === symbolId);
    if (!target) return ok([]);

    const declaringScope = this._findScopeForSymbol(tree, symbolId);
    if (!declaringScope) return ok([]);

    const descendants = this._getDescendantScopes(tree, declaringScope.id);

    // Export edilmişse module scope'tan da görünür
    const visible: Scope[] = [declaringScope, ...descendants];

    if (target.exportedAs !== null) {
      const moduleScope = this._findScopeByKind(tree, "module");
      if (moduleScope && moduleScope.id !== declaringScope.id) {
        visible.unshift(moduleScope);
      }
    }

    return ok(visible);
  }

  // ─────────────────────────────────────────────────────────────
  // § 5. Scope ağacı inşası (stub)
  //
  // Phase 4: Tree-sitter AST node'larından gerçek scope ağacı.
  // Şimdilik: brace matching + SymbolNode pozisyonlarından
  // scope sınırlarını tahmin et.
  // ─────────────────────────────────────────────────────────────

  private _buildTree(
    fileId:  UUID,
    content: string,
    symbols: ReadonlyArray<SymbolNode>
  ): ScopeTree {
    const scopes = new Map<string, Scope>();
    const lines  = content.split("\n");

    // Global root
    const globalId = scopeId("global", 0, 0);
    scopes.set(globalId, {
      id:        globalId,
      kind:      "global",
      parentId:  null,
      startLine: 0,
      startCol:  0,
      endLine:   lines.length - 1,
      endCol:    (lines[lines.length - 1] ?? "").length,
      symbolIds: new Set(),
    });

    // Module scope (ES module → tüm dosya)
    const moduleId = scopeId("module", 0, 0);
    scopes.set(moduleId, {
      id:        moduleId,
      kind:      "module",
      parentId:  globalId,
      startLine: 0,
      startCol:  0,
      endLine:   lines.length - 1,
      endCol:    (lines[lines.length - 1] ?? "").length,
      symbolIds: new Set(),
    });

    // Sembol konumlarından function/class/namespace scope'ları çıkar
    const blockScopes = this._extractBlockScopes(lines, symbols, moduleId);
    for (const [id, scope] of blockScopes) {
      scopes.set(id, scope);
    }

    // Her sembolü uygun scope'a ata
    this._assignSymbolsToScopes(scopes, symbols, moduleId);

    return { fileId, scopes, root: globalId };
  }

  /**
   * Sembol tanımlarından scope blokları çıkarır.
   * function/class/namespace → { } aralığını tespit et.
   *
   * Phase 4: Tree-sitter node.body.startPosition / endPosition ile değişir.
   */
  private _extractBlockScopes(
    lines:   string[],
    symbols: ReadonlyArray<SymbolNode>,
    parentId: string
  ): Map<string, Scope> {
    const result = new Map<string, Scope>();

    const scopeKinds: ReadonlyArray<SymbolKind> = ["function", "class", "namespace", "method"];

    for (const sym of symbols) {
      if (!scopeKinds.includes(sym.kind)) continue;

      // Stub: sembolün açıldığı satırdan closing brace'i bul
      const blockEnd = this._findBlockEnd(lines, sym.line);
      if (blockEnd === null) continue;

      const kind: ScopeKind =
        sym.kind === "class"     ? "class"     :
        sym.kind === "namespace" ? "namespace" :
                                   "function";

      const id = scopeId(kind, sym.line, sym.col);

      result.set(id, {
        id,
        kind,
        name:      sym.name,
        parentId,
        startLine: sym.line,
        startCol:  sym.col,
        endLine:   blockEnd.line,
        endCol:    blockEnd.col,
        symbolIds: new Set(),
      });
    }

    return result;
  }

  /**
   * Her sembolü içinde bulunduğu en iç scope'a atar.
   */
  private _assignSymbolsToScopes(
    scopes:   Map<string, Scope>,
    symbols:  ReadonlyArray<SymbolNode>,
    fallback: string
  ): void {
    for (const sym of symbols) {
      const targetScope = this._findInnermostScope(scopes, sym.line, sym.col) ?? scopes.get(fallback);
      if (!targetScope) continue;

      // Set readonly ama inşa aşamasında mutate ediyoruz — cast gerekli
      (targetScope.symbolIds as Set<UUID>).add(sym.id);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // § 6. Scope ağacı sorgu yardımcıları
  // ─────────────────────────────────────────────────────────────

  private _buildChainAt(tree: ScopeTree, line: number, col: number): Scope[] {
    const candidates = [...tree.scopes.values()]
      .filter(s => this._containsPosition(s, line, col))
      .sort((a, b) => {
        // En iç scope önce — alan büyüklüğüne göre sırala (küçük = iç)
        const areaA = (a.endLine - a.startLine) * 10000 + (a.endCol - a.startCol);
        const areaB = (b.endLine - b.startLine) * 10000 + (b.endCol - b.startCol);
        return areaA - areaB;
      });

    return candidates;
  }

  private _findScopeForSymbol(tree: ScopeTree, symbolId: UUID): Scope | null {
    for (const scope of tree.scopes.values()) {
      if (scope.symbolIds.has(symbolId)) return scope;
    }
    return null;
  }

  private _getDescendantScopes(tree: ScopeTree, scopeId: string): Scope[] {
    const result: Scope[] = [];
    const queue  = [scopeId];

    while (queue.length > 0) {
      const parentId = queue.shift()!;
      for (const scope of tree.scopes.values()) {
        if (scope.parentId === parentId) {
          result.push(scope);
          queue.push(scope.id);
        }
      }
    }

    return result;
  }

  private _getAncestorScopes(tree: ScopeTree, targetScopeId: string): Scope[] {
    const result: Scope[] = [];
    let current = tree.scopes.get(targetScopeId);

    while (current?.parentId) {
      const parent = tree.scopes.get(current.parentId);
      if (!parent) break;
      result.push(parent);
      current = parent;
    }

    return result;
  }

  private _findScopeByKind(tree: ScopeTree, kind: ScopeKind): Scope | null {
    for (const scope of tree.scopes.values()) {
      if (scope.kind === kind) return scope;
    }
    return null;
  }

  private _findInnermostScope(
    scopes: Map<string, Scope>,
    line:   number,
    col:    number
  ): Scope | null {
    let best: Scope | null = null;
    let bestArea = Infinity;

    for (const scope of scopes.values()) {
      if (!this._containsPosition(scope, line, col)) continue;
      const area = (scope.endLine - scope.startLine) * 10000 + (scope.endCol - scope.startCol);
      if (area < bestArea) { best = scope; bestArea = area; }
    }

    return best;
  }

  private _containsPosition(scope: Scope, line: number, col: number): boolean {
    if (line < scope.startLine || line > scope.endLine) return false;
    if (line === scope.startLine && col < scope.startCol)  return false;
    if (line === scope.endLine   && col > scope.endCol)    return false;
    return true;
  }

  // ─────────────────────────────────────────────────────────────
  // § 7. Block end detection (stub)
  //
  // Açılış brace'inden kapanış brace'ine kadar satır tarar.
  // Phase 4: Tree-sitter node.endPosition ile değişir.
  // ─────────────────────────────────────────────────────────────

  private _findBlockEnd(
    lines:     string[],
    startLine: number
  ): { line: number; col: number } | null {
    let depth = 0;
    let found = false;

    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];

      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (ch === "{") { depth++; found = true; }
        if (ch === "}") {
          depth--;
          if (found && depth === 0) {
            return { line: i, col: c };
          }
        }
      }
    }

    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// § 8. Utilities
// ─────────────────────────────────────────────────────────────

function scopeId(kind: ScopeKind | string, line: number, col: number): string {
  return `${kind}:${line}:${col}`;
}
