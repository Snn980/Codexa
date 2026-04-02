import React from "react";
import { View, Text, Switch } from "react-native";
import { styles, COLORS } from "../styles";

interface ToggleRowProps {
  label:    string;
  desc?:    string;
  value:    boolean;
  onChange: (v: boolean) => void;
}

export function ToggleRow({ label, desc, value, onChange }: ToggleRowProps) {
  return (
    <View style={styles.row}>
      <View style={styles.rowLeft}>
        <Text style={styles.rowLabel}>{label}</Text>
        {desc && <Text style={styles.rowDesc}>{desc}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: COLORS.accent, false: COLORS.border }}
        thumbColor={value ? "#fff" : COLORS.muted}
      />
    </View>
  );
}
