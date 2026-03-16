// babel.config.js
// Expo SDK 55 / React Native 0.83 için Babel yapılandırması
//
// Modül sistemi: Expo SDK 55'te "async requires" varsayılan olarak etkin.
// metro-react-native-babel-preset otomatik olarak bu özelliği aktifleştirir.
//
// react-native-mmkv V4, react-native-nitro-modules için
// NativeWind veya Reanimated eklenirse bu dosyaya plugin eklenmeli.

'use strict';

module.exports = function (api) {
  api.cache(true);

  return {
    presets: ['babel-preset-expo'],

    plugins: [
      // @/ path aliasları (tsconfig.json'daki paths ile eşleşmeli)
      [
        'module-resolver',
        {
          root: ['./src'],
          extensions: ['.ios.js', '.android.js', '.js', '.ts', '.tsx', '.json'],
          alias: {
            '@': './src',
          },
        },
      ],
    ],
  };
};
