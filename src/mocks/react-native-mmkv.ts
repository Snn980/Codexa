/**
 * react-native-mmkv — Expo Go mock
 * MMKV API'sini in-memory Map ile simüle eder.
 * Native build'de gerçek MMKV kullanılır.
 */

class MMKVMock {
  private _store = new Map<string, string>();

  getString(key: string): string | undefined {
    return this._store.get(key);
  }

  set(key: string, value: string): void {
    this._store.set(key, value);
  }

  delete(key: string): void {
    this._store.delete(key);
  }

  remove(key: string): void {
    this._store.delete(key);
  }

  getAllKeys(): string[] {
    return Array.from(this._store.keys());
  }

  clearAll(): void {
    this._store.clear();
  }
}

export const MMKV = MMKVMock;
export default { MMKV: MMKVMock };
