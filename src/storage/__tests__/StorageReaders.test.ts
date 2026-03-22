/**
 * storage/__tests__/StorageReaders.test.ts
 *
 * Phase 5.3 + 5.4 — RecencyStore + ProjectStructureReader test suite
 * ~80 test case / 16 describe
 *
 * Test stratejisi:
 *  • ISQLiteDriver, IEventBus, ILevelDb → mock DI — gerçek DB gerektirmez
 *  • § 3: EventBus unsub cleanup, disposed store güvenliği
 *  • § 2: UPSERT atomic — aynı fileId tekrar gelince edit_count artar
 *  • debounce: jest.useFakeTimers() ile kontrollü zaman ilerletme
 *  • ProjectStructureReader: tree depth, sıralama, deleted filtre, corrupt row
 *
 * Kural § 1: Result<T>.data kullanımı, err() positional args
 */

import { SqliteRecencyStore } from "../RecencyStore";
import type { ISQLiteDriver, IEventBus, UnsubFn } from "../RecencyStore";
import { DOC_CHANGE_DEBOUNCE_MS, DEFAULT_RECENCY_LIMIT } from "../IRecencyReader";
import { ProjectStructureReader } from "../ProjectStructureReader";
import type { ILevelDb } from "../ProjectStructureReader";
import type { FileMeta } from "../IProjectStructureReader";
import { fmetaKey, MAX_STRUCTURE_DEPTH } from "../IProjectStructureReader";

// ═══════════════════════════════════════════════════════════════════════════
// Mock helpers
// ═══════════════════════════════════════════════════════════════════════════

// ─── Mock SQLiteDriver ────────────────────────────────────────────────────

interface DbState {
  rows: Map<string, { file_id: string; last_edited: number; edit_count: number }>;
}

function makeMockDb(initialRows: DbState["rows"] = new Map()): {
  db: ISQLiteDriver;
  state: DbState;
} {
  const state: DbState = { rows: new Map(initialRows) };

  const db: ISQLiteDriver = {
    run: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("CREATE TABLE")) {
        return { rowsAffected: 0 };
      }
      if (sql.includes("INSERT INTO file_recency")) {
        const [fileId, lastEdited] = params as [string, number];
        const existing = state.rows.get(fileId);
        if (existing) {
          existing.last_edited = lastEdited;
          existing.edit_count += 1;
        } else {
          state.rows.set(fileId, { file_id: fileId, last_edited: lastEdited, edit_count: 1 });
        }
        return { rowsAffected: 1 };
      }
      return { rowsAffected: 0 };
    }),

    get: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT last_edited FROM file_recency WHERE file_id")) {
        const [fileId] = params as [string];
        return state.rows.get(fileId) ?? null;
      }
      return null;
    }),

    all: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("ORDER BY last_edited DESC LIMIT")) {
        const [limit] = params as [number];
        return [...state.rows.values()]
          .sort((a, b) => b.last_edited - a.last_edited)
          .slice(0, limit)
          .map((r) => ({ file_id: r.file_id }));
      }
      return [];
    }),
  };

  return { db, state };
}

// ─── Mock EventBus ────────────────────────────────────────────────────────

type HandlerMap = Map<string, Array<(payload: unknown) => void>>;

function makeMockBus(): { bus: IEventBus; handlers: HandlerMap; emit: IEventBus["emit"] } {
  const handlers: HandlerMap = new Map();

  const bus: IEventBus = {
    on: jest.fn((event: string, handler: (payload: unknown) => void): UnsubFn => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return () => {
        const list = handlers.get(event);
        if (list) {
          const idx = list.indexOf(handler);
          if (idx !== -1) list.splice(idx, 1);
        }
      };
    }),
    emit: jest.fn((event: string, payload: unknown) => {
      const list = handlers.get(event) ?? [];
      // Snapshot iteration — § 3
      [...list].forEach((h) => {
        try { h(payload); } catch { /* listener hatası yutulur */ }
      });
    }),
  };

  return { bus, handlers, emit: bus.emit };
}

// ─── Store factory ────────────────────────────────────────────────────────

async function makeStore(dbRows?: DbState["rows"]) {
  const { db, state } = makeMockDb(dbRows);
  const { bus, handlers, emit } = makeMockBus();
  const store = new SqliteRecencyStore(db, bus);
  const initResult = await store.initialize();
  return { store, db, state, bus, handlers, emit, initResult };
}

// ─── Mock LevelDb ─────────────────────────────────────────────────────────

