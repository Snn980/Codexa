import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useSettingsStyles } from '../styles';

interface SegmentOption { label: string; value: string; }
interface SegmentRowProps {
  label:    string;
  options:  SegmentOption[];
  value:    string;
  onChange: (v: string) => void;
}

export function SegmentRow({ label, options, value, onChange }: SegmentRowProps) {
  const s = useSettingsStyles();
  return (
    <View style={s.segmentRow}>
      <Text style={s.rowLabel}>{label}</Text>
      <View style={s.segmentControl}>
        {options.map((opt) => (
          <TouchableOpacity
            key={opt.value}
            style={[s.segmentOption, opt.value === value && s.segmentOptionActive]}
            onPress={() => onChange(opt.value)}
          >
            <Text style={[s.segmentText, opt.value === value && s.segmentTextActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}
