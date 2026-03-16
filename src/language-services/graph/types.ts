// ─────────────────────────────────────────────────────────────
// language-services/graph/types.ts
// Shared type definitions — Symbol Graph sistemi
// Phase 3 | v1.1.0
//
// Değişiklikler v1.0.0 → v1.1.0:
//   #1  Values import eklendi
//   #2  DeepReadonly<SymbolNode> kaldırıldı (gereksiz, yanıltıcı)
//   #3  DependencyEdge.id eklendi; UNIQUE kısıtı kind dahil güncellendi
//   #4  ReferenceLocation.id eklendi
//   #5  dep_fwd / dep_rev prefix'leri (çakışma riski giderildi)
//   #6  Symbol id hash uyarısı güçlendirildi (fileId zorunlu)
//   #7  SymbolScope.Module yorumu düzeltildi
//   #8  Checksum32 branded type
//   #9  SymbolNode.version eklendi (SQL şemasıyla hizalandı)
//  #10  MAX_IMPORTED_NAMES sabiti + isTruncated alanı
// ─────────────────────────────────────────────────────────────

import type { UUID, Values } from "../../core";
// NOT: DeepReadonly import edilmiyor — bu dosyadaki tüm interface'ler
// zaten tamamen readonly primitive field içeriyor. #2 fix

// ── Branded checksum tipi ─────────────────────────────────────
// FNV-1a 32-bit unsigned integer. `number` yerine branded type
// kullanılır; dosya checksum'u ile sembol checksum'u tip düzeyinde
// birbirinden ayrılır, yanlış atama derleme hatası verir. #8 fix
export type Checksum32 = number & { readonly _brand: "Checksum32" };

// ── importedNames boyut sınırı ────────────────────────────────
// SQLite'a JSON text olarak kaydedilir. Büyük barrel-export
// dosyalarında (ör. lodash re-export) bu liste yüzlerce isim
// içerebilir ve her okumada deserialize edilir.
// 128'i aşan listeler storage katmanında truncate edilir;
// isTruncated=true ile işaretlenir. Tam liste gerekirse
// tree-sitter'dan yeniden parse yeterli. #10 fix
export const MAX_IMPORTED_NAMES = 128;

// ── Symbol kinds (Tree-sitter node type'larına karşılık gelir) ──
export const SymbolKind = {
  Function:    "function",
  Class:       "class",
  Interface:   "interface",
  Variable:    "variable",
  Constant:    "constant",
  TypeAlias:   "type_alias",
  Enum:        "enum",
  EnumMember:  "enum_member",
  Method:      "method",
  Property:    "property",
  Import:      "import",
  Export:      "export",
  Namespace:   "namespace",
  Parameter:   "parameter",
} as const;
export type SymbolKind = Values<typeof SymbolKind>;   // #1 fix: Values artık import ediliyor

// ── Scope visibility ──────────────────────────────────────────
export const SymbolScope = {
  Global:   "global",
  // File-level scope. Export edilip edilmemesinden BAĞIMSIZ —
  // exported semboller de bu scope'ta olabilir; exportedAs alanı
  // bunu gösterir. "not exported" anlamına GELMEZ. #7 fix
  Module:   "module",
  Block:    "block",
  // SymbolKind.Function ile string değeri aynı ("function").
  // Farklı namespace'ler olduğu için runtime çakışması yok;
  // ama dikkatli olun: typeof ile karşılaştırma yaparken tiplere bakın.
  Function: "function",
} as const;
export type SymbolScope = Values<typeof SymbolScope>;

// ── Dependency edge türleri ───────────────────────────────────
export const EdgeKind = {
  ImportStatic:  "import_static",    // import x from "..."
  ImportDynamic: "import_dynamic",   // import("...")
  Require:       "require",          // require("...")
  ReExport:      "re_export",        // export { x } from "..."
  TypeOnly:      "type_only",        // import type { T } from "..."
} as const;
export type EdgeKind = Values<typeof EdgeKind>;

