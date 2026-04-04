import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useSettingsStyles } from '../styles';

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
  const s = useSettingsStyles();
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <View style={s.stepper}>
        <TouchableOpacity
          style={s.stepBtn}
          disabled={value <= min}
          onPress={() => { if (value - step >= min) onChange(parseFloat((value - step).toFixed(2))); }}
        >
          <Text style={[s.stepBtnText, value <= min && s.stepBtnDisabled]}>−</Text>
        </TouchableOpacity>
        <Text style={s.stepValue}>{format(value)}</Text>
        <TouchableOpacity
          style={s.stepBtn}
          disabled={value >= max}
          onPress={() => { if (value + step <= max) onChange(parseFloat((value + step).toFixed(2))); }}
        >
          <Text style={[s.stepBtnText, value >= max && s.stepBtnDisabled]}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
