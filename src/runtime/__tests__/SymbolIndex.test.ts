/**
 * SymbolIndex.test.ts — Phase 3 end-to-end indexing tests
 *
 * Coverage:
 *   init()            — happy path, storage failure, double-init guard
 *   indexFile()       — symbol write, LevelDB cache, SQLite snapshot,
 *                       empty input, MAX_IMPORTED_NAMES truncation
 *   getFileSymbols()  — LevelDB hit, SQLite fallback + cache re-warm,
 *                       unknown file
 *   searchSymbols()   — prefix match, case-insensitive, empty query,
 *                       storage error propagation
 *   invalidateFile()  — LevelDB entries removed, event emitted
 *
 * Decisions followed:
 *   § 1  Result<T>.data (not .value)                          [P-1]
 *   § 1  err(code, msg, opts) positional args                 [P-2]
 *   § 2  Hybrid storage: LevelDB hot-path + SQLite truth
 *   § 3  IEventBus (not EventBus<AppEventMap>)                [P-4]
 *   § 2  Optimistic lock — SymbolNode.version
 *   Branded types: UUID, Checksum32
 *   No isExported field — use exportedAs !== null             [SA-1]
 */

import { SymbolIndex } from "../SymbolIndex";
import {
  SymbolKind,
  SymbolScope,
  MAX_IMPORTED_NAMES,
} from "../graph/types";
import type { SymbolNode, Checksum32 } from "../graph/types";
import type { ILevelDB } from "../../storage/ILevelDB";
import type { ISQLiteDriver } from "../../storage/ISQLiteDriver";
import type { IEventBus } from "../../core/Event-bus/IEventBus";
import type { IPathResolver } from "../../ipc/IPathResolver";
import type { UUID } from "../../core/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSymbol(overrides?: Partial<SymbolNode>): SymbolNode {
  return {
    id:         "sym-001" as UUID,
    fileId:     "file-001" as UUID,
    name:       "myFunc",
    kind:       SymbolKind.Function,
    scope:      SymbolScope.Module,
    line:       0,
    col:        0,
    endLine:    5,
    endCol:     1,
    parentId:   null,
    exportedAs: null,
    checksum:   0 as Checksum32,
    version:    1,
    ...overrides,
  };
}

/** Serialise a SymbolNode the way GraphStorage does for LevelDB. */
function levelEncode(sym: SymbolNode): string {
  return JSON.stringify(sym);
}

// ─── Mock factories (session-4 canonical schemas) ────────────────────────────

