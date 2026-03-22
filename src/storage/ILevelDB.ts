/**
 * storage/ILevelDB.ts
 * LevelDB arayüzü — SymbolIndex hot-path cache katmanı için.
 */

export interface ILevelDB {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  batch(ops: Array<{ type: "put" | "del"; key: string; value?: string }>): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  close(): Promise<void>;
}
