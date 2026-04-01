/**
 * src/screens/SettingsScreen.tsx
 *
 * § 71 — RootNavigator TS uyumu: container prop kabul eden wrapper.
 *
 * RootNavigator: <SettingsScreen container={container} />
 * app/screens/SettingsScreen.tsx: container prop almıyor (useAppContext kullanıyor).
 *
 * Çözüm: container optional prop olarak tanımlanır; bileşen onu ignore eder.
 * useAppContext() zaten App.tsx'teki AppContext'ten servisleri alıyor.
 */
import React from 'react';
import type { AppContainer } from '../app/AppContainer';
import { SettingsScreen as SettingsScreenImpl } from '../features/settings/screens/SettingsScreen';

// § 71 — RootNavigator container prop'u geçirebilsin
export interface SettingsScreenProps {
  container?: AppContainer;
}

export function SettingsScreen(_props: SettingsScreenProps): React.ReactElement {
  return <SettingsScreenImpl />;
}
