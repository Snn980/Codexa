/**
 * @file     Bundler.test.ts
 * @module   runtime/bundler/__tests__
 * @version  1.0.0
 * @since    Phase 2 — Runtime Sandbox
 *
 * Test kapsamı:
 *   § 1  normalizePath()
 *   § 2  resolvePath()
 *   § 3  tryExtensions()
 *   § 4  detectLoader()
 *   § 5  bundle() — tek dosya (esbuild skip)
 *   § 6  bundle() — entry bulunamadı
 *   § 7  bundle() — boyut limiti aşımı
 *   § 8  bundle() — multi-file (mock esbuild)
 *   § 9  bundle() — esbuild hata döndürünce
 *   § 10 bundle() — AbortSignal
 *   § 11 initialize() — lazy, idempotent, paralel
 *   § 12 initialize() — başlatma hatası retry edilebilir
 *   § 13 initialize() — dispose sonrası
 *   § 14 dispose()
 */

import {
  Bundler,
  normalizePath,
  resolvePath,
  tryExtensions,
  detectLoader,
  type IEsbuildModule,
} from "../bundler/Bundler";
import { SECURITY_LIMITS } from "../sandbox/SecurityLimits";
import type { BundlePayload } from "../../ipc/Protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Test yardımcıları
// ─────────────────────────────────────────────────────────────────────────────

const EXEC_ID = "exec-test-0001" as BundlePayload["executionId"];

function makePayload(
  overrides: Partial<BundlePayload> & { files: Record<string, string> },
): BundlePayload {
  return {
    executionId: EXEC_ID,
    entryPath:   "index.js",
    ...overrides,
  };
}

/**
 * Başarılı esbuild mock'u.
 * `build()` çağrısında `output` döndürür.
 */
