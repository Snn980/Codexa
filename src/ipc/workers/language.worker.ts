// ─────────────────────────────────────────────────────────────
// ipc/workers/language.worker.ts
// Language Intelligence Worker
//
// Tree-sitter WASM (stub — Phase 3.5'te gerçek binding gelecek) +
// SymbolIndex üzerinden tam LSP-style mesaj protokolü.
//
// Desteklenen mesajlar:
//   Lifecycle  : initialize, openFile, updateFile, closeFile
//   Indexing   : parseFile, reindexProject
//   Features   : definition, references, hover, completion, rename
//   Analysis   : diagnostics
//   LSP+       : symbols, format, semanticTokens, folding        ← Phase 4 stub
//   Graph      : getSymbol, getDependencies, getDependents
//   Control    : cancel
//
// Phase 3 | v1.3.1
//
// v1.3.0 → v1.3.1 — types.ts v1.1.0 ile hizalama:
//   [LW-T1] TreeSitterStub: scope "Module" → SymbolScope.Module ("module")
//   [LW-T2] TreeSitterStub: isExported alanı kaldırıldı (SymbolNode'da yok)
//   [LW-T3] TreeSitterStub: exportedAs undefined → null
//   [LW-T4] TreeSitterStub: EdgeKind "static" → "import_static"
//           SymbolScope value import eklendi
//
// v1.2 → v1.3 değişiklikleri:
//   [LW-12] Handler Map → Record<WorkerMessageType, HandlerFn>
//           Exhaustiveness garantisi: union'a eklenen her tip
//           handler kaydı olmadan derleme hatası verir.
//   [LW-13] symbols, format, semanticTokens, folding mesaj tipleri
//           eklendi (Phase 4 stub) — union genişletildi,
//           handler'lar şimdilik boş/placeholder döner.
// ─────────────────────────────────────────────────────────────

import type { UUID, Result } from "../../core";

import { SymbolIndex, type ParsedFile } from "../../language-services/SymbolIndex";
import type { CursorContext } from "../../language-services/graph/ReferenceIndex";
import {
  SymbolScope,
  type SymbolNode,
  type SymbolKind,
  type EdgeKind,
  type ReferenceLocation,
} from "../../language-services/graph/types";

// ─────────────────────────────────────────────────────────────
// § 1. Protocol types
// ─────────────────────────────────────────────────────────────

type WorkerMessageType =
  // Lifecycle
  | "initialize"
  | "openFile"
  | "updateFile"
  | "closeFile"
  // Indexing
  | "parseFile"
  | "reindexProject"
  // Features
  | "definition"
  | "references"
  | "hover"
  | "completion"
  | "rename"
  // Analysis
  | "diagnostics"
  // [LW-13] LSP+ — Phase 4 stubs
  | "symbols"          // document symbol tree (outline)
  | "format"           // full-file formatting
  | "semanticTokens"   // syntax highlighting tokens
  | "folding"          // code folding ranges
  // Graph
  | "getSymbol"
  | "getDependencies"
  | "getDependents"
  // Control
  | "cancel";

interface WorkerRequest<P = unknown> {
  readonly id:      string;
  readonly type:    WorkerMessageType;
  readonly payload: P;
}

interface WorkerResponse<T = unknown> {
  readonly id:         string;
  readonly type:       WorkerMessageType;
  readonly ok:         boolean;
  readonly data?:      T;
  readonly error?:     WorkerError;
  readonly cancelled?: true;
}

interface WorkerError {
  readonly code:    string;
  readonly message: string;
}

interface WorkerNotification<T = unknown> {
  readonly type:  "notification";
  readonly event: string;
  readonly data:  T;
}

// ─────────────────────────────────────────────────────────────
// § 2. Payload types
// ─────────────────────────────────────────────────────────────

interface InitializePayload {
  fileIds:   UUID[];
  projectId: UUID;
}

