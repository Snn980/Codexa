/**
 * ipc/IPathResolver.ts
 * Dosya yolu çözümleme arayüzü — SymbolIndex ve runtime katmanı kullanır.
 */

export interface IPathResolver {
  /** fileId'yi mutlak dosya yoluna çevirir. */
  getPath(fileId: string): string;

  /** Kaynak dosyadan göreli bir belirteci mutlak fileId'ye çözer. */
  resolve(fromFileId: string, specifier: string): Promise<string | null>;
}
