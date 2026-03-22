// ─────────────────────────────────────────────────────────────
// language-services/__tests__/SymbolGraph.test.ts
// SymbolGraph + DependencyIndex + ReferenceIndex birim testleri
// Phase 3 | v1.1.0
//
// Değişiklikler v1.0.0 → v1.1.0:
//   #1  makeSymbol — checksum Checksum32 cast
//   #2  makeRef — id alanı eklendi
//   #3  makeDep — id ve isTruncated alanları eklendi
//   #4  makeSnapshot — checksum Checksum32 cast
//   #5  SYM_BAR dead constant kaldırıldı
//   #6  emitted dead array kaldırıldı
//   #7  findDefinition testi — storage.writeSnapshot eklendi
//   #8  findAllReferences — storage.writeSnapshot await edildi
//  #10  maxDepth testi — FILE_C kontrolü eklendi
//  #11  mockStorage.invalidateFile — revDepStore temizleniyor
//  #12  onFileRenamed testi eklendi
// ─────────────────────────────────────────────────────────────

import { SymbolGraph } from "../graph/SymbolGraph";
import { DependencyIndex, type IPathResolver } from "../graph/DependencyIndex";
import { ReferenceIndex } from "../graph/ReferenceIndex";
import type { FileSnapshot, SymbolNode, DependencyEdge, ReferenceLocation } from "../graph/types";
import { SymbolKind, SymbolScope, EdgeKind } from "../graph/types";
import type { Checksum32 } from "../graph/types";
import type { UUID } from "../../core";
import { createEventBus } from "../../core";

// ── Mock helpers ──────────────────────────────────────────────

function mockUUID(seed: string): UUID {
  return `00000000-0000-0000-0000-${seed.padStart(12, "0")}` as UUID;
}

// ID sabitleri
const FILE_A = mockUUID("aaa");
const FILE_B = mockUUID("bbb");
const FILE_C = mockUUID("ccc");
const FILE_D = mockUUID("ddd");
const SYM_FOO = mockUUID("f00");
// SYM_BAR kaldırıldı — kullanılmıyordu #5

// ── Mock storage ──────────────────────────────────────────────
// invalidateFile artık revDepStore'u da temizliyor. #11

function makeMockStorage() {
  const symbolStore  = new Map<string, SymbolNode[]>();
  const depStore     = new Map<string, DependencyEdge[]>();
  const revDepStore  = new Map<string, UUID[]>();
  const refStore     = new Map<string, ReferenceLocation[]>();

  return {
    async init() { return { ok: true, data: undefined } as any; },
    async dispose() {},

    async writeSnapshot(snap: FileSnapshot) {
      symbolStore.set(snap.fileId, [...snap.symbols]);
      depStore.set(snap.fileId, [...snap.deps]);

      for (const dep of snap.deps) {
        if (!dep.isResolved) continue;
        const existing = revDepStore.get(dep.toFileId) ?? [];
        if (!existing.includes(snap.fileId)) existing.push(snap.fileId);
        revDepStore.set(dep.toFileId, existing);
      }

      for (const ref of snap.refs) {
        const existing = refStore.get(ref.symbolId) ?? [];
        existing.push(ref);
        refStore.set(ref.symbolId, existing);
      }

      return { ok: true, data: undefined } as any;
    },

    async invalidateFile(fileId: UUID) {
      // Giden dep'lerin reverse index'inden bu fileId'yi temizle #11
      const deps = depStore.get(fileId) ?? [];
      for (const dep of deps) {
        if (!dep.isResolved) continue;
        const rev = revDepStore.get(dep.toFileId);
        if (rev) {
          const idx = rev.indexOf(fileId);
          if (idx !== -1) rev.splice(idx, 1);
        }
      }
      symbolStore.delete(fileId);
      depStore.delete(fileId);
      return { ok: true, data: undefined } as any;
    },

    async getSymbolsByFile(fileId: UUID) {
      return { ok: true, data: symbolStore.get(fileId) ?? [] } as any;
    },
    async getDependencies(fileId: UUID) {
      return { ok: true, data: depStore.get(fileId) ?? [] } as any;
    },
    async getReverseDependencies(fileId: UUID) {
      return { ok: true, data: revDepStore.get(fileId) ?? [] } as any;
    },
    async getReferences(symbolId: UUID) {
      return { ok: true, data: refStore.get(symbolId) ?? [] } as any;
    },
    async findDefinitions(symbolId: UUID) {
      const allRefs = refStore.get(symbolId) ?? [];
      return { ok: true, data: allRefs.filter((r: ReferenceLocation) => r.isDecl) } as any;
    },
    async findSymbolsByName(name: string) {
      const all: SymbolNode[] = [];
      for (const syms of symbolStore.values()) all.push(...syms);
      return { ok: true, data: all.filter((s: SymbolNode) => s.name.includes(name)) } as any;
    },
    async getStats() {
      return { ok: true, data: { symbolCount: 0, fileCount: 0, edgeCount: 0, referenceCount: 0, lastUpdated: 0 } } as any;
    },
  } as any;
}

