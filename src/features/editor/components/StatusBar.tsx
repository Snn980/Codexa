// components/StatusBar.tsx
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { EditorMode, EditorTheme } from '@/features/editor/domain/editor.logic';

interface StatusBarProps {
  fileName: string;
  lineCount: number;
  isModified: boolean;
  mode: EditorMode;
  theme: EditorTheme;
}

export const StatusBar: React.FC<StatusBarProps> = ({ fileName, lineCount, isModified, mode, theme }) => {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>
        {fileName} | Lines: {lineCount} | Modified: {isModified ? 'Yes' : 'No'} | Mode: {mode} | Theme: {theme}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 4,
    backgroundColor: '#007acc',
  },
  text: {
    color: '#ffffff',
    fontSize: 11,
  },
});
