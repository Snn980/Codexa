/**
 * language/TreeSitterAdapter.ts
 *
 * T-4: TreeSitterStub → gerçek tree-sitter-typescript WASM.
 *
 * § 11 kararı: "Tree-sitter dil paketi yükleme → Expo asset"
 *   Bundle şişmesini önler; lazy load mümkün.
 *   WASM dosyası `assets/tree-sitter-typescript.wasm` olarak bundle'a eklenir.
 *
 * Expo Asset kullanımı:
 *   const asset = Asset.fromModule(require("../../assets/tree-sitter-typescript.wasm"));
 *   await asset.downloadAsync();
 *   const wasmPath = asset.localUri!;  // file:// URI
 *
 * tree-sitter JS API (web-tree-sitter npm paketi):
 *   import Parser from "web-tree-sitter";
 *   await Parser.init({ wasmPath });
 *   const TypeScript = await Parser.Language.load(langWasmPath);
 *   const parser = new Parser();
 *   parser.setLanguage(TypeScript);
 *   const tree = parser.parse(sourceCode);
 *
 * § 1  Result<T> / tryResultAsync()
 */

import type { Result } from "../types/core";
import { ok, err, tryResultAsync, ErrorCode } from "../utils/result";

// ─── Tree-sitter types (web-tree-sitter shapes) ────────────────────────────

/** Tree-sitter AST node — yalnızca ScopeAnalyzer'ın ihtiyacı olan alanlar */
export interface TSNode {
  readonly type:        string;
  readonly text:        string;
  readonly startIndex:  number;
  readonly endIndex:    number;
  readonly startPosition: TSPoint;
  readonly endPosition:   TSPoint;
  readonly childCount:  number;
  readonly children:    ReadonlyArray<TSNode>;
  readonly parent:      TSNode | null;
  readonly isNamed:     boolean;
  child(index: number): TSNode | null;
  childForFieldName(field: string): TSNode | null;
  namedChildren: ReadonlyArray<TSNode>;
  toString(): string;
}

export interface TSPoint {
  readonly row:    number;
  readonly column: number;
}

export interface TSTree {
  readonly rootNode: TSNode;
  /** Parse sonrası garbage collect için çağrılır */
  delete(): void;
}

export interface TSParser {
  parse(source: string, oldTree?: TSTree): TSTree;
  delete(): void;
}

// ─── ITreeSitterLoader (DI — Expo Asset veya mock) ────────────────────────

export interface ITreeSitterLoader {
  /**
   * WASM binary'sini yükle ve başlatılmış parser döndür.
   * Gerçek ortamda: Expo Asset → web-tree-sitter.
   * Test ortamında: MockTreeSitterLoader.
   */
  loadParser(): Promise<TSParser>;
}

// ─── ITreeSitterAdapter ────────────────────────────────────────────────────

export interface ITreeSitterAdapter {
  /**
   * Kaynak kodu parse et, AST döndür.
   * İlk çağrıda WASM yüklenir (lazy init).
   * Hata durumunda stub/empty tree değil, Result.err döner.
   */
  parse(source: string): Promise<Result<TSTree>>;

  /** Kaynaklar serbest bırakıldı — adapter artık kullanılamaz */
  readonly disposed: boolean;
  dispose(): void;
}

// ─── Error codes ──────────────────────────────────────────────────────────

export const TreeSitterErrorCode = {
  WASM_LOAD_FAILED:    ErrorCode.TREE_SITTER_WASM_LOAD_FAILED,
  PARSE_FAILED:        ErrorCode.TREE_SITTER_PARSE_FAILED,
  ADAPTER_DISPOSED:    ErrorCode.TREE_SITTER_ADAPTER_DISPOSED,
} as const;

// ─── TreeSitterAdapter ────────────────────────────────────────────────────

export class TreeSitterAdapter implements ITreeSitterAdapter {
  private _parser:   TSParser | null = null;
  private _loading:  Promise<TSParser> | null = null;
  private _disposed  = false;

  private readonly _loader: ITreeSitterLoader;