// ── Builder helpers ───────────────────────────────────────────

function makeSymbol(overrides: Partial<SymbolNode> & { id: UUID; fileId: UUID; name: string }): SymbolNode {
  return {
    kind:       SymbolKind.Function,
    scope:      SymbolScope.Module,
    line:       0,
    col:        0,
    endLine:    5,
    endCol:     1,
    parentId:   null,
    exportedAs: null,
    checksum:   12345 as Checksum32,  // Checksum32 branded cast #1
    version:    1,
    ...overrides,
  };
}

let _refSeq = 0;
function makeRef(symbolId: UUID, fileId: UUID, line: number, isDecl = false): ReferenceLocation {
  // id alanı eklendi — ReferenceLocation.id types.ts #4 #2
  const id = mockUUID(`ref${String(++_refSeq).padStart(8, "0")}`);
  return { id, symbolId, fileId, line, col: 0, endCol: 5, isWrite: false, isDecl };
}

let _depSeq = 0;
function makeDep(fromFileId: UUID, toFileId: UUID, specifier = "./foo"): DependencyEdge {
  // id ve isTruncated eklendi — DependencyEdge #3 fix #3
  const id = mockUUID(`dep${String(++_depSeq).padStart(8, "0")}`);
  return {
    id,
    fromFileId,
    toFileId,
    kind:          EdgeKind.ImportStatic,
    importedNames: ["foo"],
    isTruncated:   false,
    rawSpecifier:  specifier,
    line:          0,
    isResolved:    true,
  };
}

function makeSnapshot(
  fileId: UUID,
  symbols: SymbolNode[],
  deps: DependencyEdge[],
  refs: ReferenceLocation[] = []
): FileSnapshot {
  return {
    fileId,
    version:  1,
    checksum: 1 as Checksum32,  // Checksum32 branded cast #4
    symbols,
    deps,
    refs,
    parsedAt: Date.now(),
  };
}

// _refSeq ve _depSeq her test öncesi sıfırlanmalı
beforeEach(() => {
  _refSeq = 0;
  _depSeq = 0;
});

// ── SymbolGraph testleri ──────────────────────────────────────

