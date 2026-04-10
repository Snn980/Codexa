const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

config.resolver.sourceExts.push('mjs');

// ─── Expo Go Native Module Mock'ları ─────────────────────────────────────────
const MOCK_DIR = path.resolve(__dirname, 'src/mocks');

config.resolver.extraNodeModules = {
  'react-native-permissions':    path.join(MOCK_DIR, 'react-native-permissions.ts'),
  'react-native-mmkv':           path.join(MOCK_DIR, 'react-native-mmkv.ts'),
  'react-native-nitro-modules':  path.join(MOCK_DIR, 'react-native-nitro-modules.ts'),
  '@react-native-ai/mlc':        path.join(MOCK_DIR, 'react-native-ai-mlc.ts'),
};

module.exports = config;
