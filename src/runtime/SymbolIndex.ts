/**
 * runtime/SymbolIndex.ts
 * Hybrid depolama: LevelDB hot-path cache + SQLite kaynak-of-truth.
 *
 * API:
 *   init()            — şema kurulumu, 'index:ready' yayınlar
 *   indexFile()       — semboller LevelDB + SQLite'a yazılır
 *   getFileSymbols()  — LevelDB önce, miss → SQLite fallback + cache re-warm
 *   searchSymbols()   — prefix eşleştirme, büyük/küçük harf duyarsız
 *   invalidateFile()  — LevelDB girişleri silinir, 'index:file-invalidated' yayınlanır
 *   dispose()         — LevelDB bağlantısı kapatılır
 *
 * Kararlar:
 *   § 1  Result<T>.data (not .value)
 *   § 2  Optimistic lock — SymbolNode.version: UPDATE ... WHERE version=?
 *   § 3  IEventBus (core/event-bus/IEventBus) — AppEventMap bağımlılığı yok
 *   § 12 LevelDB key şeması: sym:{fileId}:{symId}, fsym:{fileId}
 */

import type { ILevelDB }      from "../storage/ILevelDB";
import type { ISQLiteDriver } from "../storage/ISQLiteDriver";
import type { IEventBus }     from "../core/event-bus/IEventBus";
import type { IPathResolver } from "../ipc/IPathResolver";
import type { UUID }          from "../core/types";
import type { SymbolNode }    from "./graph/types";
import { MAX_IMPORTED_NAMES } from "./graph/types";

// ── Sonuç tipi (inline — core/Result'a bağımlılık yok) ───────────────────────
type Ok<T>  = { ok: true;  data: T };
type Err    = { ok: false; error: { code: string; message: string } };
type Result<T> = Ok<T> | Err;

function ok<T>(data: T): Ok<T>             { return { ok: true, data }; }
function fail(code: string, message = ""): Err {
  return { ok: false, error: { code, message } };
}

// ── Bağımlılık injection arayüzü ─────────────────────────────────────────────
export interface SymbolIndexDeps {
  level:    ILevelDB;
  sql:      ISQLiteDriver;
  eventBus: IEventBus;
  resolver: IPathResolver;
}

// ── LevelDB key yardımcıları (§ 12) ──────────────────────────────────────────
const symKey  = (fileId: UUID, symId: UUID) => `sym:${fileId}:${symId}`;
const fsymKey = (fileId: UUID)              => `fsym:${fileId}`;

// ═══════════════════════════════════════════════════════════════════════════════

export class SymbolIndex {
  private readonly _level:    ILevelDB;
  private readonly _sql:      ISQLiteDriver;
  private readonly _eventBus: IEventBus;
  private readonly _resolver: IPathResolver;

  private _initialized = false;
  private _disposed    = false;

  // In-memory search index: symId → SymbolNode
  private readonly _memIndex = new Map<string, SymbolNode>();

  constructor(deps: SymbolIndexDeps) {
    this._level    = deps.level;
    this._sql      = deps.sql;
    this._eventBus = deps.eventBus;
    this._resolver = deps.resolver;
  }

  // ── init() ─────────────────────────────────────────────────────────────────

  async init(): Promise<Result<void>> {
    if (this._disposed) return fail("DISPOSED", "SymbolIndex disposed");
    if (this._initialized) return fail("ALREADY_INITIALIZED", "init() already called");

    try {
      const ddl = `
        CREATE TABLE IF NOT EXISTS symbol_snapshots (
          file_id     TEXT NOT NULL,
          sym_id      TEXT NOT NULL,
          name        TEXT NOT NULL,
          kind        TEXT NOT NULL,
          scope       TEXT NOT NULL,
          line        INTEGER NOT NULL DEFAULT 0,
          col         INTEGER NOT NULL DEFAULT 0,
          end_line    INTEGER NOT NULL DEFAULT 0,
          end_col     INTEGER NOT NULL DEFAULT 0,
          parent_id   TEXT,
          exported_as TEXT,
          checksum    INTEGER NOT NULL DEFAULT 0,
          version     INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (file_id, sym_id)
        )
      `;
      // sql.execute preferred; fall back to sql.run for backward compat
      if (typeof this._sql.execute === "function") {
        await this._sql.execute(ddl);
      } else {
        await this._sql.run(ddl);
      }
    } catch (e) {
      return fail("STORAGE_INIT", String(e));
    }

    this._initialized = true;
    this._eventBus.emit("index:ready", { ts: Date.now() });
    return ok(undefined);
  }