describe("SymbolGraph", () => {
  let storage:  ReturnType<typeof makeMockStorage>;
  let eventBus: ReturnType<typeof createEventBus>;
  let graph:    SymbolGraph;

  // emitted kaldırıldı — her test kendi local array'ini kullanıyor #6

  beforeEach(() => {
    storage  = makeMockStorage();
    eventBus = createEventBus();
    graph    = new SymbolGraph(storage as any, eventBus as any);
  });

  // ── Snapshot ────────────────────────────────────────────────

  test("applySnapshot — sembolleri in-memory'e yükler", async () => {
    const sym = makeSymbol({ id: SYM_FOO, fileId: FILE_A, name: "foo" });
    await graph.applySnapshot(makeSnapshot(FILE_A, [sym], []));

    expect(graph.getSymbol(SYM_FOO)).toEqual(sym);
    expect(graph.getFileSymbols(FILE_A)).toHaveLength(1);
    expect(graph.symbolCount).toBe(1);
  });

  test("applySnapshot — edge'leri doğru kurar", async () => {
    await graph.applySnapshot(makeSnapshot(FILE_A, [], [makeDep(FILE_A, FILE_B)]));

    expect(graph.getDirectDeps(FILE_A)).toContain(FILE_B);
    expect(graph.getDirectDependants(FILE_B)).toContain(FILE_A);
  });

  test("applySnapshot — ikinci kez çağrılınca eski edge'ler temizlenir", async () => {
    await graph.applySnapshot(makeSnapshot(FILE_A, [], [makeDep(FILE_A, FILE_B)]));
    await graph.applySnapshot(makeSnapshot(FILE_A, [], [makeDep(FILE_A, FILE_C)]));

    expect(graph.getDirectDeps(FILE_A)).not.toContain(FILE_B);
    expect(graph.getDirectDeps(FILE_A)).toContain(FILE_C);
    expect(graph.getDirectDependants(FILE_B)).not.toContain(FILE_A);
  });

  // ── Cycle detection ─────────────────────────────────────────

  test("cycle detection — A→B→A algılanır, graph:cycle:detected emit edilir", async () => {
    const cycles: unknown[] = [];
    eventBus.on("graph:cycle:detected", (p) => cycles.push(p));

    await graph.applySnapshot(makeSnapshot(FILE_A, [], [makeDep(FILE_A, FILE_B)]));
    await graph.applySnapshot(makeSnapshot(FILE_B, [], [makeDep(FILE_B, FILE_A)]));

    expect(cycles.length).toBeGreaterThan(0);
  });

  test("cycle detection — A→B→C, döngü yok, emit yok", async () => {
    const cycles: unknown[] = [];
    eventBus.on("graph:cycle:detected", (p) => cycles.push(p));

    await graph.applySnapshot(makeSnapshot(FILE_A, [], [makeDep(FILE_A, FILE_B)]));
    await graph.applySnapshot(makeSnapshot(FILE_B, [], [makeDep(FILE_B, FILE_C)]));

    expect(cycles).toHaveLength(0);
  });

  // ── Transitif bağımlılıklar ──────────────────────────────────

  test("getTransitiveDeps — A→B→C, A'nın transitif dep'leri B ve C", async () => {
    await graph.applySnapshot(makeSnapshot(FILE_A, [], [makeDep(FILE_A, FILE_B)]));
    await graph.applySnapshot(makeSnapshot(FILE_B, [], [makeDep(FILE_B, FILE_C)]));

    const deps = graph.getTransitiveDeps(FILE_A);
    expect(deps).toContain(FILE_B);
    expect(deps).toContain(FILE_C);
    expect(deps).not.toContain(FILE_A);
  });

  test("getTransitiveDeps — maxDepth=1 iken B dahil, C ve D hariç", async () => {
    // A→B→C→D zinciri, maxDepth=1 → sadece B görünür
    await graph.applySnapshot(makeSnapshot(FILE_A, [], [makeDep(FILE_A, FILE_B)]));
    await graph.applySnapshot(makeSnapshot(FILE_B, [], [makeDep(FILE_B, FILE_C)]));
    await graph.applySnapshot(makeSnapshot(FILE_C, [], [makeDep(FILE_C, FILE_D)]));

    const deps = graph.getTransitiveDeps(FILE_A, 1);
    expect(deps).toContain(FILE_B);
    expect(deps).not.toContain(FILE_C);   // #10 fix: C kontrolü eklendi
    expect(deps).not.toContain(FILE_D);
  });

  // ── Impact analysis ──────────────────────────────────────────

  test("getImpactedFiles — C değişince B ve A etkilenir (reverse chain)", async () => {
    await graph.applySnapshot(makeSnapshot(FILE_A, [], [makeDep(FILE_A, FILE_B)]));
    await graph.applySnapshot(makeSnapshot(FILE_B, [], [makeDep(FILE_B, FILE_C)]));

    const impacted = graph.getImpactedFiles(FILE_C);
    expect(impacted).toContain(FILE_B);
    expect(impacted).toContain(FILE_A);
  });

  test("getImpactedFiles — bağımsız dosya etkilenmez", async () => {
    await graph.applySnapshot(makeSnapshot(FILE_A, [], [makeDep(FILE_A, FILE_B)]));
    // FILE_D hiçbir şeyle bağlantılı değil
    await graph.applySnapshot(makeSnapshot(FILE_D, [], []));

    const impacted = graph.getImpactedFiles(FILE_B);
    expect(impacted).not.toContain(FILE_D);
  });

  // ── Invalidation ─────────────────────────────────────────────

  test("invalidateFile — semboller ve edge'ler temizlenir", async () => {
    const sym = makeSymbol({ id: SYM_FOO, fileId: FILE_A, name: "foo" });
    await graph.applySnapshot(makeSnapshot(FILE_A, [sym], [makeDep(FILE_A, FILE_B)]));
    await graph.invalidateFile(FILE_A, "edit");

    expect(graph.getSymbol(SYM_FOO)).toBeNull();
    expect(graph.getFileSymbols(FILE_A)).toHaveLength(0);
    expect(graph.getDirectDeps(FILE_A)).toHaveLength(0);
    expect(graph.getDirectDependants(FILE_B)).not.toContain(FILE_A);
  });

  test("invalidateFile — index:invalidated event emit edilir", async () => {
    const events: unknown[] = [];
    eventBus.on("index:invalidated", (p) => events.push(p));

    const sym = makeSymbol({ id: SYM_FOO, fileId: FILE_A, name: "foo" });
    await graph.applySnapshot(makeSnapshot(FILE_A, [sym], []));
    await graph.invalidateFile(FILE_A, "delete");

    expect(events).toHaveLength(1);
    expect((events[0] as any).fileId).toBe(FILE_A);
    expect((events[0] as any).reason).toBe("delete");
  });

  test("invalidateFile — sonraki snapshot aynı sembolü temiz yükler", async () => {
    // invalidate → yeniden applySnapshot → eski stale veri olmamalı
    const sym = makeSymbol({ id: SYM_FOO, fileId: FILE_A, name: "foo" });
    await graph.applySnapshot(makeSnapshot(FILE_A, [sym], []));
    await graph.invalidateFile(FILE_A, "edit");

    const sym2 = makeSymbol({ id: SYM_FOO, fileId: FILE_A, name: "foo_renamed" });
    await graph.applySnapshot(makeSnapshot(FILE_A, [sym2], []));

    expect(graph.getSymbol(SYM_FOO)?.name).toBe("foo_renamed");
    expect(graph.symbolCount).toBe(1);
  });

  // ── onFileRenamed ────────────────────────────────────────────
  // #12 fix: yeni test

  test("onFileRenamed — eski fileId temizlenir, yeni id sonraki snapshot ile eklenir", async () => {
    const FILE_A2 = mockUUID("aa2");
    const sym = makeSymbol({ id: SYM_FOO, fileId: FILE_A, name: "foo" });
    await graph.applySnapshot(makeSnapshot(FILE_A, [sym], [makeDep(FILE_A, FILE_B)]));

    // rename: FILE_A artık FILE_A2 oldu
    await graph.invalidateFile(FILE_A, "rename");

    // Eski id temizlendi
    expect(graph.getSymbol(SYM_FOO)).toBeNull();
    expect(graph.getDirectDeps(FILE_A)).toHaveLength(0);

    // Yeni id ile yeniden index — sistem bunu kabul etmeli
    const sym2 = makeSymbol({ id: SYM_FOO, fileId: FILE_A2, name: "foo" });
    await graph.applySnapshot(makeSnapshot(FILE_A2, [sym2], [makeDep(FILE_A2, FILE_B)]));

    expect(graph.getSymbol(SYM_FOO)?.fileId).toBe(FILE_A2);
    expect(graph.getDirectDeps(FILE_A2)).toContain(FILE_B);
  });
});

