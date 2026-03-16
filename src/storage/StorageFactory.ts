/**
 * src/storage/StorageFactory.ts
 *
 * Geriye dönük uyumluluk köprüsü.
 * Platform'a göre OPFS (web worker) veya ExpoModelStorage (native) döner.
 *
 * Canonical: createModelStorage() → ExpoModelStorage.ts
 * § 22 : AppContainer init sırası — step 3: createModelStorage
 */
export { createModelStorage } from './ExpoModelStorage';
export type { IStorageInfo }  from '../download/ModelDownloadManager';