interface OpenFilePayload {
  fileId:  UUID;
  content: string;
  version: number;
}

interface UpdateFilePayload {
  fileId:  UUID;
  content: string;
  version: number;
}

interface CloseFilePayload {
  fileId: UUID;
}

interface ParseFilePayload {
  fileId:  UUID;
  content: string;
  version: number;
}

interface ReindexProjectPayload {
  fileIds: UUID[];
}

interface CursorPayload {
  fileId: UUID;
  line:   number;
  col:    number;
}

interface CompletionPayload extends CursorPayload {
  prefix: string;
}

interface RenamePayload extends CursorPayload {
  newName: string;
}

interface DiagnosticsPayload {
  fileId: UUID;
}

// [LW-13] LSP+ payloads
interface SymbolsPayload {
  fileId: UUID;
}

interface FormatPayload {
  fileId:   UUID;
  tabSize?: number;
  insertSpaces?: boolean;
}

interface SemanticTokensPayload {
  fileId: UUID;
}

interface FoldingPayload {
  fileId: UUID;
}

interface GetSymbolPayload {
  symbolId: UUID;
  fileId:   UUID;
}

interface GetDependenciesPayload {
  fileId:      UUID;
  transitive?: boolean;
}

interface GetDependentsPayload {
  fileId:      UUID;
  transitive?: boolean;
}

interface CancelPayload {
  targetId: string;
}

// ─────────────────────────────────────────────────────────────
// § 3. Tree-sitter stub
// ─────────────────────────────────────────────────────────────

interface ITreeSitterParser {
  isReady: boolean;
  init(): Promise<void>;
  parse(content: string, fileId: UUID): Omit<ParsedFile, "version" | "content">;
}

class TreeSitterStub implements ITreeSitterParser {
  isReady = false;

  async init(): Promise<void> {
    // Phase 3.5: await TreeSitter.init(); this._tsParser = new TreeSitter.Parser(); ...
    this.isReady = true;
  }

  parse(content: string, fileId: UUID): Omit<ParsedFile, "version" | "content"> {
    const symbols    = this._extractSymbols(content, fileId);
    const rawImports = this._extractImports(content);
    const refs       = this._extractRefs(content, fileId, symbols);
    return { fileId, symbols, rawImports, refs };
  }

