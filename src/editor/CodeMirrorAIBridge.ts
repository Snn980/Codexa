/**
 * editor/CodeMirrorAIBridge.ts — CodeMirror 6 ↔ AI entegrasyonu
 *
 * DÜZELTMELER:
 *   ❗ DOC.TOSTRING()   : Büyük dosyada O(n) kopya. CM6'da sliceString()
 *      kullanılır — belirli aralığı kopyalar, tüm dokümanı değil.
 *      IDocSlice arayüzü eklendi; test mock'u da sliceString tabanlı.
 *   💡 SHEBANG DETECT  : Extensionsız dosyalarda (#!) satırı parse edilir.
 *      İçerik bazlı fallback: "<?php", "import React" gibi işaretler.
 *   💡 COORDS NULL GUARD: getOverlayPosition her edge case'de null döner;
 *      contentDOM.getBoundingClientRect() de null guard alır.
 */

import type { CursorContext } from "../hooks/useCodeCompletion";

// ─── CM6 arayüz stub'ları ─────────────────────────────────────────────────────

/**
 * ❗ DOC.TOSTRING() yerine sliceString():
 * CM6 Text.sliceString(from, to) yalnızca istenen aralığı kopyalar.
 * Tüm dokümanı toString() ile almak O(n); prefix/suffix için gereksiz.
 */
export interface IDocSlice {
  length: number;
  sliceString(from: number, to?: number): string;
  lineAt(pos: number): { from: number; to: number; number: number };
}

export interface CMEditorState {
  doc: IDocSlice;
  selection: { main: { head: number; anchor: number } };
}

export interface CMEditorView {
  state: CMEditorState;
  coordsAtPos(pos: number): { top: number; left: number; bottom: number } | null;
  contentDOM: { getBoundingClientRect(): DOMRect | null };
}

// ─── Dil tespiti ──────────────────────────────────────────────────────────────

const EXT_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript",
  py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
  swift: "swift", cpp: "cpp", cc: "cpp", cxx: "cpp", c: "c",
  cs: "csharp", rb: "ruby", php: "php", lua: "lua", r: "r",
  html: "html", htm: "html", css: "css", scss: "css", less: "css",
  json: "json", jsonc: "json", md: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml", sql: "sql",
};

/**
 * 💡 SHEBANG / CONTENT DETECT:
 * 1. Dosya uzantısına bak.
 * 2. Uzantı yoksa / bilinmiyorsa shebang satırını parse et.
 * 3. Hâlâ bilinmiyorsa prefix'in ilk 200 karakterine bak.
 */
export function detectLanguage(filename: string, prefixHint = ""): string {
  // 1. Uzantı
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext && EXT_MAP[ext]) return EXT_MAP[ext];

  // 2. Shebang (#!)
  const firstLine = prefixHint.split("\n")[0]?.trim() ?? "";
  if (firstLine.startsWith("#!")) {
    const shebang = firstLine.toLowerCase();
    if (shebang.includes("python"))     return "python";
    if (shebang.includes("node"))       return "javascript";
    if (shebang.includes("deno"))       return "typescript";
    if (shebang.includes("ruby"))       return "ruby";
    if (shebang.includes("bash") || shebang.includes("sh")) return "bash";
    if (shebang.includes("perl"))       return "plaintext";
  }

  // 3. İçerik ipuçları (ilk 200 karakter)
  const hint = prefixHint.slice(0, 200);
  if (hint.includes("<?php"))                  return "php";
  if (/import\s+React/.test(hint))             return "typescript";
  if (/from\s+'react'|from\s+"react"/.test(hint)) return "typescript";
  if (/def\s+\w+\s*\(/.test(hint))            return "python";
  if (/fn\s+\w+\s*\(/.test(hint))             return "rust";
  if (/package\s+main/.test(hint))             return "go";

  return "plaintext";
}

/** Geriye dönük uyumluluk — sadece uzantı */
export function detectLanguageFromFilename(filename: string): string {
  return detectLanguage(filename);
}

// ─── Cursor bağlamı ───────────────────────────────────────────────────────────

const BEFORE_CURSOR_CHARS = 4_000;
const AFTER_CURSOR_CHARS  = 2_000;

/**
 * ❗ DOC.TOSTRING() → sliceString():
 * Yalnızca cursor etrafındaki pencereyi kopyala; tüm doküman değil.
 */
export function extractCursorContext(
  state: CMEditorState,
  language: string,
): CursorContext {
  const cursorPos = state.selection.main.head;
  const docLen    = state.doc.length;

  const fromPrefix = Math.max(0, cursorPos - BEFORE_CURSOR_CHARS);
  const toSuffix   = Math.min(docLen, cursorPos + AFTER_CURSOR_CHARS);

  // ❗ sliceString — O(slice) değil O(n) değil
  const prefix = state.doc.sliceString(fromPrefix, cursorPos);
  const suffix = state.doc.sliceString(cursorPos, toSuffix);

  return { prefix, suffix, language };
}

// ─── Overlay pozisyonu ────────────────────────────────────────────────────────

export interface OverlayPosition { top: number; left: number; }

/**
 * 💡 COORDS NULL GUARD:
 * coordsAtPos ve getBoundingClientRect her ikisi de null olabilir.
 */
export function getOverlayPosition(
  view: CMEditorView,
  containerRect: DOMRect | null,
  _lineHeightPx = 22,
): OverlayPosition | null {
  if (!containerRect) return null; // ❗ null guard

  const cursorPos = view.state.selection.main.head;
  const coords    = view.coordsAtPos(cursorPos);
  if (!coords) return null;       // ❗ null guard

  // ❗ contentDOM null guard
  const editorRect = view.contentDOM.getBoundingClientRect();
  if (!editorRect) return null;

  return {
    top:  coords.bottom - containerRect.top  + 4,
    left: coords.left   - containerRect.left,
  };
}

// ─── CM6 ViewUpdate dinleyici fabrikası ──────────────────────────────────────

export function createCM6UpdateListener(
  getFilename: () => string,
  onEditorChange: (ctx: CursorContext) => void,
  onCursorMove?: (pos: number) => void,
): (update: { docChanged: boolean; selectionSet: boolean; view: CMEditorView }) => void {
  return (update) => {
    if (!update.docChanged && !update.selectionSet) return;

    if (update.docChanged) {
      // 💡 SHEBANG DETECT: prefix hint için sadece ilk 200 char al
      const hint = update.view.state.doc.sliceString(0, 200);
      const lang  = detectLanguage(getFilename(), hint);
      const ctx   = extractCursorContext(update.view.state, lang);
      onEditorChange(ctx);
    }

    if (update.selectionSet && onCursorMove) {
      onCursorMove(update.view.state.selection.main.head);
    }
  };
}

// ─── Mock EditorState (test) ──────────────────────────────────────────────────

export function createMockEditorState(
  content: string,
  cursorPos: number,
): CMEditorState {
  return {
    doc: {
      length: content.length,
      // ❗ sliceString implementasyonu: String.prototype.slice ile
      sliceString(from: number, to?: number): string {
        return content.slice(from, to);
      },
      lineAt(pos: number) {
        const before    = content.slice(0, pos);
        const lineStart = before.lastIndexOf("\n") + 1;
        const rawEnd    = content.indexOf("\n", pos);
        return {
          from:   lineStart,
          to:     rawEnd === -1 ? content.length : rawEnd,
          number: (before.match(/\n/g) ?? []).length + 1,
        };
      },
    },
    selection: { main: { head: cursorPos, anchor: cursorPos } },
  };
}