  // ── indexFile() ────────────────────────────────────────────────────────────

  async indexFile(
    fileId:  UUID,
    _content: string,
    symbols: SymbolNode[],
  ): Promise<Result<{ count: number; isTruncated: boolean }>> {
    if (this._disposed) return fail("DISPOSED");

    const isTruncated = symbols.length > MAX_IMPORTED_NAMES;
    const trimmed     = isTruncated ? symbols.slice(0, MAX_IMPORTED_NAMES) : symbols;

    try {
      // ── SQLite snapshot (source-of-truth) ──────────────────────────────────
      const upsertSym = `
        INSERT INTO symbol_snapshots
          (file_id, sym_id, name, kind, scope, line, col, end_line, end_col,
           parent_id, exported_as, checksum, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_id, sym_id) DO UPDATE SET
          name=excluded.name, kind=excluded.kind, scope=excluded.scope,
          line=excluded.line, col=excluded.col,
          end_line=excluded.end_line, end_col=excluded.end_col,
          parent_id=excluded.parent_id, exported_as=excluded.exported_as,
          checksum=excluded.checksum,
          version=symbol_snapshots.version + 1
        WHERE symbol_snapshots.version = excluded.version
      `;

      for (const sym of trimmed) {
        const bumped = { ...sym, version: (sym.version ?? 1) };
        let rowsAffected = 1;
        if (typeof this._sql.execute === "function") {
          const r = await this._sql.execute(upsertSym, [
            fileId, sym.id, sym.name, sym.kind, sym.scope,
            sym.line, sym.col, sym.endLine, sym.endCol,
            sym.parentId ?? null, sym.exportedAs ?? null,
            sym.checksum, bumped.version,
          ]);
          rowsAffected = r?.rowsAffected ?? 1;
        } else {
          const r = await this._sql.run(upsertSym, [
            fileId, sym.id, sym.name, sym.kind, sym.scope,
            sym.line, sym.col, sym.endLine, sym.endCol,
            sym.parentId ?? null, sym.exportedAs ?? null,
            sym.checksum, bumped.version,
          ]);
          rowsAffected = r?.rowsAffected ?? 1;
        }
        if (rowsAffected === 0) {
          return fail("OPTIMISTIC_LOCK_CONFLICT", `Concurrent write conflict on ${sym.id}`);
        }
      }

      // ── LevelDB cache ──────────────────────────────────────────────────────
      const batchOps: Array<{ type: "put"; key: string; value: string }> = [];

      for (const sym of trimmed) {
        const written = { ...sym, version: (sym.version ?? 1) + 1 };
        batchOps.push({ type: "put", key: symKey(fileId, sym.id as UUID), value: JSON.stringify(written) });
        this._memIndex.set(sym.id as string, written as SymbolNode);
      }

      // fsym: key — list of symIds for quick invalidation
      const symIds = trimmed.map(s => s.id);
      batchOps.push({ type: "put", key: fsymKey(fileId), value: JSON.stringify(symIds) });

      await this._level.batch(batchOps);

    } catch (e) {
      return fail("INDEX_FAILED", String(e));
    }

    this._eventBus.emit("index:file-indexed", { fileId, count: trimmed.length, ts: Date.now() });
    return ok({ count: trimmed.length, isTruncated });
  }

  // ── getFileSymbols() ───────────────────────────────────────────────────────

