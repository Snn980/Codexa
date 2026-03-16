/**
 * storage/ProjectStructureReader.ts
 *
 * LevelDB'deki dosya meta listesinden compact project tree üretir.
 * Phase 5.4 — ProjectStructureReader (T-10)
 *
 * Algoritma:
 *  1. `fmeta:{projectId}:` prefix'iyle LevelDB scan
 *  2. `deleted=true` kayıtları filtrele
 *  3. Path'leri segment dizilerine böl: "src/utils/helper.ts" → ["src","utils","helper.ts"]
 *  4. Trie-style iç içe Map ile ağaç kur (max depth 3)
 *  5. Alfabetik sırala — directory'ler önce
 *
 * § 1:  Result<T> / tryResultAsync()
 * § 12: LevelDB key şeması — `fmeta:{projectId}:{path}`
 */

import type {
  IProjectStructureReader,
  ProjectStructureItem,
  FileMeta,
} from "./IProjectStructureReader";
import {
  MAX_STRUCTURE_DEPTH,
  MAX_STRUCTURE_FILES,
  FMETA_KEY_PREFIX,
  parseFmetaKey,
} from "./IProjectStructureReader";

// ─── ILevelDb (minimal DI interface) ─────────────────────────────────────

export interface ILevelDb {
  /**
   * Verilen prefix ile başlayan tüm key-value çiftlerini döner.
   * Sıralama: lexicographic ascending (LevelDB varsayılanı).
   */
  scan(prefix: string): Promise<ReadonlyArray<{ key: string; value: string }>>;
}

// ─── Trie node (internal) ─────────────────────────────────────────────────

interface TrieNode {
  /** Segment adı (dosya veya dizin) */
  name:     string;
  kind:     "file" | "directory";
  meta:     FileMeta | null;         // dosya ise dolu
  children: Map<string, TrieNode>;
}

// ─── ProjectStructureReader ───────────────────────────────────────────────

export class ProjectStructureReader implements IProjectStructureReader {
  private readonly _db: ILevelDb;

  constructor(db: ILevelDb) {
    this._db = db;
  }

  // ─── IProjectStructureReader ───────────────────────────────────────────

  async getProjectStructure(projectId: string): Promise<ReadonlyArray<ProjectStructureItem>> {
    const prefix = `${FMETA_KEY_PREFIX}${projectId}:`;

    let rows: ReadonlyArray<{ key: string; value: string }>;
    try {
      rows = await this._db.scan(prefix);
    } catch {
      // Non-fatal: ContextCollector structure hatasında pipeline'ı durdurmaz (§ 14.2)
      return [];
    }

    // 1. Parse + filtrele
    const entries: Array<{ path: string; meta: FileMeta }> = [];
    let fileCount = 0;

    for (const { key, value } of rows) {
      if (fileCount >= MAX_STRUCTURE_FILES) break;

      const path = parseFmetaKey(key, projectId);
      if (!path) continue;

      let meta: FileMeta;
      try {
        meta = JSON.parse(value) as FileMeta;
      } catch {
        continue; // Corrupt row — skip
      }

      if (meta.deleted) continue;

      entries.push({ path, meta });
      fileCount++;
    }

    // 2. Trie kur
    const root = new Map<string, TrieNode>();
    for (const { path, meta } of entries) {
      this._insert(root, path.split("/"), meta, 0);
    }

    // 3. Tree'ye dönüştür
    return this._toItems(root, 0);
  }

  // ─── private ──────────────────────────────────────────────────────────

  /**
   * Segment dizisini Trie'ye insert eder.
   * Max depth aşılırsa kalan segment'lar tek "file" node olarak düzleştirilir.
   */
  private _insert(
    nodes:    Map<string, TrieNode>,
    segments: string[],
    meta:     FileMeta,
    depth:    number,
  ): void {
    if (segments.length === 0) return;

    const [head, ...rest] = segments;

    if (rest.length === 0 || depth >= MAX_STRUCTURE_DEPTH - 1) {
      // Leaf: dosya
      const label = rest.length === 0 ? head : segments.join("/");
      nodes.set(label, {
        name:     label,
        kind:     "file",
        meta,
        children: new Map(),
      });
      return;
    }

    // Directory node
    let dir = nodes.get(head);
    if (!dir) {
      dir = { name: head, kind: "directory", meta: null, children: new Map() };
      nodes.set(head, dir);
    } else if (dir.kind === "file") {
      // Çakışma: aynı isimde dosya + dizin — directory'yi tercih et (edge case)
      dir.kind     = "directory";
      dir.meta     = null;
      dir.children = new Map();
    }

    this._insert(dir.children, rest, meta, depth + 1);
  }

  /**
   * Trie node'larını `ProjectStructureItem[]`'a çevirir.
   * Sıra: directory'ler önce, her grup içinde alfabetik.
   */
  private _toItems(
    nodes: Map<string, TrieNode>,
    depth: number,
  ): ReadonlyArray<ProjectStructureItem> {
    const items: ProjectStructureItem[] = [];

    // Önce directory'ler, sonra dosyalar — her grup alfabetik
    const sorted = [...nodes.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const node of sorted) {
      if (node.kind === "directory") {
        const children =
          depth + 1 < MAX_STRUCTURE_DEPTH
            ? this._toItems(node.children, depth + 1)
            : [];

        items.push({ path: node.name, kind: "directory", children });
      } else {
        const item: ProjectStructureItem = {
          path:       node.name,
          kind:       "file",
          sizeBytes:  node.meta?.sizeBytes,
          modifiedAt: node.meta?.modifiedAt,
        };
        items.push(item);
      }
    }

    return items;
  }
}
