// ─────────────────────────────────────────────────────────────
// language-services/storage/GraphStorage.ts
// LevelDB + SQLite hibrit storage adapter
//
// Okuma yolu  → LevelDB (hot, O(1), in-process)
// Yazma yolu  → SQLite (source of truth) + LevelDB (cache sync)
// Cross-file  → SQLite JOIN sorguları
// Phase 3 | v1.2.0
//
// v1.1.0 → v1.2.0 (merge):
//   Senin versiyonundan alınanlar:
//     [A] BEGIN/COMMIT/ROLLBACK transaction — gerçek atomiklik
//     [B] Bulk INSERT (batch VALUES) — N round-trip → 1
//     [C] rowToDep imported_names try/catch koruması
//     [D] getSymbolsByFile cache-miss sonrası LevelDB re-warm
//     [E] writeSnapshot refs → LevelKey.ref() cache yazımı
//   Bizim versiyonumuzdan korunanlar:
//     [F] _initialized set'i başarı yolunda (#20)
//     [G] LevelKey.depFwd / depRev (#2)
//     [H] SQLSymbolRow.version + rowToSymbol map (#3,#6)
//     [I] Checksum32 cast (#4), SymbolScope cast (#5)
//     [J] SQLDepRow.id + is_truncated + rowToDep map (#7,#8)
//     [K] SQLRefRow.id + rowToRef map (#9,#10)
//     [L] dep id kind dahil (#11), sym version snapshot'tan (#12)
//     [M] is_truncated INSERT (#13)
//     [N] stale revDep temizliği writeSnapshot'ta (#14)
//     [O] invalidateFile revDep cleanup (#15)
//     [P] findSymbolsByName, findDefinitions, findImporters, getStats
// ─────────────────────────────────────────────────────────────

import type { UUID, Result } from "../../core";
import { ok, err, tryResultAsync, ErrorCode } from "../../core";
import type {
  SymbolNode, DependencyEdge, ReferenceLocation, FileSnapshot, GraphStats,
} from "../graph/types";
import {
  LevelKey, SQL, SymbolKind, SymbolScope, EdgeKind, Checksum32,
} from "../graph/types";

// ── Driver interfaces ─────────────────────────────────────────

export interface ILevelDB {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  batch(ops: Array<{ type: "put" | "del"; key: string; value?: string }>): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  close(): Promise<void>;
}

export interface ISQLiteDriver {
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

// ── GraphStorage ──────────────────────────────────────────────

export class GraphStorage {

  private readonly _level: ILevelDB;
  private readonly _sql:   ISQLiteDriver;
  private _initialized = false;

