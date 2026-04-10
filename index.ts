/**
 * @file  index.ts
 * @desc  React Native / Expo uygulama giriş noktası.
 *        Metro bundler "main" field'ından buraya gelir.
 *        Public API barrel → src/index.ts  (@/index alias)
 */
// React Native'de window.location yoktur, HMR için patch
if (typeof window !== 'undefined' && !window.location) {
  (window as any).location = {
    reload: () => {
      const { DevSettings } = require('react-native');
      DevSettings?.reload?.();
    },
  };
}

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
