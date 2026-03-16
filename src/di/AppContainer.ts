/**
 * src/di/AppContainer.ts
 *
 * Bu dosya canonical AppContainer implementasyonuna yönlendirme yapar.
 * src/navigations/RootNavigator.tsx ve diğer DI consumers buradan import eder.
 *
 * § 4 : AppContainer DI — singleton, idempotent init, ordered dispose
 */

export {
  AppContainer,
  appContainer,
} from '../app/AppContainer';

export type {
  AppContainerOptions,
  IAsyncStorage,
} from '../app/AppContainer';
