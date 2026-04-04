const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

config.resolver.sourceExts.push('mjs');

// ─── Expo Go Native Module Mock'ları ─────────────────────────────────────────
//
// Bu modüller native binary gerektirir; Expo Go'da çalışmaz.
// Mock'lar src/mocks/ altında tutulur.
// Production APK build'de bu satırlar etkisiz (gerçek native modüller yüklenir).
//
// Eklenen mock'lar:
//   react-native-mmkv          → in-memory Map implementasyonu
//   react-native-nitro-modules → no-op stub
//   @react-native-ai/mlc       → cloud-only uyarısı fırlatır
//   react-native-permissions   → zaten vardı, korundu

const MOCK_DIR = path.resolve(__dirname, 'src/mocks');

config.resolver.extraNodeModules = {
  'react-native-permissions':    path.join(MOCK_DIR, 'react-native-permissions.ts'),
  'react-native-mmkv':           path.join(MOCK_DIR, 'react-native-mmkv.ts'),
  'react-native-nitro-modules':  path.join(MOCK_DIR, 'react-native-nitro-modules.ts'),
  '@react-native-ai/mlc':        path.join(MOCK_DIR, 'react-native-ai-mlc.ts'),
};

module.exports = config;
