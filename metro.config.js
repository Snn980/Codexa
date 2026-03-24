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

// ÇÖZÜM: expo-modules-core/workers modülünü ana modüle yönlendir
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'expo-modules-core/workers') {
    return {
      filePath: path.resolve(__dirname, 'node_modules/expo-modules-core'),
      type: 'sourceFile',
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
