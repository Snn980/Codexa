/**
 * metro.config.js — Worker thread bundle yapılandırması
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

// ─── WASM + binary asset uzantıları ──────────────────────────────────────────

config.resolver.assetExts = [
  ...config.resolver.assetExts,
  "wasm",   // llama.wasm + tree-sitter WASM
  "gguf",   // opsiyonel: küçük test modeli
];

// ─── Source extensions ───────────────────────────────────────────────────────

config.resolver.sourceExts = [
  ...config.resolver.sourceExts,
  "cjs",    // llama-cpp-wasm CommonJS glue
];

module.exports = config;
