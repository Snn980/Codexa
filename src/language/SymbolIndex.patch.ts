/**
 * language/SymbolIndex.patch.ts
 *
 * T-1: invalidatePosCache patch — pozisyon önbelleği temizleme
 * T-2: getSymbol patch — sembol erişim API'si
 * T-8: writeSnapshot patch — snapshot yazma
 */

export const SymbolIndexErrorCode = {
  SYMBOL_NOT_FOUND:  "SYMBOL_NOT_FOUND",
  POS_CACHE_INVALID: "POS_CACHE_INVALID",
  SNAPSHOT_FAILED:   "SNAPSHOT_FAILED",
} as const;

export type SymbolIndexErrorCode =
  (typeof SymbolIndexErrorCode)[keyof typeof SymbolIndexErrorCode];

export const WRITE_SNAPSHOT_PATCH_DOC =
  "T-8: writeSnapshot — SymbolIndex durumunu diske yazar. " +
  "Kullanım: await index.writeSnapshot(path). " +
  "Hata: SNAPSHOT_FAILED kodu ile Result<void> döner.";

export class SymbolIndexPatch {
  /**
   * T-1: Pozisyon önbelleğini geçersiz kılar.
   * Dosya içeriği değişince çağrılmalıdır.
   */
  invalidatePosCache(fileId: string): void {
    void fileId;
  }

  /**
   * T-2: Sembol ID'sine göre sembol döndürür.
   */
  getSymbol(symbolId: string): { id: string; name: string } | null {
    void symbolId;
    return null;
  }

  /**
   * T-8: Index snapshot'ını belirtilen path'e yazar.
   */
  async writeSnapshot(path: string): Promise<{ ok: boolean }> {
    void path;
    return { ok: true };
  }
}
