/**
 * runtime/graph/types.ts
 * language-services/graph/types.ts re-export — runtime katmanı için proxy.
 * SymbolIndex ve ilgili runtime modülleri bu path üzerinden import eder.
 */

export type {
  Checksum32,
  SymbolKind,
  SymbolScope,
  EdgeKind,
  SymbolNode,
  DependencyEdge,
  ReferenceLocation,
  FileSnapshot,
} from "../../language-services/graph/types";

export {
  SymbolKind,
  SymbolScope,
  EdgeKind,
  MAX_IMPORTED_NAMES,
} from "../../language-services/graph/types";
