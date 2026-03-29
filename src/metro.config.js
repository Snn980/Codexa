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

// ─── Expo Go mock'ları — native modüller Expo Go'da çalışmaz ─────────────────
// Native APK build'de bu satırlar devre dışı bırakılır (EXPO_GO=false)
if (process.env.EXPO_GO !== 'false') {
  config.resolver.extraNodeModules = {
    ...config.resolver.extraNodeModules,
    'react-native-mmkv': path.resolve(__dirname, 'src/mocks/react-native-mmkv.ts'),
    'react-native-nitro-modules': path.resolve(__dirname, 'src/mocks/react-native-nitro-modules.ts'),
    '@react-native-ai/mlc': path.resolve(__dirname, 'src/mocks/react-native-ai-mlc.ts'),
  };
}

module.exports = config;
