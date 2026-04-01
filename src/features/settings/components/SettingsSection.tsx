
 import React from "react"; import { View, Text } from "react-native"; import { styles } from "../styles";


export const SettingsSection = ({ title, children }: any) => ( <View style={styles.section}> <Text style={styles.sectionTitle}>{title}</Text> <View style={styles.sectionCard}>{children}</View> </View> );