  private _extractSymbols(content: string, fileId: UUID): ParsedFile["symbols"] {
    const symbols: ParsedFile["symbols"][number][] = [];
    const lines = content.split("\n");

    const patterns: Array<{ re: RegExp; kind: SymbolKind; exported: boolean }> = [
      { re: /^export\s+(?:async\s+)?function\s+(\w+)/,  kind: "function",   exported: true  },
      { re: /^(?:async\s+)?function\s+(\w+)/,           kind: "function",   exported: false },
      { re: /^export\s+class\s+(\w+)/,                  kind: "class",      exported: true  },
      { re: /^class\s+(\w+)/,                           kind: "class",      exported: false },
      { re: /^export\s+interface\s+(\w+)/,              kind: "interface",  exported: true  },
      { re: /^interface\s+(\w+)/,                       kind: "interface",  exported: false },
      { re: /^export\s+type\s+(\w+)\s*=/,              kind: "type_alias", exported: true  },
      { re: /^type\s+(\w+)\s*=/,                       kind: "type_alias", exported: false },
      { re: /^export\s+enum\s+(\w+)/,                  kind: "enum",       exported: true  },
      { re: /^enum\s+(\w+)/,                           kind: "enum",       exported: false },
      { re: /^export\s+const\s+(\w+)/,                 kind: "constant",   exported: true  },
      { re: /^export\s+(?:let|var)\s+(\w+)/,           kind: "variable",   exported: true  },
      { re: /^const\s+(\w+)/,                          kind: "constant",   exported: false },
      { re: /^(?:let|var)\s+(\w+)/,                    kind: "variable",   exported: false },
    ];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx].trim();
      for (const { re, kind, exported } of patterns) {
        const m = re.exec(line);
        if (!m) continue;
        const name = m[1];
        const col  = lines[lineIdx].indexOf(name);
        symbols.push({
          id:         stubId(`${fileId}:${name}:${lineIdx}:${col}`),
          fileId,
          name,
          kind,
          scope:      SymbolScope.Module,   // "module" — [LW-T1]
          line:       lineIdx,
          col,
          endCol:     col + name.length,
          exportedAs: exported ? name : null,    // [LW-T3] null, undefined değil
          // [LW-T2] isExported alanı SymbolNode'da yok — kaldırıldı
          endLine:    lineIdx,
          parentId:   null,
        });
        break;
      }
    }

    return symbols;
  }

  private _extractImports(content: string): ParsedFile["rawImports"] {
    const result: ParsedFile["rawImports"][number][] = [];
    const lines = content.split("\n");

    const patterns: Array<{
      re: RegExp; kind: EdgeKind; specIdx: number; namesIdx: number | null;
    }> = [
      { re: /^import\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/, kind: "type_only",     namesIdx: 1, specIdx: 2 },
      { re: /^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/,        kind: "import_static", namesIdx: 1, specIdx: 2 },
      { re: /^import\s+\*\s+as\s+\w+\s+from\s+['"]([^'"]+)['"]/,     kind: "import_static", namesIdx: null, specIdx: 1 },
      { re: /^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/,              kind: "import_static", namesIdx: 1, specIdx: 2 },
      { re: /^export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/,        kind: "re_export", namesIdx: 1, specIdx: 2 },
    ];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx].trim();
      for (const { re, kind, namesIdx, specIdx } of patterns) {
        const m = re.exec(line);
        if (!m) continue;
        result.push({
          specifier: m[specIdx],
          names:     namesIdx
            ? m[namesIdx].split(",").map(s => s.trim()).filter(Boolean)
            : ["*"],
          kind,
          line: lineIdx,
        });
        break;
      }
    }

    return result;
  }

  private _extractRefs(
    content: string,
    fileId: UUID,
    symbols: ParsedFile["symbols"]
  ): ReferenceLocation[] {
    const refs: ReferenceLocation[] = [];
    const lines = content.split("\n");

    for (const sym of symbols) {
      const re = new RegExp(`\\b${escapeRegex(sym.name)}\\b`, "g");
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          const col    = m.index;
          const isDecl = lineIdx === sym.line && col === sym.col;
          refs.push({
            id:       stubId(`${sym.id}:${fileId}:${lineIdx}:${col}`),
            symbolId: sym.id,
            fileId,
            line:     lineIdx,
            col,
            endCol:   col + sym.name.length,
            isDecl,
            isWrite:  isDecl,
          });
        }
      }
    }

    return refs;
  }
}

// ─────────────────────────────────────────────────────────────
// § 4. Open file registry
// ─────────────────────────────────────────────────────────────

