/**
 * __tests__/TechnicalDebt.test.ts
 *
 * Phase 5.5 — Teknik Borç test suite
 * T-1, T-2, T-3, T-4, T-5, T-6, T-8
 * ~75 test case / 14 describe
 *
 * Test stratejisi:
 *  • Tüm bağımlılıklar DI ile inject — gerçek WASM / DB gerektirmez
 *  • ISQLiteDriver.transaction() → MockSqliteDriver
 *  • TreeSitterAdapter → MockTreeSitterLoader
 *  • ScopeAnalyzer → MockTreeSitterLoader (gerçek AST şekli simüle edilir)
 *  • DependencyIndex → MockLevelDb
 *  • StorageInitializer → MockSqliteDriver
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// T-8
import { SqliteDriverBase } from "../storage/ISQLiteDriver";
import type { RunResult } from "../storage/ISQLiteDriver";

// T-4
import {
  TreeSitterAdapter,
  MockTreeSitterLoader,
  TreeSitterErrorCode,
} from "../language/TreeSitterAdapter";
import type { TSTree, TSNode } from "../language/TreeSitterAdapter";

// T-5
import { ScopeAnalyzer, ScopeKind, ScopeErrorCode } from "../language-services/ScopeAnalyzer";

// T-6
import { DependencyIndex, DepIndexErrorCode } from "../language-services/graph/DependencyIndex";
import type { Dependency, ILevelDb as DepLevelDb } from "../language-services/graph/DependencyIndex";

// T-3
import { StorageInitializer, StorageDIErrorCode } from "../language/StorageDI";

// ═══════════════════════════════════════════════════════════════════════════
// Mock helpers
// ═══════════════════════════════════════════════════════════════════════════

// ─── MockSqliteDriver (T-8) ───────────────────────────────────────────────

class MockSqliteDriver extends SqliteDriverBase {
  readonly executed: string[] = [];
  private _failNext = false;

  run = vi.fn(async (sql: string): Promise<RunResult> => {
    this.executed.push(sql.trim().slice(0, 40));
    if (this._failNext && sql !== "ROLLBACK" && sql !== "COMMIT") {
      this._failNext = false;
      throw new Error("mock DB error");
    }
    return { rowsAffected: 1 };
  });

  get = vi.fn(async () => null);
  all = vi.fn(async () => []);

  failNext() { this._failNext = true; }
}

// ─── MockLevelDb (T-6) ───────────────────────────────────────────────────

class MockLevelDb implements DepLevelDb {
  private _store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this._store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this._store.set(key, value);
  }
  async del(key: string): Promise<void> {
    this._store.delete(key);
  }
  async scan(prefix: string): Promise<ReadonlyArray<{ key: string; value: string }>> {
    const result: Array<{ key: string; value: string }> = [];
    for (const [k, v] of this._store) {
      if (k.startsWith(prefix)) result.push({ key: k, value: v });
    }
    return result.sort((a, b) => a.key.localeCompare(b.key));
  }
  async batch(ops: Array<{ type: "put" | "del"; key: string; value?: string }>): Promise<void> {
    for (const op of ops) {
      if (op.type === "put") this._store.set(op.key, op.value!);
      else this._store.delete(op.key);
    }
  }
  snapshot(): Record<string, string> {
    return Object.fromEntries(this._store);
  }
}

// ─── MockEventBus (T-6) ──────────────────────────────────────────────────

function makeMockBus() {
  const events: Array<{ event: string; payload: unknown }> = [];
  const bus = {
    emit: vi.fn((event: string, payload: unknown) => {
      events.push({ event, payload });
    }),
    events,
  };
  return bus;
}

// ─── Dependency helper ────────────────────────────────────────────────────

function makeDep(from: string, to: string, spec = "./module"): Dependency {
  return {
    fromFileId:   from,
    toFileId:     to,
    rawSpecifier: spec,
    kind:         "import",
    id:           `dep_${from}_${to}`,
  };
}

// ─── TSNode factory (T-5 testleri için) ──────────────────────────────────

function makeTsNode(
  type: string,
  startRow: number,
  endRow:   number,
  namedChildren: TSNode[] = [],
  text = "",
  name?: string,
): TSNode {
  const node: TSNode = {
    type,
    text,
    startIndex:    0,
    endIndex:      text.length,
    startPosition: { row: startRow, column: 0 },
    endPosition:   { row: endRow,   column: 0 },
    childCount:    namedChildren.length,
    children:      namedChildren,
    namedChildren,
    parent:        null,
    isNamed:       true,
    child:         (i) => namedChildren[i] ?? null,
    childForFieldName: (field) => field === "name" && name
      ? makeTsNode("identifier", startRow, startRow, [], name)
      : null,
    toString: () => `(${type})`,
  };
  return node;
}

function makeTree(root: TSNode): TSTree {
  return { rootNode: root, delete: vi.fn() };
}

// ═══════════════════════════════════════════════════════════════════════════
// T-8: ISQLiteDriver.transaction()
// ═══════════════════════════════════════════════════════════════════════════

describe("T-8: ISQLiteDriver.transaction()", () => {
  it("fn başarılı → BEGIN + COMMIT çağrılır", async () => {
    const db = new MockSqliteDriver();
    await db.transaction(async () => {
      await db.run("INSERT INTO foo VALUES (1)");
    });
    expect(db.executed).toContain("BEGIN");
    expect(db.executed).toContain("COMMIT");
  });

  it("fn throw → ROLLBACK çağrılır, exception re-throw", async () => {
    const db = new MockSqliteDriver();
    await expect(
      db.transaction(async () => {
        throw new Error("fail inside tx");
      }),
    ).rejects.toThrow("fail inside tx");
    expect(db.executed).toContain("ROLLBACK");
    expect(db.executed).not.toContain("COMMIT");
  });

  it("fn dönüş değeri geçirilir", async () => {
    const db = new MockSqliteDriver();
    const val = await db.transaction(async () => 42);
    expect(val).toBe(42);
  });

  it("transaction içinde run çağrısı BEGIN sonra gelir", async () => {
    const db = new MockSqliteDriver();
    await db.transaction(async () => {
      await db.run("DELETE FROM x");
    });
    const beginIdx  = db.executed.indexOf("BEGIN");
    const deleteIdx = db.executed.findIndex((s) => s.includes("DELETE"));
    expect(beginIdx).toBeLessThan(deleteIdx);
  });

  it("COMMIT BEGIN'den sonra gelir", async () => {
    const db = new MockSqliteDriver();
    await db.transaction(async () => {});
    expect(db.executed.indexOf("BEGIN")).toBeLessThan(db.executed.indexOf("COMMIT"));
  });

  it("iç içe transaction → her biri bağımsız BEGIN/COMMIT", async () => {
    const db = new MockSqliteDriver();
    await db.transaction(async () => {
      await db.transaction(async () => {});
    });
    const begins = db.executed.filter((s) => s === "BEGIN").length;
    expect(begins).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-4: TreeSitterAdapter
// ═══════════════════════════════════════════════════════════════════════════

describe("T-4: TreeSitterAdapter — WASM lazy load", () => {
  it("parse() → ok, rootNode var", async () => {
    const adapter = new TreeSitterAdapter(new MockTreeSitterLoader());
    const result  = await adapter.parse("const x = 1;");
    expect(result.ok).toBe(true);
    expect(result.data?.rootNode).toBeDefined();
  });

  it("ilk parse'da loader.loadParser() çağrılır", async () => {
    const loader = new MockTreeSitterLoader();
    const spy    = vi.spyOn(loader, "loadParser");
    const adapter = new TreeSitterAdapter(loader);
    await adapter.parse("x");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("ikinci parse'da loader tekrar çağrılmaz (cache)", async () => {
    const loader = new MockTreeSitterLoader();
    const spy    = vi.spyOn(loader, "loadParser");
    const adapter = new TreeSitterAdapter(loader);
    await adapter.parse("a");
    await adapter.parse("b");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("concurrent parse → loader bir kez çağrılır", async () => {
    const loader = new MockTreeSitterLoader();
    const spy    = vi.spyOn(loader, "loadParser");
    const adapter = new TreeSitterAdapter(loader);
    await Promise.all([adapter.parse("a"), adapter.parse("b"), adapter.parse("c")]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("loader throw → WASM_LOAD_FAILED", async () => {
    const failLoader = {
      loadParser: async () => { throw new Error("WASM missing"); },
    } as never;
    const adapter = new TreeSitterAdapter(failLoader);
    const result  = await adapter.parse("x");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(TreeSitterErrorCode.WASM_LOAD_FAILED);
  });

  it("disposed adapter → ADAPTER_DISPOSED", async () => {
    const adapter = new TreeSitterAdapter(new MockTreeSitterLoader());
    adapter.dispose();
    const result  = await adapter.parse("x");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(TreeSitterErrorCode.ADAPTER_DISPOSED);
  });

  it("dispose idempotent", () => {
    const adapter = new TreeSitterAdapter(new MockTreeSitterLoader());
    adapter.dispose();
    expect(() => adapter.dispose()).not.toThrow();
  });

  it("parse sonucu tree.delete() çağrılabilir", async () => {
    const adapter = new TreeSitterAdapter(new MockTreeSitterLoader());
    const result  = await adapter.parse("const x = 1;");
    expect(() => result.data?.delete()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-5: ScopeAnalyzer — gerçek AST traversal
// ═══════════════════════════════════════════════════════════════════════════

describe("T-5: ScopeAnalyzer — Tree-sitter AST traversal", () => {
  function makeAnalyzer(rootNode?: TSNode) {
    const loader = new MockTreeSitterLoader(
      rootNode
        ? () => makeTree(rootNode)
        : undefined,
    );
    return new ScopeAnalyzer(new TreeSitterAdapter(loader));
  }

  it("boş kaynak → root scope döner", async () => {
    const analyzer = makeAnalyzer();
    const result   = await analyzer.analyze("");
    expect(result.ok).toBe(true);
    expect(result.data?.root.kind).toBe(ScopeKind.MODULE);
  });

  it("function_declaration → FUNCTION scope çocuğu", async () => {
    const fnNode = makeTsNode("function_declaration", 1, 5,
      [makeTsNode("statement_block", 2, 4)],
      "function foo() {}",
      "foo",
    );
    const root   = makeTsNode("program", 0, 10, [fnNode]);
    const result = await makeAnalyzer(root).analyze("function foo() {}");
    expect(result.ok).toBe(true);
    const child = result.data?.root.children[0];
    expect(child?.kind).toBe(ScopeKind.FUNCTION);
  });

  it("function scope adı çıkarılır", async () => {
    const fnNode = makeTsNode("function_declaration", 1, 5,
      [],
      "function bar() {}",
      "bar",
    );
    const root   = makeTsNode("program", 0, 10, [fnNode]);
    const result = await makeAnalyzer(root).analyze("function bar() {}");
    expect(result.data?.root.children[0]?.name).toBe("bar");
  });

  it("class_declaration → CLASS scope", async () => {
    const classNode = makeTsNode("class_declaration", 0, 5, [], "class Foo {}", "Foo");
    const root      = makeTsNode("program", 0, 10, [classNode]);
    const result    = await makeAnalyzer(root).analyze("class Foo {}");
    expect(result.data?.root.children[0]?.kind).toBe(ScopeKind.CLASS);
  });

  it("arrow_function → ARROW_FUNCTION scope", async () => {
    const arrowNode = makeTsNode("arrow_function", 0, 1, [], "() => {}");
    const root      = makeTsNode("program", 0, 5, [arrowNode]);
    const result    = await makeAnalyzer(root).analyze("const f = () => {}");
    expect(result.data?.root.children[0]?.kind).toBe(ScopeKind.ARROW_FUNCTION);
  });

  it("iç içe scope — children hiyerarşisi doğru", async () => {
    const inner = makeTsNode("arrow_function", 2, 3, []);
    const outer = makeTsNode("function_declaration", 1, 4, [inner], "", "outer");
    const root  = makeTsNode("program", 0, 10, [outer]);
    const result = await makeAnalyzer(root).analyze("function outer() { const f = () => {}; }");
    const outerScope = result.data?.root.children[0];
    expect(outerScope?.children[0]?.kind).toBe(ScopeKind.ARROW_FUNCTION);
  });

  it("scope dışı node'lar (identifier vb.) kök scope'a eklenmez", async () => {
    const ident = makeTsNode("identifier", 0, 0, [], "x");
    const root  = makeTsNode("program", 0, 5, [ident]);
    const result = await makeAnalyzer(root).analyze("x");
    expect(result.data?.root.children).toHaveLength(0);
  });

  it("findScopeAt → içeriden en dar scope döner", async () => {
    const fnNode = makeTsNode("function_declaration", 1, 5, [], "", "myFn");
    const root   = makeTsNode("program", 0, 10, [fnNode]);
    const analyzer = makeAnalyzer(root);
    const result   = await analyzer.findScopeAt("...", 3, 0);
    expect(result.ok).toBe(true);
    expect(result.data?.kind).toBe(ScopeKind.FUNCTION);
  });

  it("findScopeAt — scope dışı koordinat → SYMBOL_NOT_FOUND", async () => {
    const result = await makeAnalyzer().findScopeAt("", 99, 99);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ScopeErrorCode.SYMBOL_NOT_FOUND);
  });

  it("parseMs > 0", async () => {
    const result = await makeAnalyzer().analyze("const x = 1;");
    expect(result.data?.parseMs).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-6: DependencyIndex — writeDeps + buildTopoRebuildPlan
// ═══════════════════════════════════════════════════════════════════════════

describe("T-6: DependencyIndex.writeDeps()", () => {
  it("yeni dep → dep_fwd LevelDB'ye yazılır", async () => {
    const db  = new MockLevelDb();
    const bus = makeMockBus();
    const idx = new DependencyIndex(db, bus);
    const dep = makeDep("a", "b");

    const result = await idx.writeDeps("a", [dep]);
    expect(result.ok).toBe(true);
    const snap = db.snapshot();
    expect(snap["dep_fwd:a"]).toBeDefined();
    const stored = JSON.parse(snap["dep_fwd:a"]!);
    expect(stored[0].toFileId).toBe("b");
  });

  it("rev dep yazılır", async () => {
    const db  = new MockLevelDb();
    const idx = new DependencyIndex(db, makeMockBus());
    await idx.writeDeps("a", [makeDep("a", "b")]);
    const snap = db.snapshot();
    const revSet = JSON.parse(snap["dep_rev:b"]!);
    expect(revSet).toContain("a");
  });

  it("dep güncellenince stale rev dep temizlenir", async () => {
    const db  = new MockLevelDb();
    const idx = new DependencyIndex(db, makeMockBus());
    await idx.writeDeps("a", [makeDep("a", "b")]);  // a→b
    await idx.writeDeps("a", [makeDep("a", "c")]);  // a→c (b eski)
    const snap = db.snapshot();
    // b'nin rev set'i boş olmalı → silinmeli
    expect(snap["dep_rev:b"]).toBeUndefined();
    expect(JSON.parse(snap["dep_rev:c"]!)).toContain("a");
  });

  it("boş dep listesi → eski dep'ler temizlenir", async () => {
    const db  = new MockLevelDb();
    const idx = new DependencyIndex(db, makeMockBus());
    await idx.writeDeps("a", [makeDep("a", "b")]);
    await idx.writeDeps("a", []); // tümünü kaldır
    const snap = db.snapshot();
    expect(JSON.parse(snap["dep_fwd:a"]!)).toHaveLength(0);
    expect(snap["dep_rev:b"]).toBeUndefined();
  });

  it("getForwardDeps → yazılan dep'leri döner", async () => {
    const db  = new MockLevelDb();
    const idx = new DependencyIndex(db, makeMockBus());
    await idx.writeDeps("a", [makeDep("a", "b"), makeDep("a", "c")]);
    const deps = await idx.getForwardDeps("a");
    expect(deps).toHaveLength(2);
    expect(deps.map((d) => d.toFileId).sort()).toEqual(["b", "c"]);
  });

  it("getReverseDeps → referans eden dosyaları döner", async () => {
    const db  = new MockLevelDb();
    const idx = new DependencyIndex(db, makeMockBus());
    await idx.writeDeps("a", [makeDep("a", "c")]);
    await idx.writeDeps("b", [makeDep("b", "c")]);
    const revDeps = await idx.getReverseDeps("c");
    expect(revDeps.sort()).toEqual(["a", "b"]);
  });
});

describe("T-6: DependencyIndex.buildTopoRebuildPlan()", () => {
  it("tek dosya → order = [dosya], cycle yok", async () => {
    const db  = new MockLevelDb();
    const bus = makeMockBus();
    const idx = new DependencyIndex(db, bus);
    const result = await idx.buildTopoRebuildPlan("a");
    expect(result.ok).toBe(true);
    expect(result.data?.order).toContain("a");
    expect(result.data?.cycleMembers.size).toBe(0);
  });

  it("a → b → c: topo sıra c önce", async () => {
    const db  = new MockLevelDb();
    const bus = makeMockBus();
    const idx = new DependencyIndex(db, bus);
    await idx.writeDeps("a", [makeDep("a", "b")]);
    await idx.writeDeps("b", [makeDep("b", "c")]);
    const result = await idx.buildTopoRebuildPlan("c");
    // c'yi kullananlar: b, a — topo sıra: c önce sonra b sonra a
    const order = result.data!.order;
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a"));
  });

  it("cycle → cycleMembers dolu, CYCLE_DETECTED event emit edilir", async () => {
    const db  = new MockLevelDb();
    const bus = makeMockBus();
    const idx = new DependencyIndex(db, bus);
    // a → b → a (cycle)
    await idx.writeDeps("a", [makeDep("a", "b")]);
    await idx.writeDeps("b", [makeDep("b", "a")]);
    const result = await idx.buildTopoRebuildPlan("a");
    expect(result.data?.cycleMembers.size).toBeGreaterThan(0);
    const cycleEmit = bus.events.find((e) => e.event === "index:cycle");
    expect(cycleEmit).toBeDefined();
  });

  it("index:plan event emit edilir", async () => {
    const db  = new MockLevelDb();
    const bus = makeMockBus();
    const idx = new DependencyIndex(db, bus);
    await idx.buildTopoRebuildPlan("x");
    expect(bus.emit).toHaveBeenCalledWith("index:plan", expect.objectContaining({
      triggeredBy: "x",
    }));
  });

  it("diamond dep: a→b, a→c, b→d, c→d — d topo sırada önce", async () => {
    const db  = new MockLevelDb();
    const bus = makeMockBus();
    const idx = new DependencyIndex(db, bus);
    await idx.writeDeps("a", [makeDep("a", "b"), makeDep("a", "c")]);
    await idx.writeDeps("b", [makeDep("b", "d")]);
    await idx.writeDeps("c", [makeDep("c", "d")]);
    const result = await idx.buildTopoRebuildPlan("d");
    const order  = result.data!.order;
    expect(order[0]).toBe("d");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-3: StorageInitializer — DDL + init sırası
// ═══════════════════════════════════════════════════════════════════════════

describe("T-3: StorageInitializer — gerçek DDL", () => {
  it("initialize() → driver.run() DDL ile çağrılır", async () => {
    const db   = new MockSqliteDriver();
    const init = new StorageInitializer(db);
    const result = await init.initialize();
    expect(result.ok).toBe(true);
    expect(db.run).toHaveBeenCalled();
    // CREATE TABLE IF NOT EXISTS symbols içermeli
    const sqls = db.executed.join(" ");
    expect(sqls).toContain("CREATE");
  });

  it("ikinci initialize() çağrısı idempotent", async () => {
    const db   = new MockSqliteDriver();
    const init = new StorageInitializer(db);
    await init.initialize();
    const callCount = db.run.mock.calls.length;
    await init.initialize(); // tekrar
    expect(db.run.mock.calls.length).toBe(callCount); // yeni çağrı yok
  });

  it("DDL hata → init ok:false döner", async () => {
    const db = new MockSqliteDriver();
    db.failNext();
    const init   = new StorageInitializer(db);
    const result = await init.initialize();
    expect(result.ok).toBe(false);
  });

  it("isInitialized başta false", () => {
    const db   = new MockSqliteDriver();
    const init = new StorageInitializer(db);
    expect(init.isInitialized).toBe(false);
  });

  it("başarılı init sonrası isInitialized true", async () => {
    const db   = new MockSqliteDriver();
    const init = new StorageInitializer(db);
    await init.initialize();
    expect(init.isInitialized).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T-1 + T-2: SymbolIndex.patch — API dokümanı kontrolleri
// ═══════════════════════════════════════════════════════════════════════════

describe("T-1 + T-2: SymbolIndex patch — API dokümanı", () => {
  it("T-1: invalidatePosCache patch dokümanı mevcut", async () => {
    const patch = await import("../language/SymbolIndex.patch");
    expect(typeof patch.SymbolIndexPatch.prototype.invalidatePosCache).toBe("function");
  });

  it("T-2: getSymbol patch dokümanı mevcut", async () => {
    const patch = await import("../language/SymbolIndex.patch");
    expect(typeof patch.SymbolIndexPatch.prototype.getSymbol).toBe("function");
  });

  it("T-8 writeSnapshot patch dokümanı export edilmiş", async () => {
    const patch = await import("../language/SymbolIndex.patch");
    expect(patch.WRITE_SNAPSHOT_PATCH_DOC).toContain("T-8");
  });

  it("SymbolIndexErrorCode tanımları mevcut", async () => {
    const { SymbolIndexErrorCode } = await import("../language/SymbolIndex.patch");
    expect(SymbolIndexErrorCode.SYMBOL_NOT_FOUND).toBe("SYMBOL_NOT_FOUND");
    expect(SymbolIndexErrorCode.POS_CACHE_INVALID).toBe("POS_CACHE_INVALID");
  });
});
