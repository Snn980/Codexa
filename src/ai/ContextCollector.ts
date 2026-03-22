export interface EditorSnapshot {
  activeFileId:  unknown;
  activeContent: string;
  cursorLine:    number;
  cursorCol:     number;
  openTabs:      Array<{ fileId: unknown; content: string; label: string }>;
  diagnostics:   DiagnosticEntry[];
}

export interface DiagnosticEntry {
  fileId:   unknown;
  line:     number;
  col:      number;
  message:  string;
  severity: "error" | "warning" | "info";
  label?:   string;
  source?:  string;
}

export interface ISymbolIndexReader {
  getFileSymbols(fileId: unknown): Promise<{ ok: boolean; data: Array<{ name: string; kind: string; line: number; endLine: number }> }>;
}

export interface IProjectStructureReader {
  getStructure(): Promise<{ ok: boolean; data: string }>;
}

export interface ContextItem {
  id:       string;
  kind:     "code" | "symbol" | "structure" | "diagnostic";
  fileId:   unknown;
  content:  string;
  line?:    number;
  endLine?: number;
  pinned?:  boolean;
  label?:   string;
}

export class ContextCollector {
  private _symbolIndex:      ISymbolIndexReader;
  private _projectStructure: IProjectStructureReader;

  constructor(deps: { symbolIndex: ISymbolIndexReader; projectStructure: IProjectStructureReader }) {
    this._symbolIndex      = deps.symbolIndex;
    this._projectStructure = deps.projectStructure;
  }

  async collect(snapshot: EditorSnapshot): Promise<ContextItem[]> {
    const items: ContextItem[] = [];

    // Active file
    items.push({
      id:      `active-${String(snapshot.activeFileId)}`,
      kind:    "code",
      fileId:  snapshot.activeFileId,
      content: snapshot.activeContent,
      label:   (() => { const id = String(snapshot.activeFileId); return id.includes('.') ? id : id + '.ts'; })(),
      line:    0,
    });

    // Open tabs
    for (const tab of snapshot.openTabs) {
      const label = tab.label ?? "";
      if (label.endsWith(".env") || label.endsWith(".secret")) continue;
      items.push({
        id:      `tab-${String(tab.fileId)}`,
        kind:    "code",
        fileId:  tab.fileId,
        content: tab.content,
        label:   tab.label,
      });
    }

    // Symbols
    const symResult = await this._symbolIndex.getFileSymbols(snapshot.activeFileId);
    if (symResult.ok) {
      for (const sym of symResult.data) {
        items.push({
          id:      `sym-${sym.name}-${sym.line}`,
          kind:    "symbol",
          fileId:  snapshot.activeFileId,
          content: `${sym.kind} ${sym.name}`,
          line:    sym.line,
          endLine: sym.endLine,
        });
      }
    }

    // Structure
    const structResult = await this._projectStructure.getStructure();
    if (structResult.ok) {
      items.push({
        id:      "structure",
        kind:    "structure",
        fileId:  null,
        content: structResult.data,
      });
    }

    // Diagnostics
    for (const diag of snapshot.diagnostics ?? []) {
      items.push({
        id:      `diag-${diag.line}-${diag.col}`,
        kind:    "diagnostic",
        fileId:  diag.fileId,
        content: `${diag.severity.toUpperCase()}${diag.source ? ` [${diag.source}]` : ''}${diag.label ? ` ${diag.label}` : ''}:${diag.line}:${diag.col} — ${diag.message}`,
        line:    diag.line,
        pinned:  diag.severity === "error",
      });
    }

    return items;
  }
}
