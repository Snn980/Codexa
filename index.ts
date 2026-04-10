/**
 * @file  index.ts
 * @desc  React Native / Expo uygulama giriş noktası.
 *        Metro bundler "main" field'ından buraya gelir.
 */

// React Native'de window.location yoktur.
// Bazı kütüphaneler HMR sırasında window.location.reload() çağırır.
// Bu polyfill o crash'i önler.
if (typeof window !== 'undefined' && !window.location) {
  (window as any).location = {
    reload: () => {
      try {
        const { DevSettings } = require('react-native');
        DevSettings?.reload?.();
      } catch (_) {}
    },
  };
}

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
