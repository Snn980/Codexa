/**
 * features/editor/components/CodeEditor.tsx
 *
 * CodeMirror 6 + WebView tabanlı kod editörü.
 *
 * ── Geçiş Notları ─────────────────────────────────────────────────────────
 *  Önceki: React Native TextInput (syntax highlighting yok)
 *  Yeni:   CodeMirrorEditor (WebView + CM6) — tam syntax highlighting
 *
 * ── Dış API DEĞİŞMEDİ ────────────────────────────────────────────────────
 *  CodeEditorRef, CodeEditorProps arayüzleri aynı kalır.
 *  EditorScreen.tsx ve MobileKeyboard entegrasyonu güncelleme gerektirmez.
 *
 * ── Status Bar Entegrasyonu ───────────────────────────────────────────────
 *  CM6, cursor pozisyonunu (satır/kolon) onCursorChange callback'i ile
 *  üst bileşene iletir. EditorScreen'de onCursorChange prop'unu bağlayın.
 *
 * § 8  : forwardRef + useImperativeHandle
 */

import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
} from 'react';
import { EditorMode } from '@/features/editor/domain/editor.logic';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import type { CodeEditorRef as CMRef } from './CodeMirrorEditor';

// ─── Ref API (değişmedi) ─────────────────────────────────────────────────────

export interface CodeEditorRef {
  focus:          () => void;
  blur:           () => void;
  clear:          () => void;
  insertAtCursor: (text: string) => void;
  moveCursor:     (dir: 'left' | 'right' | 'up' | 'down') => void;
}

// ─── Props (değişmedi + onCursorChange eklendi) ───────────────────────────────

interface CodeEditorProps {
  content:          string;
  language:         string;
  mode:             EditorMode;
  onChange:         (content: string) => void;
  readOnly:         boolean;
  fontSize?:        number;
  onFocus?:         () => void;
  onBlur?:          () => void;
  autoFocus?:       boolean;
  theme?:           unknown;   // backward compat — kullanılmıyor
  onCursorChange?:  (line: number, col: number) => void;
}

// ─── CodeEditor ───────────────────────────────────────────────────────────────

export const CodeEditor = forwardRef<CodeEditorRef, CodeEditorProps>(
  (
    {
      content,
      language,
      mode,
      onChange,
      readOnly,
      fontSize = 14,
      onFocus,
      onBlur,
      autoFocus = false,
      onCursorChange,
    },
    ref,
  ) => {
    const cmRef = useRef<CMRef>(null);

    // AutoFocus: CM6 READY olunca focus
    const handleReady = useCallback(() => {
      if (autoFocus) {
        setTimeout(() => cmRef.current?.focus(), 100);
      }
    }, [autoFocus]);

    // CodeEditorRef delegasyonu
    useImperativeHandle(ref, () => ({
      focus:          () => cmRef.current?.focus(),
      blur:           () => cmRef.current?.blur(),
      clear:          () => cmRef.current?.clear(),
      insertAtCursor: (text: string) => cmRef.current?.insertAtCursor(text),
      moveCursor:     (dir) => cmRef.current?.moveCursor(dir),
    }), []);

    const isReadOnly = readOnly || mode === EditorMode.READONLY;

    return (
      <CodeMirrorEditor
        ref={cmRef}
        content={content}
        language={language}
        readOnly={isReadOnly}
        fontSize={fontSize}
        onChange={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
        onCursorChange={onCursorChange}
        onReady={handleReady}
      />
    );
  },
);

CodeEditor.displayName = 'CodeEditor';
