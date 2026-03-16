/**
 * @file     FileTree.ts
 * @module   core/project-manager
 * @version  1.0.1
 * @since    Phase 1 - Foundation
 *
 * Flat IFile[] listesini UI'in tuketebilecegi hiyerarsik agac yapisina donusturur.
 * Saf fonksiyon - side-effect yok, state yonetimi yok.
 *
 * Tasarim kararlari:
 *   - Giris: IFile[]  (FileService.getProjectFiles() ciktisi)
 *   - Cikis: FileTreeNode[]  (kok dugumlerin listesi)
 *   - Dizin dugumler DB'de saklanmaz; path string'inden turetilir
 *   - Siralama: dizinler once, dosyalar sonra; her grupta alfabetik
 */

import type { IFile, UUID } from "../../types/core";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Tip Tanimlari
// ─────────────────────────────────────────────────────────────────────────────

export interface FileTreeNode {
  readonly name:     string;
  readonly path:     string;
  readonly kind:     "file" | "dir";
  readonly file:     IFile | null;
  readonly children: FileTreeNode[];
}

export interface FileTreePath {
  readonly node:      FileTreeNode;
  readonly ancestors: FileTreeNode[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Dahili Mutable Yapi
// ─────────────────────────────────────────────────────────────────────────────

interface MutableNode {
  name:     string;
  path:     string;
  kind:     "file" | "dir";
  file:     IFile | null;
  children: Map<string, MutableNode>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Ana Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flat dosya listesinden hiyerarsik agac olusturur.
 *
 * Algoritma:
 *   Her IFile.path'i "/" ile bol, segment listesi uret.
 *   Kok Map uzerinde her segment icin gerekirse "dir" dugumu olustur.
 *   Son segmentte "file" dugumu ekle.
 *   Tum dosyalar islendikten sonra agaci immutable hale getir ve sirala.
 *
 * @param files - FileService.getProjectFiles() ciktisi
 */
export function buildFileTree(files: readonly IFile[]): readonly FileTreeNode[] {
  const root = new Map<string, MutableNode>();
  for (const file of files) {
    const segments = parsePath(file.path);
    if (segments.length === 0) continue;
    insertFile(root, segments, file);
  }
  return freezeAndSort(root);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Yardimci Fonksiyonlar
// ─────────────────────────────────────────────────────────────────────────────

function parsePath(path: string): string[] {
  return path.split("/").map((s) => s.trim()).filter((s) => s.length > 0);
}

function insertFile(
  current:  Map<string, MutableNode>,
  segments: string[],
  file:     IFile,
): void {
  const [head, ...rest] = segments;

  if (rest.length === 0) {
    // FIX #2: Ayni path'te zaten bir dosya varsa uzeri sessizce yazilmiyordu.
    // Duplicate path geldiginde mevcut node korunuyor, kayip onleniyor.
    if (current.has(head)) return;
    current.set(head, { name: head, path: file.path, kind: "file", file, children: new Map() });
    return;
  }

  if (!current.has(head)) {
    // FIX #3: parsePath(file.path) gerceksiz ikinci kez cagriliyordu.
    // segments zaten parsePath(file.path)'in sonucu; tekrar parse etmek yerine
    // dogrudan segments kullaniliyor — ayni sonucu verir, gereksiz allocasyon kaldirildi.
    const depthFromTop = segments.length - rest.length; // her zaman 1
    const dirPath = segments.slice(0, depthFromTop).join("/");
    current.set(head, { name: head, path: dirPath, kind: "dir", file: null, children: new Map() });
  }

  insertFile(current.get(head)!.children, rest, file);
}

function freezeAndSort(map: Map<string, MutableNode>): readonly FileTreeNode[] {
  const nodes: FileTreeNode[] = [];

  for (const m of map.values()) {
    nodes.push(Object.freeze({
      name:     m.name,
      path:     m.path,
      kind:     m.kind,
      file:     m.file,
      children: freezeAndSort(m.children) as FileTreeNode[],
    }));
  }

  return Object.freeze(
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Gezinme Yardimcilari
// ─────────────────────────────────────────────────────────────────────────────

export function findNodeById(nodes: readonly FileTreeNode[], fileId: UUID): FileTreeNode | null {
  for (const node of nodes) {
    if (node.kind === "file" && node.file?.id === fileId) return node;
    if (node.kind === "dir") {
      const found = findNodeById(node.children, fileId);
      if (found) return found;
    }
  }
  return null;
}

export function findNodeByPath(
  nodes:      readonly FileTreeNode[],
  targetPath: string,
  ancestors:  FileTreeNode[] = [],
): FileTreePath | null {
  for (const node of nodes) {
    if (node.path === targetPath) return { node, ancestors };
    if (node.kind === "dir") {
      const found = findNodeByPath(node.children, targetPath, [...ancestors, node]);
      if (found) return found;
    }
  }
  return null;
}

export function flattenTree(nodes: readonly FileTreeNode[]): FileTreeNode[] {
  const result: FileTreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === "file") result.push(node);
    else result.push(...flattenTree(node.children));
  }
  return result;
}

export function filterTree(nodes: readonly FileTreeNode[], query: string): FileTreeNode[] {
  // FIX #1: Bos query "filtre yok, hepsini goster" anlamina geliyor.
  // Onceden flattenTree(nodes) donuyordu — bu dir node'larini tamamen dusuruyordu,
  // UI agac yapisi yerine duz dosya listesi goruyordu.
  // Simdi orijinal agac oldugu gibi donduruluyor.
  if (!query.trim()) return [...nodes];
  const q = query.toLowerCase();
  return flattenTree(nodes).filter(
    (n) => n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q),
  );
}