  constructor(loader: ITreeSitterLoader) {
    this._loader = loader;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  // ─── parse ──────────────────────────────────────────────────────────

  async parse(source: string): Promise<Result<TSTree>> {
    if (this._disposed) {
      return err(TreeSitterErrorCode.ADAPTER_DISPOSED, "TreeSitterAdapter disposed");
    }

    const parserResult = await this._ensureParser();
    if (!parserResult.ok) return parserResult;

    return tryResultAsync(
      async () => parserResult.data.parse(source),
      TreeSitterErrorCode.PARSE_FAILED,
      "Failed to parse source with Tree-sitter",
    );
  }

  // ─── dispose ────────────────────────────────────────────────────────

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._parser?.delete();
    this._parser = null;
  }

  // ─── private ────────────────────────────────────────────────────────

  /** Lazy init — WASM yalnızca ilk parse'da yüklenir */
  private async _ensureParser(): Promise<Result<TSParser>> {
    if (this._parser) return ok(this._parser);

    // Concurrent yüklemeleri tek promise'a indir
    if (!this._loading) {
      this._loading = this._loader.loadParser();
    }

    return tryResultAsync(
      async () => {
        const parser = await this._loading!;
        this._loading = null;
        this._parser  = parser;
        return parser;
      },
      TreeSitterErrorCode.WASM_LOAD_FAILED,
      "Failed to load Tree-sitter WASM",
    );
  }
}

// ─── ExpoTreeSitterLoader (gerçek ortam) ─────────────────────────────────

/**
 * Expo Asset'ten WASM yükleyici.
 * AppContainer'da inject edilir:
 *   new TreeSitterAdapter(new ExpoTreeSitterLoader())
 *
 * Bağımlılıklar (package.json'a eklenmeli):
 *   "web-tree-sitter": "^0.22.x"
 *   "tree-sitter-typescript": "^0.21.x"  (WASM için)
 *
 * app.json:
 *   "plugins": [["expo-asset", { "assets": ["./assets/tree-sitter-typescript.wasm"] }]]
 */
export class ExpoTreeSitterLoader implements ITreeSitterLoader {
  private readonly _tsWasmPath: string;
  private readonly _coreWasmPath: string;

  constructor(options: {
    /** Expo Asset localUri — file:// URI */
    coreWasmPath: string;
    tsWasmPath:   string;
  }) {
    this._coreWasmPath = options.coreWasmPath;
    this._tsWasmPath   = options.tsWasmPath;
  }

  async loadParser(): Promise<TSParser> {
    // Dynamic import — web-tree-sitter'ı lazy yükle (bundle splitter için)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Parser = (await import("web-tree-sitter")).default;

    await Parser.init({
      locateFile: () => this._coreWasmPath,
    });

    const TypeScript = await Parser.Language.load(this._tsWasmPath);
    const parser     = new Parser();
    parser.setLanguage(TypeScript);
    return parser as unknown as TSParser;
  }
}

// ─── MockTreeSitterLoader (test ortamı) ──────────────────────────────────

/**
 * Test ortamında gerçek WASM yüklemeden TreeSitterAdapter test edilir.
 * Mock TSTree / TSNode üretir.
 *
 * Kullanım:
 *   const adapter = new TreeSitterAdapter(new MockTreeSitterLoader());
 *   const result  = await adapter.parse("const x = 1;");
 */
export class MockTreeSitterLoader implements ITreeSitterLoader {
  /** Mock parse sonucu üretmek için inject edilebilir factory */
  readonly parseFn: (source: string) => TSTree;

  constructor(parseFn?: (source: string) => TSTree) {
    this.parseFn = parseFn ?? MockTreeSitterLoader._defaultParseFn;
  }

  async loadParser(): Promise<TSParser> {
    const self = this;
    return {
      parse: (source: string) => self.parseFn(source),
      delete: () => {},
    };
  }

  private static _defaultParseFn(source: string): TSTree {
    // Minimal stub tree — ScopeAnalyzer testlerinde override edilir
    const root: TSNode = {
      type:          "program",
      text:          source,
      startIndex:    0,
      endIndex:      source.length,
      startPosition: { row: 0, column: 0 },
      endPosition:   { row: source.split("\n").length - 1, column: 0 },
      childCount:    0,
      children:      [],
      namedChildren: [],
      parent:        null,
      isNamed:       true,
      child:         () => null,
      childForFieldName: () => null,
      toString:      () => `(program)`,
    };
    return {
      rootNode: root,
      delete:   () => {},
    };
  }
}