interface OpenFileEntry {
  fileId:        UUID;
  content:       string;
  version:       number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

// ─────────────────────────────────────────────────────────────
// § 5. Completion & Diagnostics types
// ─────────────────────────────────────────────────────────────

interface CompletionItem {
  label:     string;
  kind:      SymbolKind | "keyword";
  detail?:   string;
  sortText?: string;
}

interface Diagnostic {
  fileId:   UUID;
  line:     number;
  col:      number;
  endCol:   number;
  severity: "error" | "warning" | "info" | "hint";
  message:  string;
  code?:    string;
}

// [LW-13] LSP+ result types — Phase 4'te doldurulacak
interface DocumentSymbol {
  name:     string;
  kind:     SymbolKind;
  line:     number;
  col:      number;
  endLine:  number;
  endCol:   number;
  children: DocumentSymbol[];
}

interface SemanticToken {
  line:      number;
  col:       number;
  length:    number;
  tokenType: string;
}

interface FoldingRange {
  startLine: number;
  endLine:   number;
  kind:      "region" | "imports" | "comment";
}

interface TextEdit {
  line:        number;
  startCol:    number;
  endCol:      number;
  replacement: string;
}

// ─────────────────────────────────────────────────────────────
// § 6. Handler map type
//
// [LW-12] Record<WorkerMessageType, HandlerFn> — Map yerine.
//
// Map farkı:
//   Map  → yeni mesaj tipi eklenip handler yazılmayınca
//          runtime'da "Unknown message type" hatası alırsın.
//   Record → WorkerMessageType union'ı genişleyince tüm
//            key'lerin var olması zorunlu — derleme hatası.
//
// requestId: reindexProject gibi uzun işlemlerin cancel
// kontrolü için gerekli; kısa handler'lar yoksayar.
// ─────────────────────────────────────────────────────────────

type HandlerFn = (payload: unknown, requestId: string) => Promise<unknown>;

// ─────────────────────────────────────────────────────────────
// § 7. LanguageWorker
// ─────────────────────────────────────────────────────────────

const PARSE_DEBOUNCE_MS = 300;

const TS_KEYWORDS = [
  "const", "let", "var", "function", "class", "interface",
  "type", "enum", "import", "export", "return", "async",
  "await", "if", "else", "for", "while", "switch", "case",
  "break", "continue", "new", "this", "typeof", "instanceof",
  "null", "undefined", "true", "false",
] as const;

class LanguageWorker {
  private _index:      SymbolIndex | null = null;
  private _parser:     ITreeSitterParser;
  private _openFiles   = new Map<UUID, OpenFileEntry>();
  private _initialized = false;
  private _cancelledIds = new Set<string>();

  // [LW-12] Record — exhaustiveness compile-time garantisi.
  // Yeni bir WorkerMessageType eklendiğinde buraya da eklenmesi
  // zorunlu; aksi halde TypeScript derlemeyi reddeder.
  private readonly _handlers: Record<WorkerMessageType, HandlerFn>;

  constructor(parser: ITreeSitterParser) {
    this._parser = parser;

    this._handlers = {
      // Lifecycle
      initialize:      (p)     => this._initialize(p as InitializePayload),
      openFile:        (p)     => this._openFile(p as OpenFilePayload),
      updateFile:      (p)     => this._updateFile(p as UpdateFilePayload),
      closeFile:       (p)     => this._closeFile(p as CloseFilePayload),
      // Indexing
      parseFile:       (p)     => this._parseFile(p as ParseFilePayload),
      reindexProject:  (p, id) => this._reindexProject(p as ReindexProjectPayload, id),
      // Features
      definition:      (p)     => this._definition(p as CursorPayload),
      references:      (p)     => this._references(p as CursorPayload),
      hover:           (p)     => this._hover(p as CursorPayload),
      completion:      (p)     => this._completion(p as CompletionPayload),
      rename:          (p)     => this._rename(p as RenamePayload),
      // Analysis
      diagnostics:     (p)     => this._diagnostics(p as DiagnosticsPayload),
      // [LW-13] LSP+ — Phase 4 stubs
      symbols:         (p)     => this._symbols(p as SymbolsPayload),
      format:          (p)     => this._format(p as FormatPayload),
      semanticTokens:  (p)     => this._semanticTokens(p as SemanticTokensPayload),
      folding:         (p)     => this._folding(p as FoldingPayload),
      // Graph — senkron metodlar Promise.resolve ile sarılıyor
      getSymbol:       (p)     => Promise.resolve(this._getSymbol(p as GetSymbolPayload)),
      getDependencies: (p)     => Promise.resolve(this._getDependencies(p as GetDependenciesPayload)),
      getDependents:   (p)     => Promise.resolve(this._getDependents(p as GetDependentsPayload)),
      // Control — cancel handleMessage'da erken yakalanır,
      // buraya asla ulaşmaz; tip tamlığı için gerekli.
      cancel:          ()      => Promise.resolve(undefined),
    };
  }

