// components/ToolBar.tsx
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { EditorMode, EditorTheme } from '@/features/editor/domain/editor.logic';

interface ToolbarProps {
  mode: EditorMode;
  theme: EditorTheme;
  canUndo: boolean;
  canRedo: boolean;
  isModified: boolean;
  onModeChange: (mode: EditorMode) => void;
  onThemeChange: (theme: EditorTheme) => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onNewFile: () => void;
}

export const ToolBar: React.FC<ToolbarProps> = ({
  mode,
  theme,
  canUndo,
  canRedo,
  isModified,
  onModeChange,
  onThemeChange,
  onSave,
  onUndo,
  onRedo,
  onNewFile,
}) => {
  return (
    <View style={styles.container}>
      <View style={styles.group}>
        <TouchableOpacity style={styles.button} onPress={onNewFile}>
          <Text style={styles.buttonText}>New</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, !isModified && styles.disabled]}
          onPress={onSave}
          disabled={!isModified}
        >
          <Text style={styles.buttonText}>Save</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.group}>
        <TouchableOpacity style={[styles.button, !canUndo && styles.disabled]} onPress={onUndo} disabled={!canUndo}>
          <Text style={styles.buttonText}>Undo</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.button, !canRedo && styles.disabled]} onPress={onRedo} disabled={!canRedo}>
          <Text style={styles.buttonText}>Redo</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.group}>
        {Object.values(EditorMode).map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.button, mode === m && styles.active]}
            onPress={() => onModeChange(m)}
          >
            <Text style={styles.buttonText}>{m}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.group}>
        {Object.values(EditorTheme).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.button, theme === t && styles.active]}
            onPress={() => onThemeChange(t)}
          >
            <Text style={styles.buttonText}>{t}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#2d2d30',
    borderBottomWidth: 1,
    borderBottomColor: '#3e3e42',
    gap: 16,
  },
  group: {
    flexDirection: 'row',
    gap: 4,
  },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    backgroundColor: '#0e639c',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '500',
  },
  active: {
    backgroundColor: '#007acc',
  },
  disabled: {
    opacity: 0.5,
  },
});
