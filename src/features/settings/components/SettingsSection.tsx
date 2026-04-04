import React from 'react';
import { View, Text } from 'react-native';
import { useSettingsStyles } from '../styles';

export function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  const s = useSettingsStyles();
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      <View style={s.sectionCard}>{children}</View>
    </View>
  );
}
