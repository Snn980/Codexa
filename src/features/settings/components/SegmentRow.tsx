

import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { styles } from "../styles";

export const SegmentRow = ({ label, options, value, onChange }: any) => ( <View style={styles.segmentRow}> <Text style={styles.rowLabel}>{label}</Text> <View style={styles.segmentControl}> {options.map((opt: any) => ( <TouchableOpacity key={opt.value} style={[styles.segmentOption, opt.value === value && styles.segmentOptionActive]} onPress={() => onChange(opt.value)}> <Text style={[styles.segmentText, opt.value === value && styles.segmentTextActive]}> {opt.label} </Text> </TouchableOpacity> ))} </View> </View> );
