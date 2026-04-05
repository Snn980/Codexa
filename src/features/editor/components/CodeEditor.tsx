/**
 * features/editor/components/CodeEditor.tsx
 *
 * Gezinme tuşu fix:
 *   setNativeProps({ selection }) Android'de TextInput focus dışındayken
 *   çalışmıyor. Çözüm: controlled `selection` state.
 *   moveCursor → setControlledSel → TextInput selection prop güncellenir
 *   → 1 frame sonra uncontrolled'a döner (kullanıcı kendi yazabilsin)
 */

import React, {
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from 'react';
import { View, TextInput, StyleSheet, Platform } from 'react-native';
import { EditorMode } from '@/features/editor/domain/editor.logic';
import { useTheme }   from '@/theme';

// ─── Ref API ─────────────────────────────────────────────────────────────────

export interface CodeEditorRef {
  focus:          () => void;
  blur:           () => void;
  clear:          () => void;
  insertAtCursor: (text: string) => void;
  moveCursor:     (dir: 'left' | 'right' | 'up' | 'down') => void;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface CodeEditorProps {
  content:    string;
  language:   string;
  mode:       EditorMode;
  onChange:   (content: string) => void;
  readOnly:   boolean;
  fontSize?:  number;
  onFocus?:   () => void;
  onBlur?:    () => void;
  autoFocus?: boolean;
  theme?:     unknown; // backward compat
}

// ─── Yardımcı: cursor pozisyonu hesapla ──────────────────────────────────────

function calcMovedPos(
  content: string,
  pos: number,
  dir: 'left' | 'right' | 'up' | 'down',
): number {
  if (dir === 'left')  return Math.max(0, pos - 1);
  if (dir === 'right') return Math.min(content.length, pos + 1);

  // Mevcut satırda kolon hesapla
  const lineStart = content.lastIndexOf('\n', pos - 1) + 1;
  const col       = pos - lineStart;

  if (dir === 'up') {
    const prevEnd = lineStart - 1;
    if (prevEnd < 0) return 0;
    const prevStart = content.lastIndexOf('\n', prevEnd - 1) + 1;
    return prevStart + Math.min(col, prevEnd - prevStart);
  }

  // down
  const nextStart = content.indexOf('\n', pos);
  if (nextStart === -1) return content.length;
  const afterNext = content.indexOf('\n', nextStart + 1);
  const nextLen   = afterNext === -1
    ? content.length - (nextStart + 1)
    : afterNext - (nextStart + 1);
  return (nextStart + 1) + Math.min(col, nextLen);
}

// ─── CodeEditor ───────────────────────────────────────────────────────────────

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

export const CodeEditor = forwardRef<CodeEditorRef, CodeEditorProps>(
  (
    {
      content,
      language: _language,
      mode,
      onChange,
      readOnly,
      fontSize = 14,
      onFocus,
      onBlur,
      autoFocus = false,
    },
    ref,
  ) => {
    const inputRef      = useRef<TextInput>(null);
    const { colors }    = useTheme();

    // Anlık cursor pozisyonu — her zaman güncel
    const selectionRef  = useRef({ start: 0, end: 0 });

    // Controlled selection: undefined → TextInput kendi yönetir
    //                       {start,end} → cursor programatik olarak taşınır
    const [controlledSel, setControlledSel] =
      useState<{ start: number; end: number } | undefined>(undefined);

    // ── insertAtCursor ────────────────────────────────────────────────────────
    const insertAtCursor = useCallback((token: string) => {
      const { start, end } = selectionRef.current;
      const next    = content.slice(0, start) + token + content.slice(end);
      const newPos  = start + token.length;

      onChange(next);

      // Controlled sel ile cursor'u doğru konuma getir
      const newSel = { start: newPos, end: newPos };
      setControlledSel(newSel);
      selectionRef.current = newSel;

      // 1 frame sonra uncontrolled'a bırak
      requestAnimationFrame(() => setControlledSel(undefined));
    }, [content, onChange]);

    // ── moveCursor ────────────────────────────────────────────────────────────
    const moveCursor = useCallback((dir: 'left' | 'right' | 'up' | 'down') => {
      const { start } = selectionRef.current;
      const newPos    = calcMovedPos(content, start, dir);
      const newSel    = { start: newPos, end: newPos };

      // 1. Önce focus — klavye tuşuna basınca focus kayabilir
      inputRef.current?.focus();

      // 2. Controlled selection set et
      setControlledSel(newSel);
      selectionRef.current = newSel;

      // 3. 2 frame sonra uncontrolled'a bırak
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setControlledSel(undefined)),
      );
    }, [content]);

    useImperativeHandle(ref, () => ({
      focus:          () => inputRef.current?.focus(),
      blur:           () => inputRef.current?.blur(),
      clear:          () => inputRef.current?.clear(),
      insertAtCursor,
      moveCursor,
    }));

    const isReadOnly = readOnly || mode === EditorMode.READONLY;

    return (
      <View style={[styles.container, { backgroundColor: colors.editor.bg }]}>
        <TextInput
          ref={inputRef}
          style={[
            styles.editor,
            {
              color:           colors.text,
              backgroundColor: colors.editor.bg,
              fontSize,
              lineHeight:      Math.round(fontSize * 1.5),
            },
          ]}
          value={content}
          onChangeText={onChange}
          selection={controlledSel}
          onSelectionChange={(e) => {
            // Sadece uncontrolled modda güncelle
            if (!controlledSel) {
              selectionRef.current = e.nativeEvent.selection;
            }
          }}
          editable={!isReadOnly}
          multiline
          onFocus={onFocus}
          onBlur={onBlur}
          autoFocus={autoFocus}
          placeholder="Yazmaya başlayın…"
          placeholderTextColor={colors.muted}
          selectionColor={colors.editor.cursor}
          textAlignVertical="top"
          scrollEnabled={true}
          keyboardType="default"
          returnKeyType="default"
          blurOnSubmit={false}
          contextMenuHidden={false}
          inputAccessoryViewID="code-keyboard"
        />
      </View>
    );
  },
);

CodeEditor.displayName = 'CodeEditor';

// ─── Stiller ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  editor: {
    flex:               1,
    fontFamily:         MONO,
    padding:            16,
    paddingTop:         16,
    paddingBottom:      80,
    textAlignVertical:  'top',
    includeFontPadding: false,
  },
});
