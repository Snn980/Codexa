// ─── Types ──────────────────────────────────────────────────────────────────

export type IdGenerator = () => string;

export enum EditorMode {
  EDIT = 'edit',
  READONLY = 'readonly',
  DIFF = 'diff',
  VIM = 'vim',
}

export enum EditorTheme {
  LIGHT = 'light',
  DARK = 'dark',
  HIGH_CONTRAST = 'high_contrast',
}

export interface EditorTab {
  id: string;
  filePath: string;
  content: string;
  language: string;
  isModified: boolean;
  isActive?: boolean;
  createdAt: number;
  lastSaved: number | null;
}

export interface TabHistory {
  past: string[];
  future: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const HISTORY_LIMIT = 100;
export const AUTO_SAVE_INTERVAL = 5000;

// ─── ID Helpers ────────────────────────────────────────────────────────────

export const defaultIdGenerator: IdGenerator = () =>
  `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

export function generateTabId(generator: IdGenerator = defaultIdGenerator): string {
  return generator();
}

// ─── Auto Save ─────────────────────────────────────────────────────────────

export interface AutoSaveParams {
  lastSaved: number;
  now: number;
  interval: number;
}

export function shouldAutoSave({ lastSaved, now, interval }: AutoSaveParams): boolean {
  if (!lastSaved) return true;
  return now - lastSaved >= interval;
}

// ─── File Path Helpers ─────────────────────────────────────────────────────

export function getFileName(filePath: string): string {
  return filePath.split('/').pop() || 'untitled';
}

export function getFileExtension(filePath: string): string {
  const parts = getFileName(filePath).split('.');
  return parts.length > 1 ? parts.pop() || 'txt' : 'txt';
}

export function getLanguageFromExtension(extension: string): string {
  const languageMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    go: 'go',
    rs: 'rust',
    html: 'html',
    css: 'css',
    json: 'json',
    md: 'markdown',
    txt: 'plaintext',
  };
  return languageMap[extension] || 'plaintext';
}

export function getLanguageFromFilePath(filePath: string): string {
  return getLanguageFromExtension(getFileExtension(filePath));
}

export function generateFileName(prefix = 'new_file'): string {
  return `${prefix}_${Date.now()}.txt`;
}

export function getLineCount(content: string): number {
  return content.split('\n').length;
}

export function validateFileSave(
  content: string,
  maxSize = 10 * 1024 * 1024
): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (content.length > maxSize) errors.push('File size exceeds limit');
  if (content.includes('\0')) errors.push('File contains null bytes');

  return { isValid: errors.length === 0, errors };
}

// ─── Tab Operations ────────────────────────────────────────────────────────

export interface OpenFileParams {
  id: string;
  path: string;
  content: string;
}

export function openTab(tabs: EditorTab[], file: OpenFileParams): EditorTab[] {
  const existingIndex = tabs.findIndex(t => t.id === file.id);

  if (existingIndex !== -1) {
    return tabs.map((t, i) => ({
      ...t,
      isActive: i === existingIndex,
    }));
  }

  const newTab: EditorTab = {
    id: file.id,
    filePath: file.path,
    content: file.content,
    language: getLanguageFromFilePath(file.path),
    isModified: false,
    isActive: true,
    createdAt: Date.now(),
    lastSaved: Date.now(),
  };

  return [...tabs.map(t => ({ ...t, isActive: false })), newTab];
}

export function closeTab(tabs: EditorTab[], tabId: string): EditorTab[] {
  const filtered = tabs.filter(t => t.id !== tabId);

  if (filtered.length === 0) return filtered;

  const wasActive = tabs.find(t => t.id === tabId)?.isActive;

  if (wasActive) {
    return filtered.map((t, i) => ({
      ...t,
      isActive: i === filtered.length - 1,
    }));
  }

  return filtered;
}

export function updateTabContent(
  tabs: EditorTab[],
  tabId: string,
  content: string
): EditorTab[] {
  return tabs.map(t =>
    t.id === tabId ? { ...t, content, isModified: true } : t
  );
}

export function markTabClean(tabs: EditorTab[], tabId: string): EditorTab[] {
  return tabs.map(t =>
    t.id === tabId
      ? { ...t, isModified: false, lastSaved: Date.now() }
      : t
  );
}

// ─── History Operations ────────────────────────────────────────────────────

export function pushHistory(history: TabHistory, content: string): TabHistory {
  const last = history.past[history.past.length - 1];

  if (last?.trim() === content.trim()) return history;

  const newPast = [...history.past, content].slice(-HISTORY_LIMIT);

  return {
    past: newPast,
    future: [],
  };
}

export function applyUndo(history: TabHistory, current: string) {
  if (!history.past.length) return null;

  const newPast = [...history.past];
  const prev = newPast.pop()!;

  return {
    content: prev,
    history: {
      past: newPast,
      future: [current, ...history.future],
    },
  };
}

export function applyRedo(history: TabHistory, current: string) {
  if (!history.future.length) return null;

  const newFuture = [...history.future];
  const next = newFuture.shift()!;

  return {
    content: next,
    history: {
      past: [...history.past, current],
      future: newFuture,
    },
  };
}

// ─── Mode Helpers ──────────────────────────────────────────────────────────

export function isEditableMode(mode: EditorMode): boolean {
  return mode === EditorMode.EDIT || mode === EditorMode.VIM;
}

export function getModeDisplayName(mode: EditorMode): string {
  switch (mode) {
    case EditorMode.EDIT: return 'Edit';
    case EditorMode.VIM: return 'Vim';
    case EditorMode.READONLY: return 'Read Only';
    case EditorMode.DIFF: return 'Diff';
    default: return 'Edit';
  }
}
