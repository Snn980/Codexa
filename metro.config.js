const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname);

// Worker entries
config.resolver.workerEntries = [
  path.resolve(__dirname, "src/workers/ai.offline.worker.ts"),
  path.resolve(__dirname, "src/workers/ai.cloud.worker.ts"),
];

// Binary assets
config.resolver.assetExts = [
  ...config.resolver.assetExts,
  "gguf",
  "bin",
];

// SHA-1 hatası için watchFolders'a expo-modules-core'u ekle
config.watchFolders = [
  ...(config.watchFolders || []),
  path.resolve(__dirname, "node_modules/expo-modules-core"),
];

module.exports = config;