// ── ReferenceIndex testleri ───────────────────────────────────

describe("ReferenceIndex", () => {
  let storage:  ReturnType<typeof makeMockStorage>;
  let graph:    SymbolGraph;
  let refs:     ReferenceIndex;
  let eventBus: ReturnType<typeof createEventBus>;

  beforeEach(() => {
    storage  = makeMockStorage();
    eventBus = createEventBus();
    graph    = new SymbolGraph(storage as any, eventBus as any);
    refs     = new ReferenceIndex(storage as any, graph);
  });

  test("getSymbolAtCursor — doğru sembolü bulur", async () => {
    const sym = makeSymbol({ id: SYM_FOO, fileId: FILE_A, name: "foo", line: 3, col: 4, endCol: 10 });
    await graph.applySnapshot(makeSnapshot(FILE_A, [sym], []));
    refs.buildPosCache(FILE_A);

    const found = refs.getSymbolAtCursor({ fileId: FILE_A, line: 3, col: 7 });
    expect(found?.id).toBe(SYM_FOO);
  });

  test("getSymbolAtCursor — sınır değerleri: col=4 ve col=10 da eşleşir", async () => {
    const sym = makeSymbol({ id: SYM_FOO, fileId: FILE_A, name: "foo", line: 3, col: 4, endCol: 10 });
    await graph.applySnapshot(makeSnapshot(FILE_A, [sym], []));
    refs.buildPosCache(FILE_A);

    expect(refs.getSymbolAtCursor({ fileId: FILE_A, line: 3, col: 4  })?.id).toBe(SYM_FOO);
    expect(refs.getSymbolAtCursor({ fileId: FILE_A, line: 3, col: 10 })?.id).toBe(SYM_FOO);
  });

  test("getSymbolAtCursor — cursor dışında null döner", async () => {
    const sym = makeSymbol({ id: SYM_FOO, fileId: FILE_A, name: "foo", line: 3, col: 4, endCol: 10 });
    await graph.applySnapshot(makeSnapshot(FILE_A, [sym], []));

    expect(refs.getSymbolAtCursor({ fileId: FILE_A, line: 5, col: 0 })).toBeNull();
    expect(refs.getSymbolAtCursor({ fileId: FILE_A, line: 3, col: 3 })).toBeNull();
    expect(refs.getSymbolAtCursor({ fileId: FILE_A, line: 3, col: 11 })).toBeNull();
  });

  test("findDefinition — declaration ref'i döndürür", async () => {
    const sym  = makeSymbol({ id: SYM_FOO, fileId: FILE_A, name: "foo", line: 0, col: 0, endCol: 3 });
    const decl = makeRef(SYM_FOO, FILE_A, 0, true);

    // storage.writeSnapshot çağrılmalı; sadece graph.applySnapshot yetmez.
    // findDefinitions storage.findDefinitions'dan okur. #7 fix
    await storage.writeSnapshot(makeSnapshot(FILE_A, [sym], [], [decl]));
    await graph.applySnapshot(makeSnapshot(FILE_A, [sym], []));
    refs.buildPosCache(FILE_A);

    const result = await refs.findDefinition({ fileId: FILE_A, line: 0, col: 1 });
    expect(result.ok).toBe(true);
    expect(result.ok && result.data?.symbol.id).toBe(SYM_FOO);
    expect(result.ok && result.data?.location.isDecl).toBe(true);
  });

  test("findAllReferences — declaration hariç tutulabilir", async () => {
    const sym  = makeSymbol({ id: SYM_FOO, fileId: FILE_A, name: "foo", line: 0, col: 0, endCol: 3 });
    const decl = makeRef(SYM_FOO, FILE_A, 0, true);
    const use1 = makeRef(SYM_FOO, FILE_A, 5, false);
    const use2 = makeRef(SYM_FOO, FILE_B, 2, false);

    // await eklendi — race condition önlendi #8 fix
    await storage.writeSnapshot(makeSnapshot(FILE_A, [sym], [], [decl, use1, use2]));
    await graph.applySnapshot(makeSnapshot(FILE_A, [sym], []));
    refs.buildPosCache(FILE_A);

    const result = await refs.findAllReferences(
      { fileId: FILE_A, line: 0, col: 1 },
      { includeDeclaration: false }
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.references.every(r => !r.isDecl)).toBe(true);
      expect(result.data.readCount).toBe(2);
      expect(result.data.writeCount).toBe(0);
    }
  });

  test("findAllReferences — includeDeclaration:true tüm ref'leri döndürür", async () => {
    const sym  = makeSymbol({ id: SYM_FOO, fileId: FILE_A, name: "foo", line: 0, col: 0, endCol: 3 });
    const decl = makeRef(SYM_FOO, FILE_A, 0, true);
    const use1 = makeRef(SYM_FOO, FILE_A, 5, false);

    await storage.writeSnapshot(makeSnapshot(FILE_A, [sym], [], [decl, use1]));
    await graph.applySnapshot(makeSnapshot(FILE_A, [sym], []));
    refs.buildPosCache(FILE_A);

    const result = await refs.findAllReferences(
      { fileId: FILE_A, line: 0, col: 1 },
      { includeDeclaration: true }
    );

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.references).toHaveLength(2);
    }
  });
});

