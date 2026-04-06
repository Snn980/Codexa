import { create } from 'zustand';

import {
  openTab,
  closeTab,
  updateTabContent,
  markTabClean,
  pushHistory,
  applyUndo,
  applyRedo,
  type EditorTab,
  type TabHistory,
  type OpenFileParams,
  EditorMode,
  EditorTheme,
} from '@/features/editor/domain/editor.logic';

// ─── Store Types ────────────────────────────────────────────────────────────

export interface EditorStore {
  tabs: EditorTab[];
  activeTabId: string | null;
  mode: EditorMode;
  theme: EditorTheme;

  history: Record<string, TabHistory>;

  // Computed
  activeTab: () => EditorTab | null;
  canUndo: (tabId?: string | null) => boolean;
  canRedo: (tabId?: string | null) => boolean;

  // Tab
  openTab: (file: OpenFileParams) => void;
  closeTab: (tabId: string) => void;
  setActive: (tabId: string) => void;
  renameTab: (tabId: string, newPath: string) => void;

  // Content
  updateContent: (tabId: string, content: string) => void;
  pushHistory: (tabId: string, content: string) => void;
  markClean: (tabId: string) => void;
  undo: (tabId?: string) => void;
  redo: (tabId?: string) => void;

  // UI
  setMode: (mode: EditorMode) => void;
  setTheme: (theme: EditorTheme) => void;
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useEditorStore = create<EditorStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  mode: EditorMode.EDIT,
  theme: EditorTheme.DARK,
  history: {},

  // ─── Computed ────────────────────────────────────────────────────────────

  activeTab: () => {
    const { tabs, activeTabId } = get();
    if (!activeTabId) return null;
    return tabs.find(t => t.id === activeTabId) ?? null;
  },

  canUndo: (tabId) => {
    const id = tabId ?? get().activeTabId;
    if (!id) return false;
    return (get().history[id]?.past.length ?? 0) > 0;
  },

  canRedo: (tabId) => {
    const id = tabId ?? get().activeTabId;
    if (!id) return false;
    return (get().history[id]?.future.length ?? 0) > 0;
  },

  // ─── Tab ─────────────────────────────────────────────────────────────────

  openTab: (file) =>
    set((s) => {
      const newTabs = openTab(s.tabs, file);

      const newHistory = { ...s.history };

      if (!newHistory[file.id]) {
        newHistory[file.id] = { past: [], future: [] };
      }

      if (file.content) {
        newHistory[file.id] = pushHistory(newHistory[file.id], file.content);
      }

      return {
        tabs: newTabs,
        activeTabId: file.id,
        history: newHistory,
      };
    }),

  closeTab: (tabId) =>
    set((s) => {
      const newTabs = closeTab(s.tabs, tabId);

      const { [tabId]: _, ...rest } = s.history;

      const active = newTabs.find(t => t.isActive);

      return {
        tabs: newTabs,
        activeTabId: active?.id ?? null,
        history: rest,
      };
    }),

  setActive: (tabId) =>
    set((s) => ({
      tabs: s.tabs.map(t => ({ ...t, isActive: t.id === tabId })),
      activeTabId: tabId,
    })),

  // ─── Content ─────────────────────────────────────────────────────────────

  updateContent: (tabId, content) =>
    set((s) => ({
      tabs: updateTabContent(s.tabs, tabId, content),
    })),

  pushHistory: (tabId, content) =>
    set((s) => ({
      history: {
        ...s.history,
        [tabId]: pushHistory(
          s.history[tabId] ?? { past: [], future: [] },
          content
        ),
      },
    })),

  markClean: (tabId) =>
    set((s) => ({
      tabs: markTabClean(s.tabs, tabId),
    })),

  undo: (tabId) =>
    set((s) => {
      const id = tabId ?? s.activeTabId;
      if (!id) return s;

      const tab = s.tabs.find(t => t.id === id);
      const history = s.history[id];
      if (!tab || !history) return s;

      const result = applyUndo(history, tab.content);
      if (!result) return s;

      return {
        tabs: updateTabContent(s.tabs, id, result.content),
        history: {
          ...s.history,
          [id]: result.history,
        },
      };
    }),

  redo: (tabId) =>
    set((s) => {
      const id = tabId ?? s.activeTabId;
      if (!id) return s;

      const tab = s.tabs.find(t => t.id === id);
      const history = s.history[id];
      if (!tab || !history) return s;

      const result = applyRedo(history, tab.content);
      if (!result) return s;

      return {
        tabs: updateTabContent(s.tabs, id, result.content),
        history: {
          ...s.history,
          [id]: result.history,
        },
      };
    }),

  renameTab: (tabId, newPath) =>
    set((s) => ({
      tabs: s.tabs.map(t =>
        t.id === tabId ? { ...t, filePath: newPath } : t
      ),
    })),

  // ─── UI ──────────────────────────────────────────────────────────────────

  setMode: (mode) => set({ mode }),
  setTheme: (theme) => set({ theme }),
}));