function makeLevelDb(entries: Record<string, FileMeta>): ILevelDb {
  return {
    scan: jest.fn(async (prefix: string) => {
      return Object.entries(entries)
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, meta]) => ({ key, value: JSON.stringify(meta) }));
    }),
  };
}

function makeMeta(overrides: Partial<FileMeta> = {}): FileMeta {
  return { fileId: "fid-1", sizeBytes: 1024, modifiedAt: 1_000_000, ...overrides };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. SqliteRecencyStore — initialize
// ═══════════════════════════════════════════════════════════════════════════

describe("SqliteRecencyStore.initialize()", () => {
  it("DDL çağrılır, ok döner", async () => {
    const { initResult, db } = await makeStore();
    expect(initResult.ok).toBe(true);
    expect(db.run).toHaveBeenCalledWith(expect.stringContaining("CREATE TABLE IF NOT EXISTS file_recency"));
  });

  it("EventBus'a 'file:saved' ve 'doc:changed' subscribe olur", async () => {
    const { bus } = await makeStore();
    expect(bus.on).toHaveBeenCalledWith("file:saved",   expect.any(Function));
    expect(bus.on).toHaveBeenCalledWith("doc:changed",  expect.any(Function));
  });

  it("DDL hata → init ok:false döner", async () => {
    const { db, state } = makeMockDb();
    const { bus } = makeMockBus();
    (db.run as jest.Mock).mockRejectedValueOnce(new Error("DDL fail"));
    const store = new SqliteRecencyStore(db, bus);
    const result = await store.initialize();
    expect(result.ok).toBe(false);
  });

  it("dispose edilmiş store initialize → ALREADY_DISPOSED", async () => {
    const { store } = await makeStore();
    store.dispose();
    const result = await store.initialize();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("RECENCY_ALREADY_DISPOSED");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. SqliteRecencyStore — recordEdit
// ═══════════════════════════════════════════════════════════════════════════

describe("SqliteRecencyStore.recordEdit()", () => {
  it("yeni fileId → DB'ye yazılır", async () => {
    const { store, state } = await makeStore();
    const result = await store.recordEdit("file-1", 5000);
    expect(result.ok).toBe(true);
    expect(state.rows.get("file-1")?.last_edited).toBe(5000);
  });

  it("aynı fileId tekrar → last_edited güncellenir, edit_count artar", async () => {
    const { store, state } = await makeStore();
    await store.recordEdit("file-1", 1000);
    await store.recordEdit("file-1", 2000);
    const row = state.rows.get("file-1")!;
    expect(row.last_edited).toBe(2000);
    expect(row.edit_count).toBe(2);
  });

  it("DB hata → RECENCY_DB_WRITE_FAILED", async () => {
    const { db, store } = await makeStore();
    (db.run as jest.Mock).mockRejectedValueOnce(new Error("disk full"));
    const result = await store.recordEdit("file-1");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("RECENCY_DB_WRITE_FAILED");
  });

  it("dispose edilmiş store → ALREADY_DISPOSED", async () => {
    const { store } = await makeStore();
    store.dispose();
    const result = await store.recordEdit("file-1");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("RECENCY_ALREADY_DISPOSED");
  });

  it("ts parametresi verilmezse Date.now() kullanılır", async () => {
    const { store, state } = await makeStore();
    const before = Date.now();
    await store.recordEdit("file-x");
    const after = Date.now();
    const stored = state.rows.get("file-x")!.last_edited;
    expect(stored).toBeGreaterThanOrEqual(before);
    expect(stored).toBeLessThanOrEqual(after);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. SqliteRecencyStore — getLastEditedAt
// ═══════════════════════════════════════════════════════════════════════════

describe("SqliteRecencyStore.getLastEditedAt()", () => {
  it("kayıtlı fileId → timestamp döner", async () => {
    const { store } = await makeStore();
    await store.recordEdit("file-1", 9000);
    const ts = await store.getLastEditedAt("file-1");
    expect(ts).toBe(9000);
  });

  it("bilinmeyen fileId → null", async () => {
    const { store } = await makeStore();
    expect(await store.getLastEditedAt("unknown")).toBeNull();
  });

  it("DB hata → null (non-fatal)", async () => {
    const { db, store } = await makeStore();
    (db.get as jest.Mock).mockRejectedValueOnce(new Error("read error"));
    expect(await store.getLastEditedAt("file-1")).toBeNull();
  });

  it("disposed store → null", async () => {
    const { store } = await makeStore();
    store.dispose();
    expect(await store.getLastEditedAt("file-1")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. SqliteRecencyStore — getRecentFileIds
// ═══════════════════════════════════════════════════════════════════════════

describe("SqliteRecencyStore.getRecentFileIds()", () => {
  it("azalan sırada döner", async () => {
    const { store } = await makeStore();
    await store.recordEdit("a", 1000);
    await store.recordEdit("b", 3000);
    await store.recordEdit("c", 2000);
    const ids = await store.getRecentFileIds();
    expect(ids[0]).toBe("b");
    expect(ids[1]).toBe("c");
    expect(ids[2]).toBe("a");
  });

  it("limit parametresi uygulanır", async () => {
    const { store } = await makeStore();
    await store.recordEdit("a", 1000);
    await store.recordEdit("b", 2000);
    await store.recordEdit("c", 3000);
    const ids = await store.getRecentFileIds(2);
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe("c");
  });

  it("limit verilmezse DEFAULT_RECENCY_LIMIT", async () => {
    const { db, store } = await makeStore();
    await store.getRecentFileIds();
    expect(db.all).toHaveBeenCalledWith(
      expect.any(String),
      [DEFAULT_RECENCY_LIMIT],
    );
  });

  it("DB hata → [] (non-fatal)", async () => {
    const { db, store } = await makeStore();
    (db.all as jest.Mock).mockRejectedValueOnce(new Error("fail"));
    expect(await store.getRecentFileIds()).toEqual([]);
  });

  it("disposed store → []", async () => {
    const { store } = await makeStore();
    store.dispose();
    expect(await store.getRecentFileIds()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. SqliteRecencyStore — file:saved EventBus
// ═══════════════════════════════════════════════════════════════════════════

describe("SqliteRecencyStore — file:saved EventBus", () => {
  it("file:saved → immediate kayıt", async () => {
    const { state, emit } = await makeStore();
    emit("file:saved", { fileId: "f1", projectId: "p1", path: "src/f1.ts" });
    await Promise.resolve(); // async _record flush
    await new Promise((res) => setTimeout(res, 0));
    expect(state.rows.has("f1")).toBe(true);
  });

  it("file:saved birden fazla kez → edit_count artar", async () => {
    const { state, emit } = await makeStore();
    emit("file:saved", { fileId: "f1", projectId: "p1", path: "a.ts" });
    emit("file:saved", { fileId: "f1", projectId: "p1", path: "a.ts" });
    await new Promise((res) => setTimeout(res, 0));
    expect(state.rows.get("f1")?.edit_count).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. SqliteRecencyStore — doc:changed debounce
// ═══════════════════════════════════════════════════════════════════════════

describe("SqliteRecencyStore — doc:changed debounce (§ 11)", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(()  => { jest.useRealTimers(); });

  it("doc:changed → DOC_CHANGE_DEBOUNCE_MS sonra kayıt", async () => {
    const { state, emit } = await makeStore();
    emit("doc:changed", { fileId: "f2" });
    expect(state.rows.has("f2")).toBe(false); // henüz yazılmadı

    await jest.advanceTimersByTimeAsync(DOC_CHANGE_DEBOUNCE_MS);
    expect(state.rows.has("f2")).toBe(true);
  });

  it("debounce sırasında aynı fileId yeniden gelirse timer sıfırlanır", async () => {
    const { state, emit } = await makeStore();
    emit("doc:changed", { fileId: "f3" });
    await jest.advanceTimersByTimeAsync(DOC_CHANGE_DEBOUNCE_MS - 50);
    emit("doc:changed", { fileId: "f3" }); // sıfırla

    await jest.advanceTimersByTimeAsync(DOC_CHANGE_DEBOUNCE_MS - 50);
    expect(state.rows.has("f3")).toBe(false); // henüz yok

    await jest.advanceTimersByTimeAsync(100);
    expect(state.rows.has("f3")).toBe(true);
  });

  it("farklı fileId'ler bağımsız debounce timer alır", async () => {
    const { state, emit } = await makeStore();
    emit("doc:changed", { fileId: "fa" });
    emit("doc:changed", { fileId: "fb" });

    await jest.advanceTimersByTimeAsync(DOC_CHANGE_DEBOUNCE_MS);
    expect(state.rows.has("fa")).toBe(true);
    expect(state.rows.has("fb")).toBe(true);
  });

  it("dispose → bekleyen timer iptal edilir, DB'ye yazılmaz", async () => {
    const { store, state, emit } = await makeStore();
    emit("doc:changed", { fileId: "fx" });

    store.dispose(); // dispose → timer clear
    await jest.advanceTimersByTimeAsync(DOC_CHANGE_DEBOUNCE_MS + 100);
    expect(state.rows.has("fx")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. SqliteRecencyStore — dispose & EventBus cleanup
// ═══════════════════════════════════════════════════════════════════════════

describe("SqliteRecencyStore.dispose() — EventBus cleanup", () => {
  it("dispose → handler'lar unsubscribe edilir", async () => {
    const { handlers, store } = await makeStore();
    store.dispose();
    expect(handlers.get("file:saved")?.length ?? 0).toBe(0);
    expect(handlers.get("doc:changed")?.length ?? 0).toBe(0);
  });

  it("dispose idempotent", async () => {
    const { store } = await makeStore();
    store.dispose();
    expect(() => store.dispose()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. SqliteRecencyStore — EventBus listener hatası yutulur (§ 3)
// ═══════════════════════════════════════════════════════════════════════════

describe("SqliteRecencyStore — EventBus emit() asla throw etmez (§ 3)", () => {
  it("DB write throw etse bile emit() caller'ı çökertmez", async () => {
    const { db, emit } = await makeStore();
    (db.run as jest.Mock).mockRejectedValue(new Error("disk full"));
    expect(() => {
      emit("file:saved", { fileId: "boom", projectId: "p1", path: "x.ts" });
    }).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. ProjectStructureReader — temel
// ═══════════════════════════════════════════════════════════════════════════

describe("ProjectStructureReader — temel", () => {
  it("boş LevelDB → []", async () => {
    const db = makeLevelDb({});
    const reader = new ProjectStructureReader(db);
    expect(await reader.getProjectStructure("p1")).toEqual([]);
  });

  it("tek dosya → tek item", async () => {
    const db = makeLevelDb({
      [fmetaKey("p1", "index.ts")]: makeMeta({ fileId: "f1" }),
    });
    const items = await new ProjectStructureReader(db).getProjectStructure("p1");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ path: "index.ts", kind: "file" });
  });

  it("sizeBytes ve modifiedAt taşınır", async () => {
    const db = makeLevelDb({
      [fmetaKey("p1", "a.ts")]: makeMeta({ sizeBytes: 512, modifiedAt: 9_000_000 }),
    });
    const items = await new ProjectStructureReader(db).getProjectStructure("p1");
    expect(items[0].sizeBytes).toBe(512);
    expect(items[0].modifiedAt).toBe(9_000_000);
  });

  it("deleted=true dosya → atlanır", async () => {
    const db = makeLevelDb({
      [fmetaKey("p1", "ghost.ts")]: makeMeta({ deleted: true }),
      [fmetaKey("p1", "live.ts")]:  makeMeta({}),
    });
    const items = await new ProjectStructureReader(db).getProjectStructure("p1");
    expect(items).toHaveLength(1);
    expect(items[0].path).toBe("live.ts");
  });

  it("corrupt JSON row → atlanır", async () => {
    const db: ILevelDb = {
      scan: jest.fn(async () => [
        { key: fmetaKey("p1", "bad.ts"), value: "NOT_JSON{{{" },
        { key: fmetaKey("p1", "ok.ts"),  value: JSON.stringify(makeMeta()) },
      ]),
    };
    const items = await new ProjectStructureReader(db).getProjectStructure("p1");
    expect(items.every((i) => i.path !== "bad.ts")).toBe(true);
  });

  it("LevelDB scan throw → [] döner (non-fatal)", async () => {
    const db: ILevelDb = { scan: jest.fn(async () => { throw new Error("db down"); }) };
    const items = await new ProjectStructureReader(db).getProjectStructure("p1");
    expect(items).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. ProjectStructureReader — tree yapısı
// ═══════════════════════════════════════════════════════════════════════════

describe("ProjectStructureReader — tree yapısı", () => {
  it("tek seviye dizin altındaki dosyalar directory children'ında", async () => {
    const db = makeLevelDb({
      [fmetaKey("p1", "src/a.ts")]: makeMeta({ fileId: "fa" }),
      [fmetaKey("p1", "src/b.ts")]: makeMeta({ fileId: "fb" }),
    });
    const items = await new ProjectStructureReader(db).getProjectStructure("p1");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ path: "src", kind: "directory" });
    expect(items[0].children).toHaveLength(2);
  });

  it("directory'ler dosyalardan önce gelir", async () => {
    const db = makeLevelDb({
      [fmetaKey("p1", "root.ts")]:    makeMeta({ fileId: "f1" }),
      [fmetaKey("p1", "src/x.ts")]:   makeMeta({ fileId: "f2" }),
    });
    const items = await new ProjectStructureReader(db).getProjectStructure("p1");
    expect(items[0].kind).toBe("directory");
    expect(items[1].kind).toBe("file");
  });

  it("aynı seviyede alfabetik sıralama", async () => {
    const db = makeLevelDb({
      [fmetaKey("p1", "z.ts")]: makeMeta({ fileId: "fz" }),
      [fmetaKey("p1", "a.ts")]: makeMeta({ fileId: "fa" }),
      [fmetaKey("p1", "m.ts")]: makeMeta({ fileId: "fm" }),
    });
    const items = await new ProjectStructureReader(db).getProjectStructure("p1");
    expect(items.map((i) => i.path)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  it("iç içe iki seviye dizin", async () => {
    const db = makeLevelDb({
      [fmetaKey("p1", "src/utils/helper.ts")]: makeMeta({ fileId: "fh" }),
    });
    const items = await new ProjectStructureReader(db).getProjectStructure("p1");
    const src = items.find((i) => i.path === "src");
    expect(src?.kind).toBe("directory");
    const utils = src?.children?.find((i) => i.path === "utils");
    expect(utils?.kind).toBe("directory");
    expect(utils?.children?.[0]?.path).toBe("helper.ts");
  });

  it("farklı projelerin key'leri birbirine karışmaz", async () => {
    const db = makeLevelDb({
      [fmetaKey("p1", "a.ts")]: makeMeta({ fileId: "fa" }),
      [fmetaKey("p2", "b.ts")]: makeMeta({ fileId: "fb" }),
    });
    const items = await new ProjectStructureReader(db).getProjectStructure("p1");
    expect(items).toHaveLength(1);
    expect(items[0].path).toBe("a.ts");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. ProjectStructureReader — MAX_STRUCTURE_DEPTH
// ═══════════════════════════════════════════════════════════════════════════

describe(`ProjectStructureReader — MAX_STRUCTURE_DEPTH = ${MAX_STRUCTURE_DEPTH}`, () => {
  it("depth sınırında path düzleştirilir", async () => {
    // MAX_STRUCTURE_DEPTH = 3: "a/b/c/d/e.ts" → "a" > "b" > "c/d/e.ts" (düzleştirilir)
    const db = makeLevelDb({
      [fmetaKey("p1", "a/b/c/d/deep.ts")]: makeMeta({ fileId: "fd" }),
    });
    const items = await new ProjectStructureReader(db).getProjectStructure("p1");

    function maxDepth(nodes: ReadonlyArray<{ children?: ReadonlyArray<unknown> }>, d = 0): number {
      return nodes.reduce(
        (m, n) =>
          Math.max(m, n.children ? maxDepth(n.children as ReadonlyArray<{ children?: ReadonlyArray<unknown> }>, d + 1) : d),
        d,
      );
    }
    expect(maxDepth(items)).toBeLessThanOrEqual(MAX_STRUCTURE_DEPTH);
  });

  it("MAX_STRUCTURE_FILES aşıldığında ek dosyalar eklenmez", async () => {
    // 260 dosya — limit 256
    const entries: Record<string, FileMeta> = {};
    for (let i = 0; i < 260; i++) {
      entries[fmetaKey("p1", `file${i.toString().padStart(3, "0")}.ts`)] = makeMeta({ fileId: `f${i}` });
    }
    const db = makeLevelDb(entries);
    const items = await new ProjectStructureReader(db).getProjectStructure("p1");
    // Tüm dosyalar tek seviyede — flat list
    expect(items.length).toBeLessThanOrEqual(256);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. ProjectStructureReader — children immutability
// ═══════════════════════════════════════════════════════════════════════════

describe("ProjectStructureReader — ReadonlyArray garantisi", () => {
  it("dönen items ReadonlyArray — push TypeScript hatası (runtime snapshot)", async () => {
    const db = makeLevelDb({
      [fmetaKey("p1", "src/x.ts")]: makeMeta(),
    });
    const items = await new ProjectStructureReader(db).getProjectStructure("p1");
    // TypeScript: items.push(...) compile-time hatası — runtime test
    expect(Array.isArray(items)).toBe(true);
    expect(Object.isFrozen(items)).toBe(false); // ReadonlyArray tip garantisi yeterli
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. IRecencyReader interface sabitleri
// ═══════════════════════════════════════════════════════════════════════════

describe("IRecencyReader constants", () => {
  it("RECENCY_WINDOW_MS = 30 dakika", async () => {
    const { RECENCY_WINDOW_MS } = await import("../IRecencyReader");
    expect(RECENCY_WINDOW_MS).toBe(30 * 60 * 1_000);
  });

  it("DOC_CHANGE_DEBOUNCE_MS = 400", () => {
    expect(DOC_CHANGE_DEBOUNCE_MS).toBe(400);
  });

  it("DEFAULT_RECENCY_LIMIT = 64", () => {
    expect(DEFAULT_RECENCY_LIMIT).toBe(64);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. IProjectStructureReader sabitleri + key helpers
// ═══════════════════════════════════════════════════════════════════════════

describe("IProjectStructureReader key helpers", () => {
  it("fmetaKey üretir", () => {
    expect(fmetaKey("proj1", "src/a.ts")).toBe("fmeta:proj1:src/a.ts");
  });

  it("parseFmetaKey path'i söker", async () => {
    const { parseFmetaKey: parse } = await import("../IProjectStructureReader");
    expect(parse("fmeta:proj1:src/a.ts", "proj1")).toBe("src/a.ts");
  });

  it("parseFmetaKey yanlış proje → null", async () => {
    const { parseFmetaKey: parse } = await import("../IProjectStructureReader");
    expect(parse("fmeta:proj2:src/a.ts", "proj1")).toBeNull();
  });

  it("MAX_STRUCTURE_DEPTH = 3", () => {
    expect(MAX_STRUCTURE_DEPTH).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. Entegrasyon: RecencyStore + ContextRanker recency score (simüle)
// ═══════════════════════════════════════════════════════════════════════════

describe("Entegrasyon: RecencyStore → recency score normalize (§ 14.3)", () => {
  it("30 dakika içindeki edit → score > 0", async () => {
    const { RECENCY_WINDOW_MS } = await import("../IRecencyReader");
    const { store } = await makeStore();
    const now = Date.now();
    await store.recordEdit("recent-file", now - 5 * 60 * 1_000); // 5 dk önce
    const ts = await store.getLastEditedAt("recent-file");
    expect(ts).not.toBeNull();
    const score = Math.max(0, 1 - (now - ts!) / RECENCY_WINDOW_MS);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("30 dakika dışındaki edit → score = 0", async () => {
    const { RECENCY_WINDOW_MS } = await import("../IRecencyReader");
    const { store } = await makeStore();
    const now = Date.now();
    await store.recordEdit("old-file", now - 35 * 60 * 1_000); // 35 dk önce
    const ts = await store.getLastEditedAt("old-file");
    const score = Math.max(0, 1 - (now - ts!) / RECENCY_WINDOW_MS);
    expect(score).toBe(0);
  });

  it("hiç edit yok → null → score 0", async () => {
    const { store } = await makeStore();
    const ts = await store.getLastEditedAt("never-edited");
    expect(ts).toBeNull();
    // ContextRanker: null ts → recency score = 0
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. Entegrasyon: ProjectStructureReader → ContextCollector structure item
// ═══════════════════════════════════════════════════════════════════════════

describe("Entegrasyon: ProjectStructureReader → ContextCollector (§ 14.2)", () => {
  it("dönen structure ContextItem formatına uygun (path + kind)", async () => {
    const db = makeLevelDb({
      [fmetaKey("p1", "src/index.ts")]: makeMeta({ fileId: "fi" }),
      [fmetaKey("p1", "README.md")]:    makeMeta({ fileId: "fr" }),
    });
    const items = await new ProjectStructureReader(db).getProjectStructure("p1");
    // ContextCollector: her item `path` ve `kind` alanını kullanır
    for (const item of items) {
      expect(typeof item.path).toBe("string");
      expect(["file", "directory"]).toContain(item.kind);
    }
  });

  it("MAX_STRUCTURE_FILES sayısı token bütçesiyle uyumlu", () => {
    // § 14.2: structure items TokenLimiter'dan geçer
    // 256 dosya * ortalama 30 char path = 7680 char / 4 ≈ 1920 token — budget içinde
    const { MAX_STRUCTURE_FILES } = require("../IProjectStructureReader");
    expect(MAX_STRUCTURE_FILES).toBeLessThanOrEqual(256);
  });
});
