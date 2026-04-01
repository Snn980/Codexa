
 import React from "react"; import { View, Text, TouchableOpacity } from "react-native"; import { styles } from "../styles";

export const StepperRow = ({ label, value, min, max, step, format, onChange }: any) => ( <View style={styles.row}> <Text style={styles.rowLabel}>{label}</Text> <View style={styles.stepper}> <TouchableOpacity disabled={value <= min} onPress={() => onChange(value - step)} style={styles.stepBtn}> <Text style={styles.stepBtnText}>−</Text> </TouchableOpacity> <Text style={styles.stepValue}>{format(value)}</Text> <TouchableOpacity disabled={value >= max} onPress={() => onChange(value + step)} style={styles.stepBtn}> <Text style={styles.stepBtnText}>+</Text> </TouchableOpacity> </View> </View> );
