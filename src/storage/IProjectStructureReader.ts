/**
 * storage/IProjectStructureReader.ts
 *
 * ContextCollector'ın kullandığı proje yapısı arayüzü.
 * Phase 5.4 — ProjectStructureReader (T-10)
 *
 * § 14.2: IProjectStructureReader stub → gerçek dosya sistemi walker
 *
 * Tasarım kararları:
 *  • Max depth = 3 — ContextCollector token bütçesi için sığ ağaç yeterli
 *  • Compact flat list yerine iç içe tree — ContextCollector render sırası için
 *  • LevelDB key: `fmeta:{projectId}:{normalizedPath}` → FileMeta JSON
 *    Gerçek ortamda file watcher her kayıtta bu key'i günceller.
 */

// ─── Tree node ─────────────────────────────────────────────────────────────

export interface ProjectStructureItem {
  /** Proje köküne göre göreli path — "/" ayraçlı, öndeki "/" olmadan */
  readonly path: string;
  readonly kind: "file" | "directory";
  /** Yalnızca directory'lerde mevcut — max depth 3'e kadar */
  readonly children?: ReadonlyArray<ProjectStructureItem>;
  /** Dosya boyutu byte — sadece file kind'da */
  readonly sizeBytes?: number;
  /** Son düzenleme zamanı Unix ms — file watcher günceller */
  readonly modifiedAt?: number;
}

// ─── LevelDB FileMeta (stored value) ──────────────────────────────────────

/** LevelDB'de `fmeta:{projectId}:{path}` key'inde saklanan değer */
export interface FileMeta {
  readonly fileId:     string;
  readonly sizeBytes:  number;
  readonly modifiedAt: number;
  /** Dosya watcher tarafından silinmiş mi — soft delete */
  readonly deleted?:   boolean;
}

// ─── IProjectStructureReader ───────────────────────────────────────────────

export interface IProjectStructureReader {
  /**
   * Proje kök dizininin compact ağaç yapısını döner (max depth 3).
   * Silinmiş dosyalar (`FileMeta.deleted = true`) dahil edilmez.
   * ContextCollector bu çıktıyı `structure` tipinde ContextItem olarak ekler.
   */
  getProjectStructure(projectId: string): Promise<ReadonlyArray<ProjectStructureItem>>;
}

// ─── Constants ────────────────────────────────────────────────────────────

export const MAX_STRUCTURE_DEPTH    = 3;
export const MAX_STRUCTURE_FILES    = 256; // Token bütçesi için üst limit
export const FMETA_KEY_PREFIX       = "fmeta:";

/** LevelDB key üret: `fmeta:{projectId}:{path}` */
export function fmetaKey(projectId: string, path: string): string {
  return `${FMETA_KEY_PREFIX}${projectId}:${path}`;
}

/** fmeta key'inden projectId prefix'ini soy */
export function parseFmetaKey(
  key: string,
  projectId: string,
): string | null {
  const prefix = `${FMETA_KEY_PREFIX}${projectId}:`;
  if (!key.startsWith(prefix)) return null;
  return key.slice(prefix.length);
}
