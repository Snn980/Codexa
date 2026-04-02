import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { styles } from "../styles";

interface StepperRowProps {
  label:    string;
  value:    number;
  min:      number;
  max:      number;
  step:     number;
  format:   (v: number) => string;
  onChange: (v: number) => void;
}

export function StepperRow({ label, value, min, max, step, format, onChange }: StepperRowProps) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.stepper}>
        <TouchableOpacity onPress={() => { if (value - step >= min) onChange(parseFloat((value - step).toFixed(2))); }} style={styles.stepBtn} disabled={value <= min}>
          <Text style={styles.stepBtnText}>−</Text>
        </TouchableOpacity>
        <Text style={styles.stepValue}>{format(value)}</Text>
        <TouchableOpacity onPress={() => { if (value + step <= max) onChange(parseFloat((value + step).toFixed(2))); }} style={styles.stepBtn} disabled={value >= max}>
          <Text style={styles.stepBtnText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