// ── Core node: tek bir sembol ─────────────────────────────────
export interface SymbolNode {
  // Deterministic UUID üretimi: fnv1a_uuid(fileId + ":" + name + ":" + line + ":" + col)
  // UYARI: fileId MUTLAKA hash input'una dahil edilmeli.
  // Aksi hâlde farklı dosyalarda aynı name+line+col'a sahip
  // semboller aynı id'yi üretir → graph corruption. #6 fix
  readonly id:         UUID;
  readonly fileId:     UUID;
  readonly name:       string;
  readonly kind:       SymbolKind;
  readonly scope:      SymbolScope;
  readonly line:       number;          // 0-indexed
  readonly col:        number;          // 0-indexed
  readonly endLine:    number;
  readonly endCol:     number;
  readonly parentId:   UUID | null;     // enclosing scope sembolü
  readonly exportedAs: string | null;   // re-export'ta ad farklıysa
  // İçerik değişiklik tespiti — kriptografik değil, hız öncelikli.
  // FileSnapshot.checksum ile aynı Checksum32 tipi ama semantik
  // olarak farklı: bu sembolün kaynak dilim hash'i. #8 fix
  readonly checksum:   Checksum32;
  // Optimistic lock — GraphStorage.writeSnapshot içinde
  // "WHERE id=? AND version=?" guard'ı için. Her yazımda +1. #9 fix
  readonly version:    number;
}

// ── Dependency edge: dosya→dosya bağımlılık ───────────────────
export interface DependencyEdge {
  // Deterministic UUID: fnv1a_uuid(fromFileId + ":" + rawSpecifier + ":" + kind)
  // kind dahil edilmeli çünkü aynı specifier'ın hem ImportStatic
  // hem TypeOnly olarak gelmesi mümkün (mixed import pattern). #3 fix
  readonly id:            UUID;
  readonly fromFileId:    UUID;
  readonly toFileId:      UUID;
  readonly kind:          EdgeKind;
  // SQLite'a JSON text olarak kaydedilir (bkz. MAX_IMPORTED_NAMES). #10 fix
  readonly importedNames: ReadonlyArray<string>;
  // importedNames MAX_IMPORTED_NAMES'i aştığı için truncate edildiyse true.
  readonly isTruncated:   boolean;
  readonly rawSpecifier:  string;   // "./utils" | "react"
  readonly line:          number;
  readonly isResolved:    boolean;  // false = node_modules / path çözümlenemedi
}

// ── Reference: bir sembolün kullanıldığı yer ─────────────────
export interface ReferenceLocation {
  // Deterministic UUID: fnv1a_uuid(symbolId + ":" + fileId + ":" + line + ":" + col)
  // SQL PRIMARY KEY ile eşleşir. #4 fix
  readonly id:       UUID;
  readonly symbolId: UUID;
  readonly fileId:   UUID;
  readonly line:     number;
  readonly col:      number;
  readonly endCol:   number;
  readonly isWrite:  boolean;   // true = assignment / mutation
  readonly isDecl:   boolean;   // true = tanım noktası (declaration site)
}

// ── Snapshot: bir dosyanın tüm graph verisi ───────────────────
export interface FileSnapshot {
  readonly fileId:   UUID;
  // Dosya-seviyesi optimistic lock sayacı.
  // SymbolNode.version'dan ayrı: bu tüm dosyanın versiyonu. #9 fix
  readonly version:  number;
  // Dosya içeriğinin Checksum32'si.
  // SymbolNode.checksum ile aynı branded type ama farklı semantik:
  // bu tüm dosya içeriğini, o sadece bir sembolün kaynak dilimini temsil eder.
  readonly checksum: Checksum32;
  readonly symbols:  ReadonlyArray<SymbolNode>;
  readonly deps:     ReadonlyArray<DependencyEdge>;
  readonly refs:     ReadonlyArray<ReferenceLocation>;
  readonly parsedAt: number;   // Date.now()
}

// ── Query result tipleri ──────────────────────────────────────
export interface SymbolMatch {
  // SymbolNode tüm alanları readonly primitive — DeepReadonly gereksizdi. #2 fix
  readonly symbol:  SymbolNode;
  readonly score:   number;   // fuzzy match score 0–1
  readonly fileId:  UUID;
}

