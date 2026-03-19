/**
 * @file  index.ts
 * @desc  React Native / Expo uygulama giriş noktası.
 *        Metro bundler "main" field'ından buraya gelir.
 *        Public API barrel → src/index.ts  (@/index alias)
 */
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
