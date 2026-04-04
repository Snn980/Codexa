import React from 'react';
import { View, Text } from 'react-native';
import { useSettingsStyles } from '../styles';

export function InfoRow({ label, value }: { label: string; value: string }) {
  const s = useSettingsStyles();
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.infoValue}>{value}</Text>
    </View>
  );
}
