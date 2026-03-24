/**
 * metro.config.js — Worker thread bundle yapılandırması (llama.rn native)
 *
 * SDK 55 / Metro 0.82
 *
 * Worker dosyaları src/workers/ altındadır (proje kökünde değil).
 * __dirname = proje kökü (package.json ile aynı dizin)
 * Doğru path: src/workers/ai.offline.worker.ts
 */

const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// ─── Worker entry points ─────────────────────────────────────────────────────

/**
 * Gerçek dosya konumu: src/workers/
 *
 * Proje yapısı:
 *   project-root/
 *     metro.config.js           ← bu dosya
 *     src/
 *       workers/
 *         ai.offline.worker.ts  ← ✅
 *         ai.cloud.worker.ts    ← ✅
 *     assets/
 *       llama.wasm
 *
 * Metro 0.82 workerEntries: her entry → ayrı .worker.bundle
 */
config.resolver = {
  ...config.resolver,
  workerEntries: [
    path.resolve(__dirname, "src/workers/ai.offline.worker.ts"),
    path.resolve(__dirname, "src/workers/ai.cloud.worker.ts"),
  ],
};

// ─── Binary asset uzantıları ─────────────────────────────────────────────────
// llama.rn native — WASM kaldırıldı, GGUF model asset desteği korundu

config.resolver.assetExts = [
  ...config.resolver.assetExts,
  "gguf",   // GGUF model dosyaları (llama.rn)
  "bin",    // Tokenizer ve yardımcı binary dosyalar
];

// ─── Source extensions ───────────────────────────────────────────────────────

config.resolver.sourceExts = [
  ...config.resolver.sourceExts,
  // "cjs" kaldırıldı — llama-cpp-wasm CJS glue artık gerekli değil
];

// ─── FIX: expo-modules-core/workers modülünü çözümle ───────────────────────

config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  'expo-modules-core/workers': path.resolve(__dirname, 'node_modules/expo-modules-core'),
};

// ─── Hızlı çözüm için Metro cache'i temizle ─────────────────────────────────
config.cacheStores = [];

module.exports = config;
