// hooks/useEditorShortcuts.ts
import { useEffect } from 'react';
import { Platform } from 'react-native';

interface ShortcutsProps {
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  enabled?: boolean;
}

export function useEditorShortcuts({ 
  onSave, 
  onUndo, 
  onRedo, 
  enabled = true 
}: ShortcutsProps) {
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web') return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const isModifierPressed = event.metaKey || event.ctrlKey;
      
      // Save: Cmd/Ctrl + S
      if (isModifierPressed && event.key === 's') {
        event.preventDefault();
        onSave();
      }
      
      // Undo: Cmd/Ctrl + Z
      else if (isModifierPressed && event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        onUndo();
      }
      
      // Redo: Cmd/Ctrl + Shift + Z
      else if (isModifierPressed && event.key === 'z' && event.shiftKey) {
        event.preventDefault();
        onRedo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSave, onUndo, onRedo, enabled]);
}