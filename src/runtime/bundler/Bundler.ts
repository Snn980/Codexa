/**
 * @file     Bundler.ts
 * @module   runtime/bundler
 * @version  1.1.0
 * @since    Phase 2 — Runtime Sandbox
 *
 * @description
 *   esbuild-wasm ile in-memory multi-file bundle.
 *
 * Karar: esbuild sadece multi-file projede tetiklenir (handoff § 10).
 *   • `files` içinde tek dosya varsa → kodu doğrudan döner (bundle skip).
 *   • 2+ dosya varsa → virtual FS plugin üzerinden esbuild build.
 *
 * Virtual FS:
 *   Disk erişimi yok; tüm dosya içerikleri `BundlePayload.files` map'inden
 *   okunur. esbuild'in onResolve + onLoad hook'ları bunu sağlar.
 *
 * Path normalizasyonu:
 *   Tüm path'ler işlenmeden önce normalize edilir:
 *   • Ters slash → forward slash (Windows uyumu)
 *   • Baştaki "./" → kaldırılır  ("./index.js" → "index.js")
 *   Bu sayede `entryPath` ve `files` map key'leri tutarlı kalır.
 *
 * Yaşam döngüsü:
 *   new Bundler(wasmURL)  →  bundle()  →  dispose()
 *   initialize() ilk bundle() çağrısında otomatik tetiklenir.
 */

import type { AsyncResult, Result, UUID } from "../../types/core";
import { ok, err }                        from "../../utils/result";
import { validateBundleSize }             from "../sandbox/SecurityLimits";
import type { BundlePayload, BundleResult } from "../../ipc/Protocol";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. esbuild-wasm Tip Arayüzü
// ─────────────────────────────────────────────────────────────────────────────

/**
 * esbuild-wasm public API yüzeyi.
 * Test mock'u için DI; gerçek modül lazy import ile yüklenir.
 */
export interface IEsbuildModule {
  initialize(opts: { wasmURL: string; worker?: boolean }): Promise<void>;
  build(opts: EsbuildBuildOptions): Promise<EsbuildBuildResult>;
}

interface EsbuildBuildOptions {
  entryPoints: string[];
  bundle:      boolean;
  write:       boolean;
  format:      "iife" | "esm" | "cjs";
  target:      string;
  plugins:     EsbuildPlugin[];
  logLevel:    "silent" | "error" | "warning" | "info";
}

interface EsbuildPlugin {
  name:  string;
  setup: (build: EsbuildBuild) => void;
}

interface EsbuildBuild {
  onResolve(
    opts: { filter: RegExp; namespace?: string },
    cb:   (args: { path: string; importer: string; namespace: string }) =>
            | { path: string; namespace: string }
            | null
            | undefined,
  ): void;
  onLoad(
    opts: { filter: RegExp; namespace: string },
    cb:   (args: { path: string }) =>
            | { contents: string; loader: EsbuildLoader }
            | { errors: Array<{ text: string }> }
            | null
            | undefined,
  ): void;
}

type EsbuildLoader = "js" | "ts" | "jsx" | "tsx" | "json" | "text";

