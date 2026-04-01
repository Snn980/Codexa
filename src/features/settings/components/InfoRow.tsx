
import React from "react"; import { View, Text } from "react-native"; import { styles } from "../styles";

export const InfoRow = ({ label, value }: any) => ( <View style={styles.row}> <Text style={styles.rowLabel}>{label}</Text> <Text style={styles.infoValue}>{value}</Text> </View> );