// ── DependencyIndex testleri ──────────────────────────────────

describe("DependencyIndex", () => {
  let storage:  ReturnType<typeof makeMockStorage>;
  let graph:    SymbolGraph;
  let deps:     DependencyIndex;
  let eventBus: ReturnType<typeof createEventBus>;

  const pathMap: Record<string, string> = {
    [FILE_A]: "/project/a.ts",
    [FILE_B]: "/project/b.ts",
    [FILE_C]: "/project/c.ts",
    [FILE_D]: "/project/d.ts",
  };

  const mockResolver: IPathResolver = {
    async resolve(specifier) {
      if (specifier === "./b") return FILE_B;
      if (specifier === "./c") return FILE_C;
      if (specifier === "./d") return FILE_D;
      return null; // external veya bilinmeyen
    },
    getPath(fileId) { return pathMap[fileId] ?? null; },
  };

  beforeEach(() => {
    storage  = makeMockStorage();
    eventBus = createEventBus();
    graph    = new SymbolGraph(storage as any, eventBus as any);
    deps     = new DependencyIndex(storage as any, graph, mockResolver);
  });

  test("resolveImports — internal specifier çözümlenir", async () => {
    const result = await deps.resolveImports(FILE_A, [
      { specifier: "./b", names: ["foo"], kind: EdgeKind.ImportStatic, line: 0 },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0].toFileId).toBe(FILE_B);
      expect(result.data[0].isResolved).toBe(true);
    }
  });

  test("resolveImports — external (react) isResolved=false olur", async () => {
    const result = await deps.resolveImports(FILE_A, [
      { specifier: "react", names: ["useState"], kind: EdgeKind.ImportStatic, line: 0 },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0].isResolved).toBe(false);
    }
  });

  test("resolveImports — aynı specifier farklı kind ile iki ayrı edge üretir (mixed import)", async () => {
    const result = await deps.resolveImports(FILE_A, [
      { specifier: "./b", names: ["foo"],   kind: EdgeKind.ImportStatic, line: 1 },
      { specifier: "./b", names: ["IFoo"],  kind: EdgeKind.TypeOnly,     line: 2 },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(2);
      const kinds = result.data.map(e => e.kind);
      expect(kinds).toContain(EdgeKind.ImportStatic);
      expect(kinds).toContain(EdgeKind.TypeOnly);
    }
  });

  test("topoSort — A→B→C, sıralama C önce B sonra A en son", async () => {
    await graph.applySnapshot(makeSnapshot(FILE_A, [], [makeDep(FILE_A, FILE_B)]));
    await graph.applySnapshot(makeSnapshot(FILE_B, [], [makeDep(FILE_B, FILE_C)]));
    await graph.applySnapshot(makeSnapshot(FILE_C, [], []));

    const result = await deps.topoSort([FILE_A, FILE_B, FILE_C]);
    expect(result.ok).toBe(true);

    if (result.ok) {
      const { order, cycles } = result.data;
      expect(cycles).toHaveLength(0);

      const idxA = order.indexOf(FILE_A);
      const idxB = order.indexOf(FILE_B);
      const idxC = order.indexOf(FILE_C);

      expect(idxC).toBeLessThan(idxB);
      expect(idxB).toBeLessThan(idxA);
    }
  });

  test("topoSort — cycle'lı dosyalar ayrı raporlanır, sıralama crash etmez", async () => {
    await graph.applySnapshot(makeSnapshot(FILE_A, [], [makeDep(FILE_A, FILE_B)]));
    await graph.applySnapshot(makeSnapshot(FILE_B, [], [makeDep(FILE_B, FILE_A)]));

    const result = await deps.topoSort([FILE_A, FILE_B]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.cycles.length).toBeGreaterThan(0);
    }
  });

  test("topoSort — bağımsız dosyalar hepsi sıralamaya dahil olur", async () => {
    // FILE_C ve FILE_D birbirinden bağımsız, FILE_A hiçbiriyle bağlantısız
    await graph.applySnapshot(makeSnapshot(FILE_A, [], []));
    await graph.applySnapshot(makeSnapshot(FILE_C, [], []));
    await graph.applySnapshot(makeSnapshot(FILE_D, [], []));

    const result = await deps.topoSort([FILE_A, FILE_C, FILE_D]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.order).toHaveLength(3);
      expect(result.data.cycles).toHaveLength(0);
    }
  });
});