function makeEsbuildMock(output = "bundled_code()"): IEsbuildModule {
  return {
    initialize: jest.fn().mockResolvedValue(undefined),
    build:      jest.fn().mockResolvedValue({
      outputFiles: [{ text: output }],
      errors:      [],
      warnings:    [],
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// § 1. normalizePath()
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizePath()", () => {
  test("başındaki './' kaldırılır", () => {
    expect(normalizePath("./index.js")).toBe("index.js");
  });

  test("'.//' → 'index.js' — sadece baştaki temizlenir", () => {
    expect(normalizePath("./src/app.ts")).toBe("src/app.ts");
  });

  test("ters slash forward slash'e dönüştürülür", () => {
    expect(normalizePath("src\\utils\\helper.ts")).toBe("src/utils/helper.ts");
  });

  test("karışık: ters slash + './'", () => {
    expect(normalizePath(".\\src\\app.ts")).toBe("src/app.ts");
  });

  test("zaten normalize path değişmez", () => {
    expect(normalizePath("src/utils.ts")).toBe("src/utils.ts");
  });

  test("sadece dosya adı (klasör yok)", () => {
    expect(normalizePath("app.ts")).toBe("app.ts");
  });

  test("boş string boş string döner", () => {
    expect(normalizePath("")).toBe("");
  });

  test("'./' ile başlamayan göreli path dokunulmaz", () => {
    expect(normalizePath("../sibling/file.js")).toBe("../sibling/file.js");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 2. resolvePath()
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePath()", () => {
  test("aynı dizindeki göreli import", () => {
    expect(resolvePath("src/index.js", "./utils")).toBe("src/utils");
  });

  test("üst dizine çıkma", () => {
    expect(resolvePath("src/a/b.js", "../lib/c.js")).toBe("src/lib/c.js");
  });

  test("birden fazla üst dizine çıkma", () => {
    expect(resolvePath("a/b/c/d.js", "../../e.js")).toBe("a/e.js");
  });

  test("kök seviyesinde importer — göreli import", () => {
    expect(resolvePath("index.js", "./helper")).toBe("helper");
  });

  test("mutlak import — importer yoksayılır", () => {
    expect(resolvePath("src/index.js", "/lib/utils.js")).toBe("lib/utils.js");
  });

  test("mutlak import baştaki '/' kaldırılır", () => {
    // resolvePath baştaki / segmentini atlıyor (boş string filtre)
    expect(resolvePath("anything.js", "/top/level.ts")).toBe("top/level.ts");
  });

  test("'..' kökün üstüne çıkamaz", () => {
    // resolved stack boşsa pop atlanır
    expect(resolvePath("index.js", "../../outside")).toBe("outside");
  });

  test("uzantılı path uzantısıyla döner", () => {
    expect(resolvePath("src/index.js", "./utils.ts")).toBe("src/utils.ts");
  });

  test("iç içe dizin yapısı", () => {
    expect(resolvePath("a/b/c/entry.js", "./sub/module")).toBe("a/b/c/sub/module");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 3. tryExtensions()
// ─────────────────────────────────────────────────────────────────────────────

describe("tryExtensions()", () => {
  const files = {
    "src/utils.ts":        "export const x = 1",
    "src/index/index.js":  "module.exports = {}",
    "lib/helper.jsx":      "export default () => null",
  };

  test(".ts uzantısı bulunur", () => {
    expect(tryExtensions("src/utils", files)).toBe("src/utils.ts");
  });

  test(".js uzantısı aranır", () => {
    const f = { "src/app.js": "code" };
    expect(tryExtensions("src/app", f)).toBe("src/app.js");
  });

  test("/index.js fallback bulunur", () => {
    const f = { "components/Button/index.js": "code" };
    expect(tryExtensions("components/Button", f)).toBe("components/Button/index.js");
  });

  test(".jsx uzantısı bulunur", () => {
    expect(tryExtensions("lib/helper", files)).toBe("lib/helper.jsx");
  });

  test("dosya yoksa null döner", () => {
    expect(tryExtensions("nonexistent/path", files)).toBeNull();
  });

  test("path zaten uzantılı ve map'te var — eşleşme yok (uzantı ekleme mantığı)", () => {
    // tryExtensions sadece path + EXT dener; mevcut uzantılı path'e EXT eklerse çakışmaz
    expect(tryExtensions("src/utils.ts", files)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 4. detectLoader()
// ─────────────────────────────────────────────────────────────────────────────

describe("detectLoader()", () => {
  test.each([
    ["app.js",    "js"],
    ["app.mjs",   "js"],
    ["app.cjs",   "js"],
    ["app.ts",    "ts"],
    ["app.jsx",   "jsx"],
    ["app.tsx",   "tsx"],
    ["data.json", "json"],
    ["readme.md", "text"],
    ["style.css", "text"],
    ["noext",     "text"],
  ])("%s → %s", (path, expected) => {
    expect(detectLoader(path)).toBe(expected);
  });

  test("büyük harf uzantı → küçük harfe çevrilir", () => {
    expect(detectLoader("App.TS")).toBe("ts");
    expect(detectLoader("Data.JSON")).toBe("json");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 5. bundle() — tek dosya (esbuild skip)
// ─────────────────────────────────────────────────────────────────────────────

describe("Bundler.bundle() — tek dosya", () => {
  test("tek dosyada esbuild initialize edilmez", async () => {
    const esbuild = makeEsbuildMock();
    const bundler = new Bundler("test.wasm", esbuild);

    await bundler.bundle(makePayload({
      files: { "index.js": "console.log('hi')" },
    }));

    expect(esbuild.initialize).not.toHaveBeenCalled();
    expect(esbuild.build).not.toHaveBeenCalled();
  });

  test("dönen bundledCode giriş kodu ile aynı", async () => {
    const code    = "console.log('hello world')";
    const bundler = new Bundler("test.wasm", makeEsbuildMock());
    const result  = await bundler.bundle(makePayload({
      files: { "index.js": code },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.bundledCode).toBe(code);
    expect(result.data.sizeBytes).toBe(code.length);
    expect(result.data.executionId).toBe(EXEC_ID);
  });

  test("'./' prefix'li entryPath normalize edilir", async () => {
    const bundler = new Bundler("test.wasm", makeEsbuildMock());
    const result  = await bundler.bundle(makePayload({
      entryPath: "./index.js",
      files:     { "index.js": "code" },
    }));
    expect(result.ok).toBe(true);
  });

  test("Windows path normalize edilir", async () => {
    const bundler = new Bundler("test.wasm", makeEsbuildMock());
    const result  = await bundler.bundle(makePayload({
      entryPath: ".\\index.js",
      files:     { ".\\index.js": "win_code" },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.bundledCode).toBe("win_code");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 6. bundle() — entry bulunamadı
// ─────────────────────────────────────────────────────────────────────────────

describe("Bundler.bundle() — entry bulunamadı", () => {
  test("entryPath files map'inde yoksa VALIDATION_ERROR döner", async () => {
    const bundler = new Bundler("test.wasm", makeEsbuildMock());
    const result  = await bundler.bundle(makePayload({
      entryPath: "missing.js",
      files:     { "other.js": "code" },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.message).toContain("missing.js");
  });

  test("files map boşsa VALIDATION_ERROR döner", async () => {
    const bundler = new Bundler("test.wasm", makeEsbuildMock());
    const result  = await bundler.bundle(makePayload({
      entryPath: "index.js",
      files:     {},
    }));
    expect(result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 7. bundle() — boyut limiti
// ─────────────────────────────────────────────────────────────────────────────

describe("Bundler.bundle() — boyut limiti", () => {
  test("BUNDLE_MAX_SIZE_BYTES aşılınca hata döner", async () => {
    const oversized = "x".repeat(SECURITY_LIMITS.BUNDLE_MAX_SIZE_BYTES + 1);
    const bundler   = new Bundler("test.wasm", makeEsbuildMock());
    const result    = await bundler.bundle(makePayload({
      files: { "index.js": oversized },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // SecurityLimits hangi error code kullanıyorsa o gelir
    expect(result.error.code).toBeTruthy();
  });

  test("tam sınırda (= BUNDLE_MAX_SIZE_BYTES) başarılı", async () => {
    const exact   = "x".repeat(SECURITY_LIMITS.BUNDLE_MAX_SIZE_BYTES);
    const bundler = new Bundler("test.wasm", makeEsbuildMock());
    const result  = await bundler.bundle(makePayload({
      files: { "index.js": exact },
    }));
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 8. bundle() — multi-file
// ─────────────────────────────────────────────────────────────────────────────

describe("Bundler.bundle() — multi-file", () => {
  test("iki dosyada esbuild.build çağrılır", async () => {
    const esbuild = makeEsbuildMock("(function(){})()");
    const bundler = new Bundler("test.wasm", esbuild);

    const result = await bundler.bundle(makePayload({
      files: {
        "index.js": "import {greet} from './utils'; greet();",
        "utils.js": "export function greet() { console.log('hi'); }",
      },
    }));

    expect(esbuild.initialize).toHaveBeenCalledTimes(1);
    expect(esbuild.build).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.bundledCode).toBe("(function(){})()");
  });

  test("esbuild.build'e doğru entryPoint geçilir", async () => {
    const esbuild = makeEsbuildMock("output");
    const bundler = new Bundler("test.wasm", esbuild);

    await bundler.bundle(makePayload({
      entryPath: "src/main.ts",
      files: {
        "src/main.ts": "import './helper'; ",
        "src/helper.ts": "export {}",
      },
    }));

    const buildCall = (esbuild.build as jest.Mock).mock.calls[0]?.[0];
    expect(buildCall.entryPoints).toContain("src/main.ts");
  });

  test("multi-file: isReady true olur", async () => {
    const bundler = new Bundler("test.wasm", makeEsbuildMock());
    expect(bundler.isReady).toBe(false);
    await bundler.bundle(makePayload({
      entryPath: "a.js",
      files: { "a.js": "1", "b.js": "2" },
    }));
    expect(bundler.isReady).toBe(true);
  });

  test("ikinci bundle çağrısında initialize tekrar çağrılmaz", async () => {
    const esbuild = makeEsbuildMock();
    const bundler = new Bundler("test.wasm", esbuild);
    const files   = { "a.js": "1", "b.js": "2" };
    const payload = makePayload({ entryPath: "a.js", files });

    await bundler.bundle(payload);
    await bundler.bundle(payload);

    expect(esbuild.initialize).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 9. bundle() — esbuild hata döndürünce
// ─────────────────────────────────────────────────────────────────────────────

describe("Bundler.bundle() — esbuild hata senaryoları", () => {
  test("errors dizisi doluysa VALIDATION_ERROR döner", async () => {
    const esbuild: IEsbuildModule = {
      initialize: jest.fn().mockResolvedValue(undefined),
      build:      jest.fn().mockResolvedValue({
        outputFiles: [],
        errors:      [{ text: "Syntax error: Unexpected token", location: { file: "a.js", line: 3 } }],
        warnings:    [],
      }),
    };
    const bundler = new Bundler("test.wasm", esbuild);
    const result  = await bundler.bundle(makePayload({
      entryPath: "a.js",
      files: { "a.js": "const x =", "b.js": "ok" },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.message).toContain("Syntax error");
  });

  test("hata mesajına konum bilgisi eklenir", async () => {
    const esbuild: IEsbuildModule = {
      initialize: jest.fn().mockResolvedValue(undefined),
      build:      jest.fn().mockResolvedValue({
        outputFiles: [],
        errors:      [{ text: "Cannot find module", location: { file: "index.js", line: 5 } }],
        warnings:    [],
      }),
    };
    const bundler = new Bundler("test.wasm", esbuild);
    const result  = await bundler.bundle(makePayload({
      files: { "index.js": "import x from 'npm-pkg'", "b.js": "ok" },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("index.js");
    expect(result.error.message).toContain("5");
  });

  test("outputFiles boş döndüğünde VALIDATION_ERROR döner", async () => {
    const esbuild: IEsbuildModule = {
      initialize: jest.fn().mockResolvedValue(undefined),
      build:      jest.fn().mockResolvedValue({
        outputFiles: [],
        errors:      [],
        warnings:    [],
      }),
    };
    const bundler = new Bundler("test.wasm", esbuild);
    const result  = await bundler.bundle(makePayload({
      entryPath: "a.js",
      entryPath: "a.js",
      files: { "a.js": "1", "b.js": "2" },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("boş");
  });

  test("build() exception fırlatırsa VALIDATION_ERROR döner", async () => {
    const esbuild: IEsbuildModule = {
      initialize: jest.fn().mockResolvedValue(undefined),
      build:      jest.fn().mockRejectedValue(new Error("WASM crash")),
    };
    const bundler = new Bundler("test.wasm", esbuild);
    const result  = await bundler.bundle(makePayload({
      entryPath: "a.js",
      entryPath: "a.js",
      files: { "a.js": "1", "b.js": "2" },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 10. bundle() — AbortSignal
// ─────────────────────────────────────────────────────────────────────────────

describe("Bundler.bundle() — AbortSignal", () => {
  test("bundle başlamadan önce abort → EXECUTION_TIMEOUT", async () => {
    const ctrl    = new AbortController();
    ctrl.abort();
    const bundler = new Bundler("test.wasm", makeEsbuildMock());
    const result  = await bundler.bundle(
      makePayload({ files: { "index.js": "code" } }),
      ctrl.signal,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EXECUTION_TIMEOUT");
  });

  test("initialize sonrası abort → EXECUTION_TIMEOUT", async () => {
    const ctrl = new AbortController();
    const esbuild: IEsbuildModule = {
      initialize: jest.fn().mockImplementation(async () => {
        ctrl.abort(); // initialize biter bitmez abort
      }),
      build: jest.fn().mockResolvedValue({
        outputFiles: [{ text: "code" }],
        errors: [],
        warnings: [],
      }),
    };
    const bundler = new Bundler("test.wasm", esbuild);
    const result  = await bundler.bundle(
      makePayload({ entryPath: "a.js", files: { "a.js": "1", "b.js": "2" } }),
      ctrl.signal,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EXECUTION_TIMEOUT");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 11. initialize() — lazy, idempotent, paralel
// ─────────────────────────────────────────────────────────────────────────────

describe("Bundler.initialize()", () => {
  test("tekil çağrıda ok(undefined) döner", async () => {
    const bundler = new Bundler("test.wasm", makeEsbuildMock());
    const result  = await bundler.initialize();
    expect(result.ok).toBe(true);
  });

  test("idempotent — iki kez çağrılırsa initialize() yalnızca bir kez çalışır", async () => {
    const esbuild = makeEsbuildMock();
    const bundler = new Bundler("test.wasm", esbuild);
    await bundler.initialize();
    await bundler.initialize();
    expect(esbuild.initialize).toHaveBeenCalledTimes(1);
  });

  test("paralel çağrılar — initialize() yalnızca bir kez çalışır", async () => {
    const esbuild = makeEsbuildMock();
    const bundler = new Bundler("test.wasm", esbuild);
    await Promise.all([
      bundler.initialize(),
      bundler.initialize(),
      bundler.initialize(),
    ]);
    expect(esbuild.initialize).toHaveBeenCalledTimes(1);
  });

  test("başlatma sonrası isReady true", async () => {
    const bundler = new Bundler("test.wasm", makeEsbuildMock());
    expect(bundler.isReady).toBe(false);
    await bundler.initialize();
    expect(bundler.isReady).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 12. initialize() — hata → retry edilebilir
// ─────────────────────────────────────────────────────────────────────────────

describe("Bundler.initialize() — hata & retry", () => {
  test("initialize hatası SANDBOX_INIT_FAILED döner", async () => {
    const esbuild: IEsbuildModule = {
      initialize: jest.fn().mockRejectedValue(new Error("WASM load failed")),
      build:      jest.fn(),
    };
    const bundler = new Bundler("bad.wasm", esbuild);
    const result  = await bundler.initialize();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SANDBOX_INIT_FAILED");
  });

  test("ilk hata sonrası tekrar initialize() denenebilir", async () => {
    let callCount = 0;
    const esbuild: IEsbuildModule = {
      initialize: jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error("first attempt fails");
        // ikinci deneme başarılı
      }),
      build: jest.fn().mockResolvedValue({
        outputFiles: [{ text: "code" }],
        errors: [], warnings: [],
      }),
    };
    const bundler = new Bundler("test.wasm", esbuild);

    const first = await bundler.initialize();
    expect(first.ok).toBe(false);
    expect(bundler.isReady).toBe(false);

    const second = await bundler.initialize();
    expect(second.ok).toBe(true);
    expect(bundler.isReady).toBe(true);
    expect(callCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 13. initialize() — dispose sonrası
// ─────────────────────────────────────────────────────────────────────────────

describe("Bundler — dispose sonrası işlemler", () => {
  test("dispose sonrası initialize SANDBOX_INIT_FAILED döner", async () => {
    const bundler = new Bundler("test.wasm", makeEsbuildMock());
    bundler.dispose();
    const result = await bundler.initialize();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SANDBOX_INIT_FAILED");
  });

  test("dispose sonrası bundle hata döner", async () => {
    const bundler = new Bundler("test.wasm", makeEsbuildMock());
    bundler.dispose();
    const result = await bundler.bundle(makePayload({
      entryPath: "a.js",
      entryPath: "a.js",
      files: { "a.js": "1", "b.js": "2" },
    }));
    expect(result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// § 14. dispose()
// ─────────────────────────────────────────────────────────────────────────────

describe("Bundler.dispose()", () => {
  test("dispose sonrası isReady false", async () => {
    const bundler = new Bundler("test.wasm", makeEsbuildMock());
    await bundler.initialize();
    expect(bundler.isReady).toBe(true);
    bundler.dispose();
    expect(bundler.isReady).toBe(false);
  });

  test("dispose idempotent — iki kez çağrılabilir", () => {
    const bundler = new Bundler("test.wasm", makeEsbuildMock());
    expect(() => {
      bundler.dispose();
      bundler.dispose();
    }).not.toThrow();
  });
});