export interface GraphStats {
  readonly symbolCount:    number;
  readonly fileCount:      number;
  readonly edgeCount:      number;
  readonly referenceCount: number;
  readonly lastUpdated:    number;
}

// ── LevelDB key şemaları (tip güvenli string builder) ─────────
// dep_fwd / dep_rev kullanılır:
//   Eski "dep:" ve "depr:" — teknik olarak startsWith çakışması
//   yoktu ("depr:x".startsWith("dep:") === false) ama okunabilirlik
//   ve range scan güvenliği için netleştirildi. #5 fix
export const LevelKey = {
  symbol:   (fileId: UUID, symbolId: UUID) => `sym:${fileId}:${symbolId}` as const,
  fileSyms: (fileId: UUID)                 => `fsym:${fileId}` as const,
  // Giden bağımlılık listesi: fromFileId → DependencyEdge[]
  depFwd:   (fromId: UUID)                 => `dep_fwd:${fromId}` as const,
  // Gelen bağımlılık listesi (reverse index): toFileId → fromFileId[]
  depRev:   (toId: UUID)                   => `dep_rev:${toId}` as const,
  ref:      (symbolId: UUID)               => `ref:${symbolId}` as const,
  snapshot: (fileId: UUID)                 => `snap:${fileId}` as const,
  stats:    ()                             => `meta:stats` as const,
} as const;

// ── SQLite schema sabitleri ───────────────────────────────────
export const SQL = {
  CREATE_SYMBOLS: `
    CREATE TABLE IF NOT EXISTS ls_symbols (
      id          TEXT PRIMARY KEY,
      file_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      scope       TEXT NOT NULL,
      line        INTEGER NOT NULL,
      col         INTEGER NOT NULL,
      end_line    INTEGER NOT NULL,
      end_col     INTEGER NOT NULL,
      parent_id   TEXT,
      exported_as TEXT,
      checksum    INTEGER NOT NULL,
      version     INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_ls_symbols_file ON ls_symbols(file_id);
    CREATE INDEX IF NOT EXISTS idx_ls_symbols_name ON ls_symbols(name);
    CREATE INDEX IF NOT EXISTS idx_ls_symbols_kind ON ls_symbols(kind);
  `,

  CREATE_DEPENDENCIES: `
    CREATE TABLE IF NOT EXISTS ls_dependencies (
      id              TEXT PRIMARY KEY,
      from_file_id    TEXT NOT NULL,
      to_file_id      TEXT NOT NULL,
      kind            TEXT NOT NULL,
      raw_specifier   TEXT NOT NULL,
      imported_names  TEXT NOT NULL,
      is_truncated    INTEGER NOT NULL DEFAULT 0,
      line            INTEGER NOT NULL,
      is_resolved     INTEGER NOT NULL DEFAULT 1,
      UNIQUE(from_file_id, raw_specifier, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_ls_dep_from ON ls_dependencies(from_file_id);
    CREATE INDEX IF NOT EXISTS idx_ls_dep_to   ON ls_dependencies(to_file_id);
  `,
  // UNIQUE değişti: (from_file_id, to_file_id, raw_specifier) → (from_file_id, raw_specifier, kind)
  // Aynı dosyadan aynı specifier'ın hem ImportStatic hem TypeOnly olması geçerli. #3 fix

  CREATE_REFERENCES: `
    CREATE TABLE IF NOT EXISTS ls_references (
      id          TEXT PRIMARY KEY,
      symbol_id   TEXT NOT NULL,
      file_id     TEXT NOT NULL,
      line        INTEGER NOT NULL,
      col         INTEGER NOT NULL,
      end_col     INTEGER NOT NULL,
      is_write    INTEGER NOT NULL DEFAULT 0,
      is_decl     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ls_ref_symbol ON ls_references(symbol_id);
    CREATE INDEX IF NOT EXISTS idx_ls_ref_file   ON ls_references(file_id);
  `,
} as const;
