// src/language-services/ScopeAnalyzer.ts
// AST tabanlı scope analizi

import type { Result } from "../core";
import { ok, err } from "../core";

export const ScopeKind = {
  GLOBAL:         "global",
  MODULE:         "module",
  FUNCTION:       "function",
  ARROW_FUNCTION: "arrow_function",
  CLASS:          "class",
  NAMESPACE:      "namespace",
} as const;
export type ScopeKind = (typeof ScopeKind)[keyof typeof ScopeKind];

export const ScopeErrorCode = {
  SYMBOL_NOT_FOUND: "SCOPE_SYMBOL_NOT_FOUND",
  PARSE_ERROR:      "SCOPE_PARSE_ERROR",
} as const;
export type ScopeErrorCode = (typeof ScopeErrorCode)[keyof typeof ScopeErrorCode];

export interface ScopeNode {
  kind:      ScopeKind;
  name?:     string;
  startRow:  number;
  endRow:    number;
  children:  ScopeNode[];
}

export interface AnalyzeResult {
  root:    ScopeNode;
  parseMs: number;
}

interface TSNode {
  type:          string;
  startPosition: { row: number; column: number };
  endPosition:   { row: number; column: number };
  namedChildren?: TSNode[];
  childForFieldName?: (name: string) => TSNode | null;
  text?: string;
  delete?: () => void;
}

interface IAdapter {
  parse(source: string): Promise<Result<{ rootNode: TSNode; delete?: () => void }>>;
}

function nodeKind(type: string): ScopeKind | null {
  switch (type) {
    case "program":               return ScopeKind.MODULE;
    case "function_declaration":
    case "function_expression":
    case "method_definition":     return ScopeKind.FUNCTION;
    case "class_declaration":
    case "class_expression":      return ScopeKind.CLASS;
    case "arrow_function":        return ScopeKind.ARROW_FUNCTION;
    default:                      return null;
  }
}

export class ScopeAnalyzer {
  private readonly _adapter: IAdapter | null;

  constructor(adapter?: unknown) {
    this._adapter = (
      adapter !== null &&
      typeof (adapter as IAdapter).parse === "function"
    ) ? (adapter as IAdapter) : null;
  }

  async analyze(source: string): Promise<Result<AnalyzeResult>> {
    const t0 = Date.now();
    if (!this._adapter) {
      return err(ScopeErrorCode.PARSE_ERROR as import("../types/core").ErrorCode, "No adapter");
    }
    const parsed = await this._adapter.parse(source);
    if (!parsed.ok) {
      return err(ScopeErrorCode.PARSE_ERROR as import("../types/core").ErrorCode, "Parse failed");
    }
    const root: ScopeNode = {
      kind: ScopeKind.MODULE, startRow: 0, endRow: Number.MAX_SAFE_INTEGER, children: [],
    };
    const walk = (node: TSNode, parent: ScopeNode): void => {
      const kind = nodeKind(node.type);
      let current = parent;
      if (kind && kind !== ScopeKind.MODULE) {
        const nameNode = node.childForFieldName?.("name") ?? null;
        const child: ScopeNode = {
          kind,
          name:     nameNode?.text ?? undefined,
          startRow: node.startPosition.row,
          endRow:   node.endPosition.row,
          children: [],
        };
        parent.children.push(child);
        current = child;
      }
      for (const c of node.namedChildren ?? []) walk(c, current);
    };
    walk(parsed.data.rootNode, root);
    parsed.data.delete?.();
    return ok({ root, parseMs: Date.now() - t0 });
  }

  async findScopeAt(content: string, line: number, _col: number): Promise<Result<ScopeNode>> {
    const analyzed = await this.analyze(content);
    if (!analyzed.ok) return analyzed;
    const { root } = analyzed.data;
    const findNarrowest = (node: ScopeNode): ScopeNode | null => {
      if (node.startRow > line || node.endRow < line) return null;
      for (const child of node.children) {
        const found = findNarrowest(child);
        if (found) return found;
      }
      return node;
    };
    const found = findNarrowest(root);
    if (!found) {
      return err(ScopeErrorCode.SYMBOL_NOT_FOUND as import("../types/core").ErrorCode, `No scope at ${line}:${_col}`);
    }
    if (found === root && root.children.length === 0 && line > 0) {
      return err(ScopeErrorCode.SYMBOL_NOT_FOUND as import("../types/core").ErrorCode, `No scope at ${line}:${_col}`);
    }
    return ok(found);
  }

  buildScopeTree(_f: unknown, _c: string, _s: unknown[]): unknown {
    return ok({ root: { kind: ScopeKind.MODULE, startRow: 0, endRow: 0, children: [] } });
  }
}
