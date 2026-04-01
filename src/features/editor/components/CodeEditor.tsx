// components/CodeEditor.tsx
import React, { useRef, useImperativeHandle, forwardRef } from 'react';
import { View, TextInput, StyleSheet, Platform } from 'react-native';
import { EditorMode, EditorTheme } from '@/features/editor/domain/editor.logic';

export interface CodeEditorRef {
  focus: () => void;
  blur: () => void;
  clear: () => void;
}

interface CodeEditorProps {
  content: string;
  language: string;
  theme: EditorTheme;
  mode: EditorMode;
  onChange: (content: string) => void;
  readOnly: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  autoFocus?: boolean;
}

const themeStyles = {
  [EditorTheme.LIGHT]: {
    backgroundColor: '#ffffff',
    textColor: '#000000',
    placeholderColor: '#999999',
    caretColor: '#000000',
  },
  [EditorTheme.DARK]: {
    backgroundColor: '#1e1e1e',
    textColor: '#d4d4d4',
    placeholderColor: '#6e6e6e',
    caretColor: '#d4d4d4',
  },
  [EditorTheme.HIGH_CONTRAST]: {
    backgroundColor: '#000000',
    textColor: '#ffffff',
    placeholderColor: '#888888',
    caretColor: '#ffffff',
  },
};

export const CodeEditor = forwardRef<CodeEditorRef, CodeEditorProps>(
  (
    {
      content,
      language,
      theme,
      mode,
      onChange,
      readOnly,
      onFocus,
      onBlur,
      autoFocus = false,
    },
    ref
  ) => {
    const inputRef = useRef<TextInput>(null);
    const colors = themeStyles[theme];

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      blur: () => inputRef.current?.blur(),
      clear: () => {
        if (inputRef.current) {
          inputRef.current.clear();
        }
      },
    }));

    const isReadOnly = readOnly || mode === EditorMode.READONLY;

    return (
      <View style={[styles.container, { backgroundColor: colors.backgroundColor }]}>
        <TextInput
          ref={inputRef}
          style={[
            styles.editor,
            {
              color: colors.textColor,
              backgroundColor: colors.backgroundColor,
            },
          ]}
          value={content}
          onChangeText={onChange}
          editable={!isReadOnly}
          multiline
          onFocus={onFocus}
          onBlur={onBlur}
          autoFocus={autoFocus}
          placeholder="Start typing..."
          placeholderTextColor={colors.placeholderColor}
          selectionColor={colors.caretColor}
          textAlignVertical="top"
          scrollEnabled={true}
          keyboardType="default"
          returnKeyType="default"
          blurOnSubmit={false}
          contextMenuHidden={false}
        />
      </View>
    );
  }
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  editor: {
    flex: 1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 14,
    lineHeight: 20,
    padding: 16,
    paddingTop: 16,
    paddingBottom: 16,
    textAlignVertical: 'top',
    includeFontPadding: false,
  },
});

CodeEditor.displayName = 'CodeEditor';