  // ── Mesaj girişi ─────────────────────────────────────────────

  async handleMessage(req: WorkerRequest): Promise<void> {
    if (req.type === "cancel") {
      this._cancelledIds.add((req.payload as CancelPayload).targetId);
      return;
    }

    if (this._cancelledIds.has(req.id)) {
      this._cancelledIds.delete(req.id);
      self.postMessage(cancelledResponse(req));
      return;
    }

    let response: WorkerResponse;

    try {
      const data = await this._dispatch(req);

      if (this._cancelledIds.has(req.id)) {
        this._cancelledIds.delete(req.id);
        self.postMessage(cancelledResponse(req));
        return;
      }

      response = { id: req.id, type: req.type, ok: true, data };
    } catch (e: unknown) {
      response = {
        id:    req.id,
        type:  req.type,
        ok:    false,
        error: { code: "WORKER_ERROR", message: errorMessage(e) },
      };
    }

    self.postMessage(response);
  }

  // ── Dispatch: sıfır mantık — sadece lookup ───────────────────
  private async _dispatch(req: WorkerRequest): Promise<unknown> {
    return this._handlers[req.type](req.payload, req.id);
  }

  // ─────────────────────────────────────────────────────────────
  // § 8. Lifecycle handlers
  // ─────────────────────────────────────────────────────────────

  private async _initialize(p: InitializePayload): Promise<{ ok: boolean }> {
    if (this._initialized) return { ok: true };
    await this._parser.init();
    // Phase 3.5: this._index = new SymbolIndex(levelProxy, sqlProxy, resolverProxy, eventBusProxy)
    this._initialized = true;
    return { ok: true };
  }

  private async _openFile(p: OpenFilePayload): Promise<{ ok: boolean }> {
    this._guardParser("openFile");
    this._openFiles.set(p.fileId, {
      fileId: p.fileId, content: p.content, version: p.version, debounceTimer: null,
    });
    await this._doParse(p.fileId, p.content, p.version);
    return { ok: true };
  }

  private async _updateFile(p: UpdateFilePayload): Promise<{ ok: boolean }> {
    this._guardParser("updateFile");

    const entry = this._openFiles.get(p.fileId);

    if (entry) {
      if (p.version <= entry.version) return { ok: true };
      if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer);

      entry.content = p.content;
      entry.version = p.version;

      entry.debounceTimer = setTimeout(() => {
        entry.debounceTimer = null;
        this._doParse(p.fileId, p.content, p.version).catch(e => {
          this._postNotification("error", {
            type: "parseFile", fileId: p.fileId, message: errorMessage(e),
          });
        });
      }, PARSE_DEBOUNCE_MS);
    } else {
      this._openFiles.set(p.fileId, {
        fileId: p.fileId, content: p.content, version: p.version, debounceTimer: null,
      });
      await this._doParse(p.fileId, p.content, p.version);
    }

    return { ok: true };
  }