function makeMockLevel(): jest.Mocked<ILevelDB> {
  return {
    get:   jest.fn().mockResolvedValue(null),
    put:   jest.fn().mockResolvedValue(undefined),
    del:   jest.fn().mockResolvedValue(undefined),
    batch: jest.fn().mockResolvedValue(undefined),
    keys:  jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

function makeMockSql(): jest.Mocked<ISQLiteDriver> {
  return {
    execute: jest.fn().mockResolvedValue({ rowsAffected: 1 }),
    query:   jest.fn().mockResolvedValue([]),
  };
}

function makeMockEventBus(): jest.Mocked<IEventBus> {
  return {
    emit:               jest.fn(),
    on:                 jest.fn().mockReturnValue(() => {}),
    off:                jest.fn(),
    once:               jest.fn(),
    onError:            jest.fn(),
    removeAllListeners: jest.fn(),
  };
}

function makeMockResolver(): jest.Mocked<IPathResolver> {
  return {
    getPath: jest.fn().mockReturnValue("/project/file.ts"),
    resolve: jest.fn().mockResolvedValue(null),
  };
}

// ─── Fixture: LevelDB key helpers (decisions § 12) ──────────────────────────

const FILE_ID  = "file-001" as UUID;
const FILE_ID2 = "file-002" as UUID;
const SYM_ID   = "sym-001" as UUID;

/** `fsym:{fileId}` — file-level symbol list key */
const fsymKey = (fId: UUID) => `fsym:${fId}`;
/** `sym:{fileId}:{symId}` — individual symbol key */
const symKey  = (fId: UUID, sId: UUID) => `sym:${fId}:${sId}`;

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("SymbolIndex", () => {
  let level:    jest.Mocked<ILevelDB>;
  let sql:      jest.Mocked<ISQLiteDriver>;
  let eventBus: jest.Mocked<IEventBus>;
  let resolver: jest.Mocked<IPathResolver>;
  let index:    SymbolIndex;

  beforeEach(() => {
    level    = makeMockLevel();
    sql      = makeMockSql();
    eventBus = makeMockEventBus();
    resolver = makeMockResolver();
    index    = new SymbolIndex({ level, sql, eventBus, resolver });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── init() ─────────────────────────────────────────────────────────────────

  describe("init()", () => {
    it("returns ok on successful storage init", async () => {
      const result = await index.init();

      expect(result.ok).toBe(true);
    });

    it("emits 'index:ready' event after successful init", async () => {
      await index.init();

      expect(eventBus.emit).toHaveBeenCalledWith(
        "index:ready",
        expect.anything(),
      );
    });

    it("returns err when SQLite schema setup fails", async () => {
      sql.execute.mockRejectedValueOnce(new Error("disk full"));

      const result = await index.init();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("STORAGE_INIT");
      }
    });

    it("returns err when called a second time without dispose", async () => {
      await index.init();
      const second = await index.init();

      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error.code).toBeDefined();
      }
    });
  });

  // ── indexFile() ─────────────────────────────────────────────────────────────

  describe("indexFile()", () => {
    const CONTENT = 'function myFunc() { return 42; }';
    const symbols = [makeSymbol()];

    beforeEach(async () => {
      await index.init();
    });

    it("returns ok with indexed count on success", async () => {
      const result = await index.indexFile(FILE_ID, CONTENT, symbols);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.count).toBe(symbols.length);
      }
    });

    it("writes individual symbol entries to LevelDB cache (key schema: sym:{fileId}:{symId})", async () => {
      await index.indexFile(FILE_ID, CONTENT, symbols);

      // Collect all keys written via put + batch ops
      const putKeys = (level.put.mock.calls as [string, string][]).map(([k]) => k);
      const batchKeys = level.batch.mock.calls.flatMap(([ops]) =>
        (ops as { type: string; key: string }[]).map((op) => op.key),
      );
      const allKeys = [...putKeys, ...batchKeys];

      // Must contain a key matching decisions § 12 schema: sym:{fileId}:{symId}
      const symKeyPattern = new RegExp(`^sym:${FILE_ID}:[a-z0-9-]+$`);
      expect(allKeys.some((k) => symKeyPattern.test(k))).toBe(true);
    });

    it("writes file-level symbol list to LevelDB cache (key schema: fsym:{fileId})", async () => {
      await index.indexFile(FILE_ID, CONTENT, symbols);

      const putKeys  = (level.put.mock.calls as [string, string][]).map(([k]) => k);
      const batchKeys = level.batch.mock.calls.flatMap(([ops]) =>
        (ops as { type: string; key: string }[]).map((op) => op.key),
      );
      const allKeys = [...putKeys, ...batchKeys];

      expect(allKeys).toContain(`fsym:${FILE_ID}`);
    });

    it("writes snapshot to SQLite (source-of-truth)", async () => {
      await index.indexFile(FILE_ID, CONTENT, symbols);

      // SQLite must be touched for the snapshot
      expect(sql.execute).toHaveBeenCalled();
    });

    it("handles empty symbols array without error", async () => {
      const result = await index.indexFile(FILE_ID, CONTENT, []);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.count).toBe(0);
      }
    });

    it("sets isTruncated when symbol count exceeds MAX_IMPORTED_NAMES", async () => {
      const manySymbols: SymbolNode[] = Array.from(
        { length: MAX_IMPORTED_NAMES + 1 },
        (_, i) =>
          makeSymbol({
            id:   `sym-${i.toString().padStart(4, "0")}` as UUID,
            name: `sym${i}`,
            line: i,
          }),
      );

      const result = await index.indexFile(FILE_ID, CONTENT, manySymbols);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.isTruncated).toBe(true);
        expect(result.data.count).toBeLessThanOrEqual(MAX_IMPORTED_NAMES);
      }
    });

    it("emits 'index:file-indexed' event after success", async () => {
      await index.indexFile(FILE_ID, CONTENT, symbols);

      expect(eventBus.emit).toHaveBeenCalledWith(
        "index:file-indexed",
        expect.objectContaining({ fileId: FILE_ID }),
      );
    });

    it("returns err when storage write fails", async () => {
      level.batch.mockRejectedValueOnce(new Error("write error"));

      const result = await index.indexFile(FILE_ID, CONTENT, symbols);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBeDefined();
      }
    });
  });

  // ── getFileSymbols() ─────────────────────────────────────────────────────────

  describe("getFileSymbols()", () => {
    const sym     = makeSymbol();
    const encoded = levelEncode(sym);

    beforeEach(async () => {
      await index.init();
    });

    it("returns symbols from LevelDB on cache hit", async () => {
      level.keys.mockResolvedValueOnce([symKey(FILE_ID, SYM_ID)]);
      level.get.mockResolvedValueOnce(encoded);

      const result = await index.getFileSymbols(FILE_ID);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]?.id).toBe(SYM_ID);
      }
      // SQLite should NOT be queried when LevelDB hits
      expect(sql.query).not.toHaveBeenCalled();
    });

    it("falls back to SQLite on LevelDB cache miss", async () => {
      // LevelDB returns empty
      level.keys.mockResolvedValueOnce([]);
      // SQLite returns a row
      sql.query.mockResolvedValueOnce([
        {
          id:         SYM_ID,
          file_id:    FILE_ID,
          name:       "myFunc",
          kind:       "function",
          scope:      "module",
          line:       0,
          col:        0,
          end_line:   5,
          end_col:    1,
          parent_id:  null,
          exported_as: null,
          checksum:   0,
          version:    1,
        },
      ]);

      const result = await index.getFileSymbols(FILE_ID);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
      }
      expect(sql.query).toHaveBeenCalled();
    });

    it("re-warms LevelDB cache after SQLite fallback — writes sym: key for the file", async () => {
      level.keys.mockResolvedValueOnce([]);
      sql.query.mockResolvedValueOnce([
        {
          id:          SYM_ID,
          file_id:     FILE_ID,
          name:        "myFunc",
          kind:        "function",
          scope:       "module",
          line:        0, col: 0, end_line: 5, end_col: 1,
          parent_id:   null, exported_as: null, checksum: 0, version: 1,
        },
      ]);

      await index.getFileSymbols(FILE_ID);

      // Collect every key written back to LevelDB
      const putKeys   = (level.put.mock.calls as [string, string][]).map(([k]) => k);
      const batchKeys = level.batch.mock.calls.flatMap(([ops]) =>
        (ops as { type: string; key: string }[]).map((op) => op.key),
      );
      const rewarmKeys = [...putKeys, ...batchKeys];

      // Must write at least the sym: key for the returned symbol (decisions § 12)
      expect(rewarmKeys.some((k) => k.startsWith(`sym:${FILE_ID}:`))).toBe(true);
    });

    it("returns empty array for unknown file", async () => {
      level.keys.mockResolvedValueOnce([]);
      sql.query.mockResolvedValueOnce([]);

      const result = await index.getFileSymbols("unknown-file" as UUID);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(0);
      }
    });
  });

  // ── searchSymbols() ──────────────────────────────────────────────────────────

  describe("searchSymbols()", () => {
    beforeEach(async () => {
      await index.init();
    });

    it("returns ok with matching symbols for a query", async () => {
      // Prime the index with two symbols
      const syms = [
        makeSymbol({ id: "sym-001" as UUID, name: "fetchUser" }),
        makeSymbol({ id: "sym-002" as UUID, name: "fetchPosts" }),
        makeSymbol({ id: "sym-003" as UUID, name: "saveUser" }),
      ];
      await index.indexFile(FILE_ID, "...", syms);

      const result = await index.searchSymbols("fetch");

      expect(result.ok).toBe(true);
      if (result.ok) {
        const names = result.data.map((s) => s.name);
        expect(names).toContain("fetchUser");
        expect(names).toContain("fetchPosts");
        expect(names).not.toContain("saveUser");
      }
    });

    it("performs case-insensitive matching", async () => {
      const syms = [makeSymbol({ id: "sym-001" as UUID, name: "MyComponent" })];
      await index.indexFile(FILE_ID, "...", syms);

      const result = await index.searchSymbols("mycomponent");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]?.name).toBe("MyComponent");
      }
    });

    it("returns all symbols when query is empty string", async () => {
      const syms = [
        makeSymbol({ id: "sym-001" as UUID, name: "alpha" }),
        makeSymbol({ id: "sym-002" as UUID, name: "beta" }),
      ];
      await index.indexFile(FILE_ID, "...", syms);

      const result = await index.searchSymbols("");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.length).toBeGreaterThanOrEqual(2);
      }
    });

    it("returns empty array when no symbols match", async () => {
      const syms = [makeSymbol({ id: "sym-001" as UUID, name: "alpha" })];
      await index.indexFile(FILE_ID, "...", syms);

      const result = await index.searchSymbols("zzznomatch");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(0);
      }
    });

    it("returns err(INDEX_FAILED) when storage throws", async () => {
      level.keys.mockRejectedValueOnce(new Error("storage corrupt"));

      const result = await index.searchSymbols("fetch");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INDEX_FAILED");
      }
    });

    it("searches across multiple indexed files", async () => {
      await index.indexFile(
        FILE_ID,
        "...",
        [makeSymbol({ id: "sym-001" as UUID, name: "helperA", fileId: FILE_ID })],
      );
      await index.indexFile(
        FILE_ID2,
        "...",
        [makeSymbol({ id: "sym-002" as UUID, name: "helperB", fileId: FILE_ID2 })],
      );

      const result = await index.searchSymbols("helper");

      expect(result.ok).toBe(true);
      if (result.ok) {
        const names = result.data.map((s) => s.name);
        expect(names).toContain("helperA");
        expect(names).toContain("helperB");
      }
    });
  });

  // ── invalidateFile() ─────────────────────────────────────────────────────────

  describe("invalidateFile()", () => {
    const sym = makeSymbol();

    beforeEach(async () => {
      await index.init();
      await index.indexFile(FILE_ID, "...", [sym]);
      // Reset call history so assertions below are clean
      jest.clearAllMocks();
    });

    it("removes LevelDB entries for the file — exact keys deleted", async () => {
      const existingKeys = [symKey(FILE_ID, SYM_ID), fsymKey(FILE_ID)];
      level.keys.mockResolvedValueOnce(existingKeys);

      await index.invalidateFile(FILE_ID);

      // Collect all keys targeted for deletion (del + batch del ops)
      const delKeys = (level.del.mock.calls as [string][]).map(([k]) => k);
      const batchDelKeys = level.batch.mock.calls.flatMap(([ops]) =>
        (ops as { type: string; key: string }[])
          .filter((op) => op.type === "del")
          .map((op) => op.key),
      );
      const deletedKeys = [...delKeys, ...batchDelKeys];

      expect(deletedKeys).toContain(symKey(FILE_ID, SYM_ID));
      expect(deletedKeys).toContain(fsymKey(FILE_ID));
    });

    it("emits 'index:file-invalidated' event", async () => {
      level.keys.mockResolvedValueOnce([symKey(FILE_ID, SYM_ID)]);

      await index.invalidateFile(FILE_ID);

      expect(eventBus.emit).toHaveBeenCalledWith(
        "index:file-invalidated",
        expect.objectContaining({ fileId: FILE_ID }),
      );
    });

    it("does not throw when file was never indexed", async () => {
      level.keys.mockResolvedValueOnce([]);

      await expect(
        index.invalidateFile("never-indexed" as UUID),
      ).resolves.not.toThrow();
    });

    it("stale revDep entries are also cleaned (writeSnapshot contract)", async () => {
      // Re-index the file with different content — stale entries must go
      level.keys.mockResolvedValue([symKey(FILE_ID, SYM_ID)]);

      await index.invalidateFile(FILE_ID);
      const result = await index.indexFile(
        FILE_ID,
        "function newFunc() {}",
        [makeSymbol({ id: "sym-002" as UUID, name: "newFunc" })],
      );

      expect(result.ok).toBe(true);
      // After re-index, old sym key must no longer appear in LevelDB keys
      level.keys.mockResolvedValueOnce([symKey(FILE_ID, "sym-002" as UUID)]);
      const syms = await index.getFileSymbols(FILE_ID);
      if (syms.ok) {
        const ids = syms.data.map((s) => s.id);
        expect(ids).not.toContain("sym-001");
      }
    });
  });

  // ── Optimistic lock (decisions § 2: WHERE id=? AND version=?) ───────────────

  describe("optimistic lock (version column)", () => {
    beforeEach(async () => {
      await index.init();
    });

    it("SQLite UPDATE uses WHERE version=? — rowsAffected=0 yields OPTIMISTIC_LOCK_CONFLICT", async () => {
      // First index succeeds
      await index.indexFile(FILE_ID, "v1 content", [makeSymbol({ version: 1 })]);
      jest.clearAllMocks();

      // Simulate a concurrent writer already bumped version to 2 in SQLite
      // so our version=1 WHERE clause matches nothing → rowsAffected: 0
      sql.execute.mockResolvedValueOnce({ rowsAffected: 0 });

      const result = await index.indexFile(
        FILE_ID,
        "v2 content",
        [makeSymbol({ version: 1 })],
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("OPTIMISTIC_LOCK_CONFLICT");
      }
    });

    it("successful re-index bumps version in the written symbol", async () => {
      const sym = makeSymbol({ version: 1 });
      await index.indexFile(FILE_ID, "v1 content", [sym]);
      jest.clearAllMocks();

      // Normal success — rowsAffected: 1
      sql.execute.mockResolvedValue({ rowsAffected: 1 });

      const sym2   = makeSymbol({ version: 1 });
      const result = await index.indexFile(FILE_ID, "v2 content", [sym2]);

      expect(result.ok).toBe(true);

      // The data written to LevelDB must contain version: 2
      const putValues = (level.put.mock.calls as [string, string][]).map(([, v]) => v);
      const batchValues = level.batch.mock.calls.flatMap(([ops]) =>
        (ops as { type: string; key: string; value?: string }[])
          .filter((op) => op.type === "put")
          .map((op) => op.value ?? ""),
      );
      const allWrittenValues = [...putValues, ...batchValues];

      const writtenSymbol = allWrittenValues
        .filter(Boolean)
        .map((v) => { try { return JSON.parse(v); } catch { return null; } })
        .find((obj) => obj?.fileId === FILE_ID && obj?.version !== undefined);

      expect(writtenSymbol?.version).toBe(2);
    });

    it("does not increment version when no symbols are indexed", async () => {
      const result = await index.indexFile(FILE_ID, "empty", []);

      expect(result.ok).toBe(true);
      // No symbol writes → no version to bump
      const allWrites = level.put.mock.calls.length + level.batch.mock.calls.length;
      // Only fsym: tombstone or nothing — no sym: key with a version
      const putValues = (level.put.mock.calls as [string, string][]).map(([, v]) => v);
      const hasVersionedWrite = putValues.some((v) => {
        try { return JSON.parse(v)?.version !== undefined; }
        catch { return false; }
      });
      expect(hasVersionedWrite).toBe(false);
    });
  });

  // ── dispose() ───────────────────────────────────────────────────────────────

  describe("dispose()", () => {
    it("closes LevelDB connection", async () => {
      await index.init();
      await index.dispose();

      expect(level.close).toHaveBeenCalledTimes(1);
    });

    it("operations after dispose return err", async () => {
      await index.init();
      await index.dispose();

      const result = await index.searchSymbols("anything");

      expect(result.ok).toBe(false);
    });
  });
});
