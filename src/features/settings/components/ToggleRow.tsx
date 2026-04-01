 import React from "react"; import { View, Text, Switch } from "react-native"; import { styles, COLORS } from "../styles";

export const ToggleRow = ({ label, desc, value, onChange }: any) => ( <View style={styles.row}> <View style={styles.rowLeft}> <Text style={styles.rowLabel}>{label}</Text> {desc && <Text style={styles.rowDesc}>{desc}</Text>} </View> <Switch value={value} onValueChange={onChange} trackColor={{ true: COLORS.accent, false: COLORS.border }} thumbColor={value ? "#fff" : COLORS.muted} /> </View> );