  private async _closeFile(p: CloseFilePayload): Promise<{ ok: boolean }> {
    const entry = this._openFiles.get(p.fileId);
    if (entry?.debounceTimer !== null) clearTimeout(entry!.debounceTimer!);
    this._openFiles.delete(p.fileId);
    // Phase 3.5: SymbolIndex.invalidatePosCache(fileId) public API eklenecek
    if (this._index) (this._index as any)._refs?.invalidatePosCache(p.fileId);
    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────
  // § 9. Indexing handlers
  // ─────────────────────────────────────────────────────────────

  private async _parseFile(p: ParseFilePayload): Promise<{ ok: boolean }> {
    this._guardParser("parseFile");
    await this._doParse(p.fileId, p.content, p.version);
    return { ok: true };
  }

  private async _reindexProject(
    p: ReindexProjectPayload,
    requestId: string
  ): Promise<{ indexed: number; failed: number; missing: UUID[] }> {
    this._guardParser("reindexProject");

    let indexed = 0;
    let failed  = 0;
    const missing: UUID[] = [];

    for (const fileId of p.fileIds) {
      if (this._cancelledIds.has(requestId)) {
        this._cancelledIds.delete(requestId);
        break;
      }

      const entry = this._openFiles.get(fileId);
      if (!entry?.content) { missing.push(fileId); failed++; continue; }

      try {
        await this._doParse(fileId, entry.content, entry.version);
        indexed++;
      } catch { failed++; }
    }

    return { indexed, failed, missing };
  }

  // ─────────────────────────────────────────────────────────────
  // § 10. Feature handlers
  // ─────────────────────────────────────────────────────────────

  private async _definition(p: CursorPayload): Promise<unknown> {
    return unwrap(await this._requireIndex("definition").findDefinition(cursorCtx(p)));
  }

  private async _references(p: CursorPayload): Promise<unknown> {
    return unwrap(await this._requireIndex("references")
      .findAllReferences(cursorCtx(p), { includeDeclaration: true }));
  }

  private async _hover(p: CursorPayload): Promise<unknown> {
    return unwrap(await this._requireIndex("hover").getHoverInfo(cursorCtx(p)));
  }

  private async _completion(p: CompletionPayload): Promise<CompletionItem[]> {
    // Phase 4: Tree-sitter AST + type inference
    const items: CompletionItem[] = [];
    const lp = p.prefix.toLowerCase();

    if (this._index) {
      for (const sym of this._index.getFileSymbols(p.fileId)) {
        if (!sym.name.toLowerCase().startsWith(lp)) continue;
        items.push({
          label:    sym.name,
          kind:     sym.kind,
          detail:   sym.exportedAs ? `export ${sym.kind}` : sym.kind,
          sortText: `0_${sym.name}`,
        });
      }
    }

    for (const kw of TS_KEYWORDS) {
      if (!kw.startsWith(lp)) continue;
      items.push({ label: kw, kind: "keyword", sortText: `9_${kw}` });
    }

    return items.sort((a, b) =>
      (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label)
    );
  }

  private async _rename(p: RenamePayload): Promise<unknown> {
    const candidate = unwrap(
      await this._requireIndex("rename").prepareRename(cursorCtx(p))
    );
    if (!candidate) return null;
    return { ...candidate, newName: p.newName };
  }

  // ─────────────────────────────────────────────────────────────
  // § 11. Diagnostics
  // ─────────────────────────────────────────────────────────────

  // Phase 4: ESLint WASM + TypeScript LSP diagnostics
  private async _diagnostics(_p: DiagnosticsPayload): Promise<Diagnostic[]> {
    return [];
  }

  // ─────────────────────────────────────────────────────────────
  // § 12. LSP+ handlers — Phase 4 stubs
  //
  // [LW-13] Tipler ve handler'lar şimdiden tanımlandı.
  // Tüm mesajlar protocol'de var; ana thread gönderebilir,
  // boş/placeholder yanıt alır. Phase 4'te Tree-sitter AST
  // üzerinden doldurulacak.
  // ─────────────────────────────────────────────────────────────

  // Document symbol tree — editör outline paneli için
  private async _symbols(p: SymbolsPayload): Promise<DocumentSymbol[]> {
    if (!this._index) return [];

    // Stub: flat liste — gerçek implementasyon nested tree üretecek
    return this._index.getFileSymbols(p.fileId).map(sym => ({
      name:     sym.name,
      kind:     sym.kind,
      line:     sym.line,
      col:      sym.col,
      endLine:  sym.line,
      endCol:   sym.endCol,
      children: [],
    }));
  }

  // Full-file formatting — indentation normalizasyonu (§ 76)
  // Prettier WASM geldiğinde bu yöntem kaldırılacak (Phase 4 upgrade point).
  private async _format(p: FormatPayload): Promise<{ edits: TextEdit[] }> {
    const entry = this._openFiles.get(p.fileId);
    if (!entry) return { edits: [] };

    const tabSize      = p.tabSize      ?? 2;
    const insertSpaces = p.insertSpaces ?? true;
    const indent       = insertSpaces ? " ".repeat(tabSize) : "\t";
    const lines        = entry.content.split("\n");
    const edits: TextEdit[] = [];

    for (let i = 0; i < lines.length; i++) {
      const original = lines[i];

      // Boş satır → koru
      if (original.trim() === "") continue;

      // Baştaki whitespace normalizasyonu:
      // mevcut girinti miktarını hesapla → indent birimlerine yuvarlา
      const match = original.match(/^(\s*)/);
      if (!match) continue;
      const ws = match[1];

      // Tab → space (veya space → tab) dönüşümü
      const currentSpaces = ws.replace(/\t/g, " ".repeat(tabSize)).length;
      const indentLevel   = Math.round(currentSpaces / tabSize);
      const normalized    = indent.repeat(indentLevel) + original.trimStart();

      if (normalized !== original) {
        edits.push({
          line:        i,
          startCol:    0,
          endCol:      original.length,
          replacement: normalized,
        });
      }
    }

    return { edits };
  }

  // Semantic highlighting tokens — Phase 4: Tree-sitter highlights
  private async _semanticTokens(p: SemanticTokensPayload): Promise<SemanticToken[]> {
    if (!this._index) return [];

    // Stub: sembolleri token olarak döndür
    return this._index.getFileSymbols(p.fileId).map(sym => ({
      line:      sym.line,
      col:       sym.col,
      length:    sym.endCol - sym.col,
      tokenType: sym.kind,
    }));
  }

  // Code folding ranges — bracket + import tespiti (§ 76)
  // Tree-sitter WASM geldiğinde AST tabanlı ile değiştirilecek.
  private async _folding(p: FoldingPayload): Promise<FoldingRange[]> {
    const entry = this._openFiles.get(p.fileId);
    if (!entry) return [];

    const lines  = entry.content.split("\n");
    const ranges: FoldingRange[] = [];
    const stack:  Array<{ line: number; kind: FoldingRange["kind"] }> = [];

    // import bloğu tespiti — ardışık import satırları
    let importStart = -1;
    let lastImport  = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // import bloğu
      if (/^import\s/.test(trimmed) || /^from\s+['"]/.test(trimmed)) {
        if (importStart === -1) importStart = i;
        lastImport = i;
      } else if (importStart !== -1 && trimmed !== "" && !/^\/\//.test(trimmed)) {
        if (lastImport > importStart) {
          ranges.push({ startLine: importStart, endLine: lastImport, kind: "imports" });
        }
        importStart = -1;
        lastImport  = -1;
      }

      // { } blok fold
      const opens  = (line.match(/\{/g) ?? []).length;
      const closes = (line.match(/\}/g) ?? []).length;

      for (let j = 0; j < opens; j++) {
        stack.push({ line: i, kind: "region" });
      }
      for (let j = 0; j < closes; j++) {
        const open = stack.pop();
        if (open && i > open.line) {
          ranges.push({ startLine: open.line, endLine: i, kind: open.kind });
        }
      }

      // /* */ yorum bloğu
      if (/\/\*/.test(line) && !/\*\//.test(line)) {
        stack.push({ line: i, kind: "comment" });
      } else if (/\*\//.test(line) && stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top?.kind === "comment") {
          stack.pop();
          if (i > top.line) ranges.push({ startLine: top.line, endLine: i, kind: "comment" });
        }
      }
    }

    // Bitmemiş import bloğu
    if (importStart !== -1 && lastImport > importStart) {
      ranges.push({ startLine: importStart, endLine: lastImport, kind: "imports" });
    }

    // En az 2 satır olan aralıkları döndür
    return ranges
      .filter(r => r.endLine - r.startLine >= 1)
      .sort((a, b) => a.startLine - b.startLine);
  }

