/**
 * features/editor/hooks/useEditorController.ts
 *
 * Editor iş mantığı:
 *   - Dosya aç / kapat / kaydet / otomatik kaydet
 *   - Geri al / İleri al
 *   - Proje yönetimi (proje listesi, dosya listesi, yeni dosya/proje)
 *   - project:opened event → dosyaları yükle
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform }   from 'react-native';
import { useAppContext }      from '@/app/AppContext';
import { useEditorStore }     from '../stores/editor.store';
import {
  shouldAutoSave, validateFileSave,
  AUTO_SAVE_INTERVAL, type EditorTab,
} from '../domain/editor.logic';
import type { IProject, IFile } from '@/types/core';
import {
  ProjectLanguage, ProjectStatus, FileType,
} from '@/types/core';

export function useEditorController() {
  const { services }                   = useAppContext();
  const { fileService, projectService, eventBus } = services;
  const store                          = useEditorStore();

  const stateRef          = useRef(store);
  const saveTimeoutRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Aktif proje
  const [activeProject, setActiveProject] = useState<IProject | null>(null);
  const [projectFiles,  setProjectFiles]  = useState<IFile[]>([]);
  const [projects,      setProjects]      = useState<IProject[]>([]);

  useEffect(() => { stateRef.current = store; });

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      historyTimeoutRef.current.forEach(t => clearTimeout(t));
      historyTimeoutRef.current.clear();
    };
  }, []);

  // ── Proje listesini yükle ──────────────────────────────────────────────────
  const loadProjects = useCallback(async () => {
    const r = await projectService.getAllProjects();
    if (r.ok) setProjects(r.data.filter(p => p.status !== ProjectStatus.PendingGC));
  }, [projectService]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  // ── Proje aç ──────────────────────────────────────────────────────────────
  const openProject = useCallback(async (project: IProject) => {
    setActiveProject(project);
    const r = await fileService.getProjectFiles(project.id as any);
    if (!r.ok) { Alert.alert('Hata', r.error.message); return; }
    const files = r.data;
    setProjectFiles(files);
    // Zaten açık tab'ları koru, yenileri ekle
    const currentIds = new Set(stateRef.current.tabs.map((t: EditorTab) => t.id));
    let firstNew: IFile | null = null;
    for (const file of files) {
      if (!currentIds.has(file.id)) {
        store.openTab({ id: file.id, path: file.path, content: file.content });
        if (!firstNew) firstNew = file;
      }
    }
    if (firstNew) store.setActive(firstNew.id);
    else if (files[0]) store.setActive(files[0].id);
  }, [fileService, store]);

  // ── project:opened event ───────────────────────────────────────────────────
  useEffect(() => {
    const unsub = eventBus.on('project:opened', async ({ project }: { project: IProject }) => {
      await openProject(project);
    });
    return unsub;
  }, [eventBus, openProject]);

  // ── Yeni proje ────────────────────────────────────────────────────────────
  const newProject = useCallback(async (name: string, language = ProjectLanguage.TypeScript) => {
    const r = await projectService.createProject({
      name: name.trim(),
      language,
      description: '',
      meta: { pinned: false },
    } as any);
    if (!r.ok) { Alert.alert('Hata', r.error.message); return null; }
    await loadProjects();
    await openProject(r.data);
    return r.data;
  }, [projectService, loadProjects, openProject]);

  // ── Yeni dosya ────────────────────────────────────────────────────────────
  const newFile = useCallback(async (name: string) => {
    if (!activeProject) { Alert.alert('Hata', 'Önce bir proje seçin.'); return; }
    const ext   = name.split('.').pop() ?? 'ts';
    const typeMap: Record<string, string> = {
      js: FileType.JavaScript, jsx: FileType.JSX,
      ts: FileType.TypeScript, tsx: FileType.TSX,
      json: FileType.JSON, md: FileType.Markdown,
      css: FileType.CSS, html: FileType.HTML,
    };
    const r = await fileService.createFile({
      projectId: activeProject.id as any,
      name:      name.trim(),
      path:      name.trim(),
      content:   '',
      type:      (typeMap[ext] ?? FileType.TypeScript) as any,
    });
    if (!r.ok) { Alert.alert('Hata', r.error.message); return; }
    const file = r.data;
    store.openTab({ id: file.id, path: file.path, content: file.content });
    setProjectFiles(prev => [...prev, file]);
    eventBus.emit('editor:tab:opened', { fileId: file.id } as any);
  }, [activeProject, fileService, store, eventBus]);

  // ── Dosya aç ──────────────────────────────────────────────────────────────
  const openFile = useCallback(async (file: IFile) => {
    const existing = stateRef.current.tabs.find((t: EditorTab) => t.id === file.id);
    if (existing) { store.setActive(existing.id); return; }
    store.openTab({ id: file.id, path: file.path, content: file.content });
  }, [store]);

  // ── İçerik güncelle ───────────────────────────────────────────────────────
  const updateContent = useCallback((tabId: string, content: string) => {
    store.updateContent(tabId, content);
    const existing = historyTimeoutRef.current.get(tabId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      store.pushHistory(tabId, content);
      historyTimeoutRef.current.delete(tabId);
    }, 500);
    historyTimeoutRef.current.set(tabId, t);
    const tab = stateRef.current.tabs.find((t: EditorTab) => t.id === tabId);
    if (!tab) return;
    if (shouldAutoSave({ lastSaved: tab.lastSaved ?? 0, now: Date.now(), interval: AUTO_SAVE_INTERVAL })) {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(async () => {
        const latest = stateRef.current.tabs.find((t: EditorTab) => t.id === tabId);
        if (!latest) return;
        const v = validateFileSave(latest.content);
        if (!v.isValid) { Alert.alert('Kayıt Hatası', v.errors.join('\n')); return; }
        const r = await fileService.onContentChange(latest.id as any, latest.content);
        if (r.ok) store.markClean(tabId);
        saveTimeoutRef.current = null;
      }, 1000);
    }
  }, [store, fileService]);

  // ── Sekme kaydet ──────────────────────────────────────────────────────────
  const saveTab = useCallback(async (tabId?: string) => {
    const id  = tabId ?? stateRef.current.activeTabId;
    const tab = stateRef.current.tabs.find((t: EditorTab) => t.id === id);
    if (!tab) return;
    if (saveTimeoutRef.current) { clearTimeout(saveTimeoutRef.current); saveTimeoutRef.current = null; }
    const v = validateFileSave(tab.content);
    if (!v.isValid) { Alert.alert('Kayıt Hatası', v.errors.join('\n')); return; }
    const r = await fileService.saveFile(tab.id as any, tab.content);
    if (r.ok) {
      store.markClean(tab.id);
      eventBus.emit('file:saved', { file: { id: tab.id } as any });
    } else {
      Alert.alert('Kayıt Hatası', r.error.message);
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
        Alert.alert('Kaydedilmemiş', tab.filePath, [
          { text: 'İptal',    style: 'cancel',      onPress: () => resolve() },
          { text: 'Kaydetme', style: 'destructive',  onPress: () => { store.closeTab(tabId); resolve(); } },
          { text: 'Kaydet',                          onPress: async () => { await saveTab(tabId); store.closeTab(tabId); resolve(); } },
        ]);
      });
    } else {
      store.closeTab(tabId);
    }
  }, [store, saveTab]);

  return {
    // Editor state
    tabs:          store.tabs,
    activeTabId:   store.activeTabId,
    activeTab:     store.activeTab(),
    mode:          store.mode,
    theme:         store.theme,
    canUndo:       store.canUndo(store.activeTabId),
    canRedo:       store.canRedo(store.activeTabId),
    // Project state
    activeProject,
    projectFiles,
    projects,
    // Actions
    openProject,
    newProject,
    newFile,
    openFile,
    selectTab,
    closeTab,
    updateContent,
    saveTab,
    saveAll,
    undo:          () => store.undo(),
    redo:          () => store.redo(),
    setMode:       store.setMode,
    setTheme:      store.setTheme,
    loadProjects,
  };
}