  async getFileSymbols(fileId: UUID): Promise<Result<SymbolNode[]>> {
    if (this._disposed) return fail("DISPOSED");

    try {
      // LevelDB cache hit check
      const prefix  = `sym:${fileId}:`;
      const allKeys = await this._level.keys(prefix);
      const symKeys = allKeys.filter(k => k.startsWith(prefix));

      if (symKeys.length > 0) {
        const symbols: SymbolNode[] = [];
        for (const k of symKeys) {
          const raw = await this._level.get(k);
          if (raw) {
            try { symbols.push(JSON.parse(raw) as SymbolNode); } catch { /* skip corrupt */ }
          }
        }
        return ok(symbols);
      }

      // SQLite fallback
      let rows: Record<string, unknown>[] = [];
      if (typeof this._sql.query === "function") {
        rows = await this._sql.query<Record<string, unknown>>(
          "SELECT * FROM symbol_snapshots WHERE file_id = ?", [fileId]
        );
      } else {
        rows = await this._sql.all<Record<string, unknown>>(
          "SELECT * FROM symbol_snapshots WHERE file_id = ?", [fileId]
        );
      }

      const symbols: SymbolNode[] = rows.map(r => ({
        id:         r["id"]          as UUID,
        fileId:     r["file_id"]     as UUID,
        name:       r["name"]        as string,
        kind:       r["kind"]        as SymbolNode["kind"],
        scope:      r["scope"]       as SymbolNode["scope"],
        line:       r["line"]        as number,
        col:        r["col"]         as number,
        endLine:    r["end_line"]    as number,
        endCol:     r["end_col"]     as number,
        parentId:   r["parent_id"]   as UUID | null,
        exportedAs: r["exported_as"] as string | null,
        checksum:   r["checksum"]    as number,
        version:    r["version"]     as number,
      }));

      // Cache re-warm
      if (symbols.length > 0) {
        const rewarmOps = symbols.map(sym => ({
          type: "put" as const,
          key:   symKey(fileId, sym.id),
          value: JSON.stringify(sym),
        }));
        rewarmOps.push({
          type:  "put",
          key:   fsymKey(fileId),
          value: JSON.stringify(symbols.map(s => s.id)),
        });
        await this._level.batch(rewarmOps);
        symbols.forEach(s => this._memIndex.set(s.id as string, s));
      }

      return ok(symbols);
    } catch (e) {
      return fail("INDEX_FAILED", String(e));
    }
  }

  // ── searchSymbols() ────────────────────────────────────────────────────────

  async searchSymbols(query: string): Promise<Result<SymbolNode[]>> {
    if (this._disposed) return fail("DISPOSED");

    try {
      const prefix  = "sym:";
      const allKeys = await this._level.keys(prefix);
      const q       = query.toLowerCase();

      const symbols: SymbolNode[] = [];
      const seen    = new Set<string>();

      for (const k of allKeys) {
        if (!k.startsWith("sym:") || k.split(":").length < 3) continue;
        const raw = await this._level.get(k);
        if (!raw) continue;
        try {
          const sym = JSON.parse(raw) as SymbolNode;
          if (!seen.has(sym.id as string) && (q === "" || sym.name.toLowerCase().includes(q))) {
            symbols.push(sym);
            seen.add(sym.id as string);
          }
        } catch { /* skip */ }
      }

      // Also search in-memory index for anything not yet in LevelDB
      for (const [id, sym] of this._memIndex) {
        if (!seen.has(id) && (q === "" || sym.name.toLowerCase().includes(q))) {
          symbols.push(sym);
          seen.add(id);
        }
      }

      return ok(symbols);
    } catch (e) {
      return fail("INDEX_FAILED", String(e));
    }
  }

  // ── invalidateFile() ──────────────────────────────────────────────────────

  async invalidateFile(fileId: UUID): Promise<void> {
    if (this._disposed) return;

    try {
      const prefix  = `sym:${fileId}:`;
      const allKeys = await this._level.keys(prefix);
      const toDelete = [
        ...allKeys.filter(k => k.startsWith(prefix)),
        fsymKey(fileId),
      ];

      if (toDelete.length > 0) {
        await this._level.batch(toDelete.map(k => ({ type: "del" as const, key: k })));
      }

      // Remove from mem index
      for (const k of allKeys) {
        const parts = k.split(":");
        if (parts.length >= 3) this._memIndex.delete(parts.slice(2).join(":"));
      }
    } catch { /* swallow — file may not have been indexed */ }

    this._eventBus.emit("index:file-invalidated", { fileId, ts: Date.now() });
  }

  // ── dispose() ─────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    await this._level.close();
    this._memIndex.clear();
  }
}
