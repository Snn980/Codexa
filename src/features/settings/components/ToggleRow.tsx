import React from 'react';
import { View, Text, Switch } from 'react-native';
import { useSettingsStyles } from '../styles';

interface ToggleRowProps {
  label:    string;
  desc?:    string;
  value:    boolean;
  onChange: (v: boolean) => void;
}

export function ToggleRow({ label, desc, value, onChange }: ToggleRowProps) {
  const s = useSettingsStyles();
  return (
    <View style={s.row}>
      <View style={s.rowLeft}>
        <Text style={s.rowLabel}>{label}</Text>
        {desc && <Text style={s.rowDesc}>{desc}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: s.switchTrackTrue, false: s.switchTrackFalse }}
        thumbColor={value ? s.switchThumbTrue : s.switchThumbFalse}
      />
    </View>
  );
}