interface EsbuildBuildResult {
  outputFiles?: Array<{ text: string }>;
  errors:       Array<{ text: string; location?: { file?: string; line?: number } }>;
  warnings:     Array<{ text: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. BundlerState
// ─────────────────────────────────────────────────────────────────────────────

// as const — const enum yok (Hermes uyumu, handoff kararı)
const BundlerState = {
  Idle:         "idle",
  Initializing: "initializing",
  Ready:        "ready",
  Disposed:     "disposed",
} as const;
type BundlerState = typeof BundlerState[keyof typeof BundlerState];

// ─────────────────────────────────────────────────────────────────────────────
// § 3. Bundler
// ─────────────────────────────────────────────────────────────────────────────

export class Bundler {
  private _state:       BundlerState = BundlerState.Idle;
  private _initPromise: Promise<Result<void>> | null = null;
  private readonly _wasmURL: string;
  private _esbuild:     IEsbuildModule | null;

  /**
   * @param wasmURL — esbuild.wasm URL'i (Expo asset veya test stub).
   * @param esbuild — Test mock'u için DI; verilmezse lazy import kullanılır.
   */
  constructor(wasmURL: string, esbuild?: IEsbuildModule) {
    this._wasmURL = wasmURL;
    this._esbuild = esbuild ?? null;
  }

  // ── Initialize ────────────────────────────────────────────────────────────

  /**
   * esbuild-wasm'ı başlatır. Lazy + idempotent.
   * Paralel çağrılar aynı Promise'i bekler — race condition yok.
   */
  async initialize(): AsyncResult<void> {
    if (this._state === BundlerState.Ready)    return ok(undefined);
    if (this._state === BundlerState.Disposed) {
      return err("SANDBOX_INIT_FAILED", "Bundler dispose edilmiş");
    }

    if (this._initPromise) return this._initPromise;

    this._state       = BundlerState.Initializing;
    this._initPromise = this._doInitialize();

    const result = await this._initPromise;
    if (!result.ok) {
      this._state       = BundlerState.Idle;   // retry edilebilir
      this._initPromise = null;
    }
    return result;
  }

  private async _doInitialize(): Promise<Result<void>> {
    try {
      if (!this._esbuild) {
        // esbuild-wasm named export'larla gelir; destructure ile tip güvenli atama.
        const mod     = await import("esbuild-wasm");
        this._esbuild = {
          initialize: mod.initialize.bind(mod),
          build:      mod.build.bind(mod),
        };
      }

      await this._esbuild.initialize({ wasmURL: this._wasmURL, worker: false });

      this._state = BundlerState.Ready;
      return ok(undefined);
    } catch (cause) {
      return err("SANDBOX_INIT_FAILED", "esbuild başlatılamadı", {
        cause: String(cause),
      });
    }
  }

  // ── Bundle ────────────────────────────────────────────────────────────────

  /**
   * Projeyi bundle eder; tek dosyaysa esbuild atlanır.
   *
   * @param payload — executionId, entryPath, files map.
   * @param signal  — İptal sinyali (isteğe bağlı).
   */
  async bundle(
    payload: BundlePayload,
    signal?: AbortSignal,
  ): AsyncResult<BundleResult> {
    if (signal?.aborted) {
      return err("EXECUTION_TIMEOUT", "Bundle iptal edildi");
    }

    // Tüm path'leri normalize et — Windows uyumu + "./" tutarsızlığı giderilir
    const entryPath = normalizePath(payload.entryPath);
    const files     = normalizeFiles(payload.files);

    if (!files[entryPath]) {
      return err(
        "VALIDATION_ERROR",
        `Entry bulunamadı: ${entryPath}`,
        { availableFiles: Object.keys(files).join(", ") },
      );
    }

    const totalSize = Object.values(files).reduce((s, c) => s + c.length, 0);
    const sizeCheck = validateBundleSize(totalSize);
    if (!sizeCheck.ok) return sizeCheck;

    // ── Tek dosya — esbuild skip ─────────────────────────────────────────────
    if (Object.keys(files).length === 1) {
      const code = files[entryPath]!;
      return ok({ executionId: payload.executionId, bundledCode: code, sizeBytes: code.length });
    }

    // ── Multi-file — esbuild ─────────────────────────────────────────────────
    const init = await this.initialize();
    if (!init.ok) return init;

    if (signal?.aborted) {
      return err("EXECUTION_TIMEOUT", "Initialize sonrası iptal edildi");
    }

    return this._runEsbuild(payload.executionId, entryPath, files, signal);
  }

  // ── esbuild Build ─────────────────────────────────────────────────────────

  private async _runEsbuild(
    executionId: UUID,
    entryPath:   string,
    files:       Record<string, string>,
    signal?:     AbortSignal,
  ): AsyncResult<BundleResult> {
    if (!this._esbuild) {
      return err("SANDBOX_INIT_FAILED", "esbuild hazır değil");
    }

    try {
      const result = await this._esbuild.build({
        entryPoints: [entryPath],
        bundle:      true,
        write:       false,
        format:      "iife",
        target:      "es2020",
        logLevel:    "silent",
        plugins:     [this._makeVirtualFSPlugin(files)],
      });

      if (result.errors.length > 0) {
        // location bilgisi (file:line) hata mesajına eklenir
        const message = result.errors
          .map((e) => {
            const loc = e.location
              ? ` (${e.location.file ?? "?"}:${e.location.line ?? "?"})`
              : "";
            return `${e.text}${loc}`;
          })
          .join("\n");
        return err("VALIDATION_ERROR", message);
      }

      if (result.warnings.length > 0) {
        // eslint-disable-next-line no-console
        console.warn("[Bundler] esbuild warnings:", result.warnings);
      }

      if (signal?.aborted) {
        return err("EXECUTION_TIMEOUT", "Bundle iptal edildi");
      }

      const bundledCode = result.outputFiles?.[0]?.text ?? "";
      if (!bundledCode) {
        return err("VALIDATION_ERROR", "Bundle boş döndü");
      }

      const sizeCheck = validateBundleSize(bundledCode.length);
      if (!sizeCheck.ok) return sizeCheck;

      return ok({ executionId, bundledCode, sizeBytes: bundledCode.length });

    } catch (cause) {
      return err("VALIDATION_ERROR", "esbuild runtime hatası", {
        cause: String(cause),
      });
    }
  }

  // ── Virtual FS Plugin ─────────────────────────────────────────────────────

  /**
   * esbuild'in disk erişimini `files` map'ine yönlendirir.
   *
   * onResolve sırası (kritik):
   *   1. importer === ""  → entry point  → virtual
   *   2. göreli / mutlak  → resolvePath  → virtual
   *   3. bare specifier   → hata namespace
   */
  private _makeVirtualFSPlugin(files: Record<string, string>): EsbuildPlugin {
    return {
      name: "virtual-fs",
      setup: (build) => {

        build.onResolve({ filter: /.*/ }, (args) => {
          // path normalize et — "./" prefix ve ters slash temizlenir
          const path = normalizePath(args.path);

          // Entry point: importer boş string olur
          if (args.importer === "") {
            return { path, namespace: "virtual" };
          }

          // Göreli veya mutlak import
          if (path.startsWith(".") || path.startsWith("/")) {
            const resolved = resolvePath(args.importer, path);
            return { path: resolved, namespace: "virtual" };
          }

          // Bare specifier — sandbox'ta desteklenmez
          return { path, namespace: "bare-specifier-error" };
        });

        build.onLoad(
          { filter: /.*/, namespace: "bare-specifier-error" },
          (args) => ({
            errors: [{
              text: `"${args.path}" sandbox'ta desteklenmez. Yalnızca göreli import'lar kullanın.`,
            }],
          }),
        );

        build.onLoad(
          { filter: /.*/, namespace: "virtual" },
          (args) => {
            let finalPath = args.path;
            // content === undefined kontrolü — boş string geçerli dosyadır
            let content   = files[finalPath];

            if (content === undefined) {
              const ext = tryExtensions(finalPath, files);
              if (ext !== null) {
                finalPath = ext;
                content   = files[ext];
              }
            }

            if (content === undefined) {
              return {
                errors: [{
                  text: `Dosya bulunamadı: ${finalPath}`,
                }],
              };
            }

            return { contents: content, loader: detectLoader(finalPath) };
          },
        );
      },
    };
  }

  // ── Dispose ───────────────────────────────────────────────────────────────

  dispose(): void {
    this._state       = BundlerState.Disposed;
    this._initPromise = null;
    this._esbuild     = null;   // GC'ye bırak
  }

  // ── Durum ─────────────────────────────────────────────────────────────────

  get isReady(): boolean { return this._state === BundlerState.Ready; }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. Path Yardımcıları
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tek bir path'i normalize eder.
 *   • Ters slash → forward slash  (Windows uyumu)
 *   • Baştaki "./" → kaldır       ("./index.js" → "index.js")
 *
 * @example
 *   normalizePath(".\\src\\app.ts")  // "src/app.ts"
 *   normalizePath("./index.js")      // "index.js"
 *   normalizePath("src/utils.ts")    // "src/utils.ts"
 */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/**
 * files map'indeki tüm key'leri normalize eder.
 * bundle() çağrısında ilk iş bu dönüşüm yapılır; sonrası tutarlı.
 */
function normalizeFiles(files: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k in files) {
    out[normalizePath(k)] = files[k]!;
  }
  return out;
}

/**
 * Göreli veya mutlak import path'ini normalize eder.
 *
 * @example
 *   resolvePath("src/index.js",  "./utils")       // "src/utils"
 *   resolvePath("src/a/b.js",    "../lib/c.js")   // "src/lib/c.js"
 *   resolvePath("src/a/b.js",    "/lib/utils.js") // "lib/utils.js"
 */
export function resolvePath(importer: string, importPath: string): string {
  const isAbsolute = importPath.startsWith("/");

  const importerDir = !isAbsolute && importer.includes("/")
    ? importer.slice(0, importer.lastIndexOf("/"))
    : "";

  // Mutlak path: sadece importPath segmentleri; importerDir yoksayılır
  const segments = isAbsolute
    ? importPath.split("/")
    : [
        ...(importerDir ? importerDir.split("/") : []),
        ...importPath.split("/"),
      ];

  const resolved: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (resolved.length) resolved.pop(); // kök üstüne çıkma yok
    } else {
      resolved.push(seg);
    }
  }

  return resolved.join("/");
}

/**
 * Path bulunamazsa bilinen uzantıları ekleyerek arar.
 *
 * @example
 *   tryExtensions("src/utils", { "src/utils.ts": "..." })  // "src/utils.ts"
 *   tryExtensions("src/nope",  {})                         // null
 */
export function tryExtensions(
  path:  string,
  files: Record<string, string>,
): string | null {
  const EXT = [".js", ".ts", ".jsx", ".tsx", "/index.js", "/index.ts"];
  for (const ext of EXT) {
    const candidate = path + ext;
    if (files[candidate] !== undefined) return candidate;
  }
  return null;
}

/**
 * Dosya uzantısından esbuild loader belirler.
 *
 * @example
 *   detectLoader("App.tsx")   // "tsx"
 *   detectLoader("data.json") // "json"
 *   detectLoader("readme.md") // "text"
 */
export function detectLoader(path: string): EsbuildLoader {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const MAP: Record<string, EsbuildLoader> = {
    js: "js", mjs: "js", cjs: "js",
    ts: "ts",
    jsx: "jsx",
    tsx: "tsx",
    json: "json",
  };
  return MAP[ext] ?? "text";
}
