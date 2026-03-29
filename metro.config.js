const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.sourceExts.push('mjs');
config.resolver.extraNodeModules = {
  'react-native-permissions': require.resolve('./src/mocks/react-native-permissions.ts'),
};

module.exports = config;
