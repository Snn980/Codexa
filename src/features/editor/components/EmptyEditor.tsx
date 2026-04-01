// components/EmptyEditor.tsx
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

interface EmptyEditorProps {
  onCreateNew: () => void;
}

export const EmptyEditor: React.FC<EmptyEditorProps> = ({ onCreateNew }) => {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>No files open</Text>
      <TouchableOpacity style={styles.button} onPress={onCreateNew}>
        <Text style={styles.buttonText}>Create New File</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1e1e1e',
  },
  title: {
    fontSize: 18,
    color: '#cccccc',
    marginBottom: 20,
  },
  button: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: '#0e639c',
    borderRadius: 4,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '500',
  },
});