  // ─────────────────────────────────────────────────────────────
  // § 13. Graph query handlers
  // ─────────────────────────────────────────────────────────────

  private _getSymbol(p: GetSymbolPayload): SymbolNode | null {
    if (!this._index) return null;
    // Phase 3.5: SymbolIndex.getSymbol(symbolId) public API eklenecek
    return this._index.getFileSymbols(p.fileId).find(s => s.id === p.symbolId) ?? null;
  }

  private _getDependencies(p: GetDependenciesPayload): ReadonlyArray<UUID> {
    if (!this._index) return [];
    return p.transitive
      ? this._index.getTransitiveDeps(p.fileId)
      : this._index.getDirectDeps(p.fileId);
  }

  private _getDependents(p: GetDependentsPayload): ReadonlyArray<UUID> {
    if (!this._index) return [];
    return p.transitive
      ? this._index.getImpactedFiles(p.fileId)
      : this._index.getDirectDependants(p.fileId);
  }

  // ─────────────────────────────────────────────────────────────
  // § 14. Core parse pipeline
  // ─────────────────────────────────────────────────────────────

  private async _doParse(fileId: UUID, content: string, version: number): Promise<void> {
    const parsed: ParsedFile = {
      ...this._parser.parse(content, fileId),
      version,
      content,
    };

    if (this._index) {
      const result = await this._index.indexFile(parsed);
      if (!result.ok) {
        this._postNotification("error", {
          type: "parseFile", fileId, message: result.error?.message ?? "indexFile failed",
        });
        return;
      }
    }

    this._postNotification("parsed", {
      fileId,
      version,
      symbolCount: parsed.symbols.length,
      importCount: parsed.rawImports.length,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // § 15. Guards
  // ─────────────────────────────────────────────────────────────

  private _requireIndex(feature: string): SymbolIndex {
    if (!this._initialized) {
      throw new Error(`Worker not initialized (feature: ${feature})`);
    }
    if (!this._parser.isReady) {
      throw new Error(`Parser not ready (feature: ${feature})`);
    }
    if (!this._index) {
      throw new Error(
        `SymbolIndex not available (feature: ${feature}). Phase 3.5: storage DI needed.`
      );
    }
    return this._index;
  }

  private _guardParser(caller: string): void {
    if (!this._initialized) {
      throw new Error(`Worker not initialized (caller: ${caller})`);
    }
    if (!this._parser.isReady) {
      throw new Error(`Parser not ready (caller: ${caller})`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // § 16. Notification helper
  // ─────────────────────────────────────────────────────────────

  private _postNotification<T>(event: string, data: T): void {
    const msg: WorkerNotification<T> = { type: "notification", event, data };
    self.postMessage(msg);
  }
}

// ─────────────────────────────────────────────────────────────
// § 17. Worker bootstrap
// ─────────────────────────────────────────────────────────────

const worker = new LanguageWorker(new TreeSitterStub());

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  worker.handleMessage(event.data).catch(e => {
    console.error("[LanguageWorker] unhandled:", e);
  });
});

// ─────────────────────────────────────────────────────────────
// § 18. Utilities
// ─────────────────────────────────────────────────────────────

function cursorCtx(p: CursorPayload): CursorContext {
  return { fileId: p.fileId, line: p.line, col: p.col };
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw Object.assign(
      new Error(result.error?.message ?? "unknown"),
      { code: result.error?.code }
    );
  }
  return result.data;
}

function cancelledResponse(req: WorkerRequest): WorkerResponse {
  return { id: req.id, type: req.type, ok: false, cancelled: true };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Stub ID — Phase 3.5'te fnv1a_uuid ile değiştirilecek */
function stubId(seed: string): UUID {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h  = (h * 0x01000193) >>> 0;
  }
  const hex = h.toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-000000000000` as UUID;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
