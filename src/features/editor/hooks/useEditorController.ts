import { useCallback, useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useAppContext } from '@/app/AppContext';
import { useEditorStore } from '../stores/editor.store';
import {
  shouldAutoSave,
  validateFileSave,
  AUTO_SAVE_INTERVAL,
  type EditorTab,
} from '../domain/editor.logic';

export function useEditorController() {
  const { services } = useAppContext();
  const { fileService, eventBus } = services;
  const store = useEditorStore();

  const stateRef = useRef(store);
  useEffect(() => { stateRef.current = store; });

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      historyTimeoutRef.current.forEach(t => clearTimeout(t));
      historyTimeoutRef.current.clear();
    };
  }, []);

  const updateContent = useCallback((tabId: string, content: string) => {
    store.updateContent(tabId, content);
    const existing = historyTimeoutRef.current.get(tabId);
    if (existing) clearTimeout(existing);
    const timeout = setTimeout(() => {
      store.pushHistory(tabId, content);
      historyTimeoutRef.current.delete(tabId);
    }, 500);
    historyTimeoutRef.current.set(tabId, timeout);
    const tab = stateRef.current.tabs.find((t: EditorTab) => t.id === tabId);
    if (!tab) return;
    if (shouldAutoSave({ lastSaved: tab.lastSaved ?? 0, now: Date.now(), interval: AUTO_SAVE_INTERVAL })) {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(async () => {
        const latest = stateRef.current.tabs.find((t: EditorTab) => t.id === tabId);
        if (!latest) return;
        const v = validateFileSave(latest.content);
        if (!v.isValid) { Alert.alert('Kayit Hatasi', v.errors.join('\n')); return; }
        const r = await fileService.onContentChange(latest.id as any, latest.content);
        if (r.ok) store.markClean(tabId);
        saveTimeoutRef.current = null;
      }, 1000);
    }
  }, [store, fileService]);

  const saveTab = useCallback(async (tabId?: string) => {
    const id = tabId ?? stateRef.current.activeTabId;
    const tab = stateRef.current.tabs.find((t: EditorTab) => t.id === id);
    if (!tab) return;
    if (saveTimeoutRef.current) { clearTimeout(saveTimeoutRef.current); saveTimeoutRef.current = null; }
    const v = validateFileSave(tab.content);
    if (!v.isValid) { Alert.alert('Kayit Hatasi', v.errors.join('\n')); return; }
    const r = await fileService.saveFile(tab.id as any, tab.content);
    if (r.ok) {
      store.markClean(tab.id);
      eventBus.emit('file:saved', { file: { id: tab.id } as any });
    } else {
      Alert.alert('Kayit Hatasi', r.error.message);
    }
  }, [store, fileService, eventBus]);

  const saveAll = useCallback(async () => {
    const dirty = stateRef.current.tabs.filter((t: EditorTab) => t.isModified);
    await Promise.all(dirty.map((t: EditorTab) => saveTab(t.id)));
  }, [saveTab]);

  const selectTab = useCallback(async (tabId: string) => {
    const current = stateRef.current.activeTab();
    if (current?.isModified) await saveTab(current.id);
    store.setActive(tabId);
  }, [store, saveTab]);

  const closeTab = useCallback(async (tabId: string) => {
    const tab = stateRef.current.tabs.find((t: EditorTab) => t.id === tabId);
    if (!tab) return;
    if (tab.isModified) {
      await new Promise<void>((resolve) => {
        Alert.alert('Kaydedilmemis', tab.filePath, [
          { text: 'Iptal', style: 'cancel', onPress: () => resolve() },
          { text: 'Kaydetme', style: 'destructive', onPress: () => { store.closeTab(tabId); resolve(); } },
          { text: 'Kaydet', onPress: async () => { await saveTab(tabId); store.closeTab(tabId); resolve(); } },
        ]);
      });
    } else {
      store.closeTab(tabId);
    }
  }, [store, saveTab]);

  const openFile = useCallback(async (fileId: string) => {
    const existing = stateRef.current.tabs.find((t: EditorTab) => t.id === fileId);
    if (existing) { store.setActive(existing.id); return; }
    const r = await fileService.getFile(fileId as any);
    if (!r.ok) { Alert.alert('Hata', r.error.message); return; }
    const file = r.data;
    store.openTab({ id: file.id, path: file.path, content: file.content });
  },
  [store, fileService]);

  return {
    tabs: store.tabs,
    activeTabId: store.activeTabId,
    activeTab: store.activeTab(),
    mode: store.mode,
    theme: store.theme,
    canUndo: store.canUndo(store.activeTabId),
    canRedo: store.canRedo(store.activeTabId),
    openFile,
    selectTab,
    closeTab,
    updateContent,
    saveTab,
    saveAll,
    undo: () => store.undo(),
    redo: () => store.redo(),
    setMode: store.setMode,
    setTheme: store.setTheme,
  };
}