  constructor(level: ILevelDB, sql: ISQLiteDriver) {
    this._level = level;
    this._sql   = sql;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async init(): Promise<Result<void>> {
    if (this._initialized) return ok(undefined);

    const result = await tryResultAsync(async () => {
      await this._sql.execute(SQL.CREATE_SYMBOLS);
      await this._sql.execute(SQL.CREATE_DEPENDENCIES);
      await this._sql.execute(SQL.CREATE_REFERENCES);
    });

    if (!result.ok) {
      // [F] Başarısız init yeniden denenebilir — set burada değil
      return err(ErrorCode.STORAGE_INIT, "GraphStorage init failed", { cause: result.error });
    }

    this._initialized = true;
    return ok(undefined);
  }

  async dispose(): Promise<void> {
    await this._level.close();
  }

  // ── writeSnapshot ─────────────────────────────────────────────
  //
  // SQLite yazması BEGIN/COMMIT/ROLLBACK ile atomik. [A]
  // LevelDB yazması SQLite commit'ten sonra gelir — ikisi arasında
  // çökme olursa LevelDB stale kalır; init sırasında re-hydrate ile
  // toparlanır (Phase 3.5).

  async writeSnapshot(snapshot: FileSnapshot): Promise<Result<void>> {
    if (!this._initialized) return err(ErrorCode.STORAGE_INIT, "Not initialized");

    const { fileId } = snapshot;

    const result = await tryResultAsync(async () => {

      // ── SQLite — atomik yazma ─────────────────────────────────
      await this._sql.execute("BEGIN");

      try {
        await this._sql.execute(`DELETE FROM ls_symbols      WHERE file_id=?`,      [fileId]);
        await this._sql.execute(`DELETE FROM ls_dependencies WHERE from_file_id=?`, [fileId]);
        await this._sql.execute(`DELETE FROM ls_references   WHERE file_id=?`,      [fileId]);

        // Semboller — bulk INSERT [B]
        if (snapshot.symbols.length > 0) {
          const placeholders: string[] = [];
          const params: unknown[] = [];

          for (const s of snapshot.symbols) {
            placeholders.push("(?,?,?,?,?,?,?,?,?,?,?,?,?)");
            params.push(
              s.id, s.fileId, s.name, s.kind, s.scope,
              s.line, s.col, s.endLine, s.endCol,
              s.parentId, s.exportedAs,
              s.checksum,
              s.version,  // [L] snapshot'tan, hardcoded 1 değil
            );
          }

          await this._sql.execute(
            `INSERT INTO ls_symbols
               (id,file_id,name,kind,scope,line,col,end_line,end_col,
                parent_id,exported_as,checksum,version)
             VALUES ${placeholders.join(",")}`,
            params
          );
        }

        // Bağımlılıklar — bulk INSERT [B]
        if (snapshot.deps.length > 0) {
          const placeholders: string[] = [];
          const params: unknown[] = [];

          for (const d of snapshot.deps) {
            placeholders.push("(?,?,?,?,?,?,?,?,?)");
            params.push(
              d.id,            // [L] kind dahil UUID — mixed import güvenli
              d.fromFileId, d.toFileId, d.kind,
              d.rawSpecifier,
              JSON.stringify(d.importedNames.slice(0, 128)),
              d.isTruncated ? 1 : 0,   // [M]
              d.line,
              d.isResolved ? 1 : 0,
            );
          }

          await this._sql.execute(
            `INSERT OR REPLACE INTO ls_dependencies
               (id,from_file_id,to_file_id,kind,raw_specifier,
                imported_names,is_truncated,line,is_resolved)
             VALUES ${placeholders.join(",")}`,
            params
          );
        }

        // Referanslar — bulk INSERT [B]
        if (snapshot.refs.length > 0) {
          const placeholders: string[] = [];
          const params: unknown[] = [];

          for (const r of snapshot.refs) {
            placeholders.push("(?,?,?,?,?,?,?,?)");
            params.push(
              r.id,  // [K]
              r.symbolId, r.fileId,
              r.line, r.col, r.endCol,
              r.isWrite ? 1 : 0,
              r.isDecl  ? 1 : 0,
            );
          }

          await this._sql.execute(
            `INSERT OR REPLACE INTO ls_references
               (id,symbol_id,file_id,line,col,end_col,is_write,is_decl)
             VALUES ${placeholders.join(",")}`,
            params
          );
        }

        await this._sql.execute("COMMIT");

      } catch (e) {
        await this._sql.execute("ROLLBACK");
        throw e;
      }

      // ── LevelDB — cache güncelle ──────────────────────────────

      // [N] Stale revDep temizliği: bu dosyanın önceki dep hedeflerini
      // bul, artık import etmediklerinden bu fileId'yi kaldır.
      const prevDeps    = await this._getLevelJSON<DependencyEdge[]>(LevelKey.depFwd(fileId)) ?? [];
      const prevTargets = new Set(prevDeps.filter(d => d.isResolved).map(d => d.toFileId));
      const newTargets  = new Set(snapshot.deps.filter(d => d.isResolved).map(d => d.toFileId));

      for (const removedId of prevTargets) {
        if (newTargets.has(removedId)) continue;
        const existing = await this._getLevelJSON<string[]>(LevelKey.depRev(removedId)) ?? [];
        const pruned   = existing.filter(id => id !== fileId);
        if (pruned.length !== existing.length) {
          await this._level.put(LevelKey.depRev(removedId), JSON.stringify(pruned));
        }
      }

      const ops: Array<{ type: "put" | "del"; key: string; value?: string }> = [];

      // Snapshot meta
      ops.push({
        type:  "put",
        key:   LevelKey.snapshot(fileId),
        value: JSON.stringify({
          version:  snapshot.version,
          checksum: snapshot.checksum,
          parsedAt: snapshot.parsedAt,
        }),
      });

      // Sembol id listesi + her sembol bireysel
      ops.push({
        type:  "put",
        key:   LevelKey.fileSyms(fileId),
        value: JSON.stringify(snapshot.symbols.map(s => s.id)),
      });

      for (const s of snapshot.symbols) {
        ops.push({
          type:  "put",
          key:   LevelKey.symbol(fileId, s.id),
          value: JSON.stringify(s),
        });
      }

      // Forward dep [G]
      ops.push({
        type:  "put",
        key:   LevelKey.depFwd(fileId),
        value: JSON.stringify(snapshot.deps),
      });

      // [E] Refs → ref:symbolId cache (senin versiyonundan)
      const refMap = new Map<UUID, ReferenceLocation[]>();
      for (const r of snapshot.refs) {
        if (!refMap.has(r.symbolId)) refMap.set(r.symbolId, []);
        refMap.get(r.symbolId)!.push(r);
      }
      for (const [symbolId, refs] of refMap) {
        ops.push({
          type:  "put",
          key:   LevelKey.ref(symbolId),
          value: JSON.stringify(refs),
        });
      }

      // Reverse dep [G] — yeni hedefler için güncelle
      for (const toId of newTargets) {
        const existing = await this._getLevelJSON<string[]>(LevelKey.depRev(toId)) ?? [];
        const merged   = [...new Set([...existing, fileId])];
        ops.push({
          type:  "put",
          key:   LevelKey.depRev(toId),
          value: JSON.stringify(merged),
        });
      }

      await this._level.batch(ops);
    });

    return result.ok
      ? ok(undefined)
      : err(ErrorCode.INDEX_FAILED, `Snapshot write failed: ${fileId}`, { cause: result.error });
  }

  // ── invalidateFile ────────────────────────────────────────────
  //
  // [O] Eski dep hedeflerinin revDep cache'ini de temizler.

  async invalidateFile(fileId: UUID): Promise<Result<void>> {
    const result = await tryResultAsync(async () => {

      // Temizlemeden önce eski dep hedeflerini oku
      const prevDeps    = await this._getLevelJSON<DependencyEdge[]>(LevelKey.depFwd(fileId)) ?? [];
      const prevTargets = prevDeps.filter(d => d.isResolved).map(d => d.toFileId);

      await this._sql.execute(`DELETE FROM ls_symbols      WHERE file_id=?`,      [fileId]);
      await this._sql.execute(`DELETE FROM ls_dependencies WHERE from_file_id=?`, [fileId]);
      await this._sql.execute(`DELETE FROM ls_references   WHERE file_id=?`,      [fileId]);

      const symIds = await this._getLevelJSON<string[]>(LevelKey.fileSyms(fileId)) ?? [];

      const ops: Array<{ type: "del"; key: string }> = [
        { type: "del", key: LevelKey.snapshot(fileId) },
        { type: "del", key: LevelKey.depFwd(fileId) },   // [G]
        { type: "del", key: LevelKey.fileSyms(fileId) },
        ...symIds.map(id => ({
          type: "del" as const,
          key:  LevelKey.symbol(fileId, id as UUID),
        })),
      ];

      await this._level.batch(ops);

      // [O] Eski hedeflerin revDep listesinden bu fileId'yi kaldır
      for (const toId of prevTargets) {
        const existing = await this._getLevelJSON<string[]>(LevelKey.depRev(toId)) ?? [];
        const pruned   = existing.filter(id => id !== fileId);
        if (pruned.length !== existing.length) {
          await this._level.put(LevelKey.depRev(toId), JSON.stringify(pruned));
        }
      }
    });

    return result.ok
      ? ok(undefined)
      : err(ErrorCode.INDEX_FAILED, `Invalidate failed: ${fileId}`, { cause: result.error });
  }

  // ── Hot-path reads (LevelDB first) ───────────────────────────

  async getSymbolsByFile(fileId: UUID): Promise<Result<ReadonlyArray<SymbolNode>>> {
    const symIds = await this._getLevelJSON<string[]>(LevelKey.fileSyms(fileId));

    if (symIds !== null) {
      const syms: SymbolNode[] = [];
      for (const id of symIds) {
        const sym = await this._getLevelJSON<SymbolNode>(LevelKey.symbol(fileId, id as UUID));
        if (sym) syms.push(sym);
      }
      return ok(syms);
    }

    // Cache miss — SQLite fallback
    const result = await tryResultAsync<ReadonlyArray<SymbolNode>>(async () => {
      const rows = await this._sql.query<SQLSymbolRow>(
        `SELECT * FROM ls_symbols WHERE file_id=? ORDER BY line,col`, [fileId]
      );
      return rows.map(rowToSymbol);
    });

    // [D] Cache-miss sonrası LevelDB'yi ısıt — sonraki okuma LevelDB'den gelir
    if (result.ok && result.value.length > 0) {
      const ops = result.value.map(sym => ({
        type:  "put" as const,
        key:   LevelKey.symbol(fileId, sym.id),
        value: JSON.stringify(sym),
      }));
      await this._level.batch(ops);
    }

    return result;
  }

  async getDependencies(fileId: UUID): Promise<Result<ReadonlyArray<DependencyEdge>>> {
    const cached = await this._getLevelJSON<DependencyEdge[]>(LevelKey.depFwd(fileId));  // [G]
    if (cached !== null) return ok(cached);

    return tryResultAsync<ReadonlyArray<DependencyEdge>>(async () => {
      const rows = await this._sql.query<SQLDepRow>(
        `SELECT * FROM ls_dependencies WHERE from_file_id=? ORDER BY line`, [fileId]
      );
      return rows.map(rowToDep);
    });
  }

  async getReverseDependencies(fileId: UUID): Promise<Result<ReadonlyArray<UUID>>> {
    const cached = await this._getLevelJSON<UUID[]>(LevelKey.depRev(fileId));
    if (cached !== null) return ok(cached);

    return tryResultAsync<ReadonlyArray<UUID>>(async () => {
      const rows = await this._sql.query<{ from_file_id: string }>(
        `SELECT DISTINCT from_file_id FROM ls_dependencies WHERE to_file_id=?`, [fileId]
      );
      return rows.map(r => r.from_file_id as UUID);
    });
  }

  async getReferences(symbolId: UUID): Promise<Result<ReadonlyArray<ReferenceLocation>>> {
    const cached = await this._getLevelJSON<ReferenceLocation[]>(LevelKey.ref(symbolId));
    if (cached !== null) return ok(cached);

    return tryResultAsync<ReadonlyArray<ReferenceLocation>>(async () => {
      const rows = await this._sql.query<SQLRefRow>(
        `SELECT * FROM ls_references WHERE symbol_id=? ORDER BY file_id,line`, [symbolId]
      );
      return rows.map(rowToRef);
    });
  }

  // ── Cross-file queries (SQLite only) ─────────────────────────

  async findSymbolsByName(
    name: string,
    opts?: { kind?: SymbolKind; exact?: boolean }
  ): Promise<Result<ReadonlyArray<SymbolNode>>> {
    return tryResultAsync<ReadonlyArray<SymbolNode>>(async () => {
      const pattern    = opts?.exact ? name : `%${name}%`;
      const kindClause = opts?.kind ? `AND kind = ?` : "";
      const params: unknown[] = [pattern, ...(opts?.kind ? [opts.kind] : [])];

      const rows = await this._sql.query<SQLSymbolRow>(
        `SELECT * FROM ls_symbols
         WHERE name LIKE ? ${kindClause}
         ORDER BY name, file_id
         LIMIT 100`,
        params
      );
      return rows.map(rowToSymbol);
    });
  }

  async findDefinitions(symbolId: UUID): Promise<Result<ReadonlyArray<ReferenceLocation>>> {
    return tryResultAsync<ReadonlyArray<ReferenceLocation>>(async () => {
      const rows = await this._sql.query<SQLRefRow>(
        `SELECT * FROM ls_references WHERE symbol_id=? AND is_decl=1`, [symbolId]
      );
      return rows.map(rowToRef);
    });
  }

  async findImporters(specifier: string): Promise<Result<ReadonlyArray<UUID>>> {
    return tryResultAsync<ReadonlyArray<UUID>>(async () => {
      const rows = await this._sql.query<{ from_file_id: string }>(
        `SELECT DISTINCT from_file_id FROM ls_dependencies
         WHERE raw_specifier = ?
            OR raw_specifier LIKE ?`,
        [specifier, `%/${specifier}`]
      );
      return rows.map(r => r.from_file_id as UUID);
    });
  }

  async getStats(): Promise<Result<GraphStats>> {
    return tryResultAsync<GraphStats>(async () => {
      const [symCount]  = await this._sql.query<{ c: number }>(`SELECT COUNT(*) as c FROM ls_symbols`);
      const [fileCount] = await this._sql.query<{ c: number }>(`SELECT COUNT(DISTINCT file_id) as c FROM ls_symbols`);
      const [edgeCount] = await this._sql.query<{ c: number }>(`SELECT COUNT(*) as c FROM ls_dependencies`);
      const [refCount]  = await this._sql.query<{ c: number }>(`SELECT COUNT(*) as c FROM ls_references`);

      return {
        symbolCount:    symCount?.c    ?? 0,
        fileCount:      fileCount?.c   ?? 0,
        edgeCount:      edgeCount?.c   ?? 0,
        referenceCount: refCount?.c    ?? 0,
        lastUpdated:    Date.now(),
      };
    });
  }

  // ── Internal helpers ─────────────────────────────────────────

  private async _getLevelJSON<T>(key: string): Promise<T | null> {
    try {
      const raw = await this._level.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}

// ── SQLite row → domain type mappers ─────────────────────────
// Module-private — GraphStorage dışına sızmaz.

interface SQLSymbolRow {
  id: string; file_id: string; name: string; kind: string;
  scope: string; line: number; col: number; end_line: number;
  end_col: number; parent_id: string | null; exported_as: string | null;
  checksum: number; version: number;   // [H]
}

function rowToSymbol(r: SQLSymbolRow): SymbolNode {
  return {
    id:         r.id          as UUID,
    fileId:     r.file_id     as UUID,
    name:       r.name,
    kind:       r.kind        as SymbolKind,
    scope:      r.scope       as SymbolScope,  // [I] as any kaldırıldı
    line:       r.line,
    col:        r.col,
    endLine:    r.end_line,
    endCol:     r.end_col,
    parentId:   r.parent_id   as UUID | null,
    exportedAs: r.exported_as,
    checksum:   r.checksum    as Checksum32,   // [I]
    version:    r.version,                     // [H]
  };
}

interface SQLDepRow {
  id: string;                          // [J]
  from_file_id: string; to_file_id: string; kind: string;
  raw_specifier: string; imported_names: string;
  is_truncated: number;                // [J]
  line: number; is_resolved: number;
}

function rowToDep(r: SQLDepRow): DependencyEdge {
  let names: string[] = [];
  try {
    names = JSON.parse(r.imported_names);  // [C] try/catch koruması
  } catch {}

  return {
    id:            r.id           as UUID,       // [J]
    fromFileId:    r.from_file_id as UUID,
    toFileId:      r.to_file_id   as UUID,
    kind:          r.kind         as EdgeKind,
    rawSpecifier:  r.raw_specifier,
    importedNames: names,
    isTruncated:   r.is_truncated === 1,         // [J]
    line:          r.line,
    isResolved:    r.is_resolved  === 1,
  };
}

interface SQLRefRow {
  id: string;                          // [K]
  symbol_id: string; file_id: string;
  line: number; col: number; end_col: number;
  is_write: number; is_decl: number;
}

function rowToRef(r: SQLRefRow): ReferenceLocation {
  return {
    id:       r.id        as UUID,     // [K]
    symbolId: r.symbol_id as UUID,
    fileId:   r.file_id   as UUID,
    line:     r.line,
    col:      r.col,
    endCol:   r.end_col,
    isWrite:  r.is_write  === 1,
    isDecl:   r.is_decl   === 1,
  };
}
