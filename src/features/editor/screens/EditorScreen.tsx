/**
 * features/editor/screens/EditorScreen.tsx
 *
 * Profesyonel IDE layout:
 *   ┌─ Toolbar ────────────────────────────────┐
 *   ├─ Sidebar (proje/dosya) ─┬─ TabBar ───────┤
 *   │  proje listesi          │ açık sekmeler  │
 *   │  dosya ağacı            ├────────────────┤
 *   │  [+ Dosya] [+ Proje]    │   CodeEditor   │
 *   └─────────────────────────┴────────────────┘
 *   └─ StatusBar ────────────────────────────────┘
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, Platform,
  TouchableOpacity, TextInput, FlatList,
  Modal, ScrollView, Alert, Pressable,
} from 'react-native';
import { useSafeAreaInsets }      from 'react-native-safe-area-context';
import { CodeEditor, CodeEditorRef } from '../components/CodeEditor';
import { useEditorController }    from '../hooks/useEditorController';
import {
  getFileName, getLanguageFromFilePath, getLineCount,
  EditorMode, EditorTheme,
} from '../domain/editor.logic';
import type { IProject, IFile } from '@/types/core';

const MONO   = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const SIDEBAR_W = 220;

// ─── Renk paleti ─────────────────────────────────────────────────────────────

const C = {
  bg:        '#1e1e1e',
  sidebar:   '#252526',
  toolbar:   '#2d2d30',
  tabBar:    '#2d2d30',
  statusBar: '#007acc',
  border:    '#3e3e42',
  text:      '#cccccc',
  muted:     '#858585',
  accent:    '#007acc',
  active:    '#1e1e1e',
  modified:  '#e8a87c',
  success:   '#4ec9b0',
  error:     '#f48771',
} as const;

// ─── Yeni Dosya Modal ─────────────────────────────────────────────────────────

function NewFileModal({ visible, onConfirm, onCancel }: {
  visible: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const submit = () => {
    if (!name.trim()) return;
    onConfirm(name.trim());
    setName('');
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={mod.overlay} onPress={onCancel} />
      <View style={mod.box}>
        <Text style={mod.title}>Yeni Dosya</Text>
        <TextInput
          style={mod.input}
          value={name}
          onChangeText={setName}
          placeholder="index.ts"
          placeholderTextColor={C.muted}
          autoFocus
          autoCapitalize="none"
          onSubmitEditing={submit}
          returnKeyType="done"
        />
        <View style={mod.row}>
          <TouchableOpacity style={mod.btnCancel} onPress={onCancel}>
            <Text style={mod.btnCancelText}>İptal</Text>
          </TouchableOpacity>
          <TouchableOpacity style={mod.btnOk} onPress={submit}>
            <Text style={mod.btnOkText}>Oluştur</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── Yeni Proje Modal ─────────────────────────────────────────────────────────

function NewProjectModal({ visible, onConfirm, onCancel }: {
  visible: boolean;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const submit = () => {
    if (!name.trim()) return;
    onConfirm(name.trim());
    setName('');
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={mod.overlay} onPress={onCancel} />
      <View style={mod.box}>
        <Text style={mod.title}>Yeni Proje</Text>
        <TextInput
          style={mod.input}
          value={name}
          onChangeText={setName}
          placeholder="my-project"
          placeholderTextColor={C.muted}
          autoFocus
          autoCapitalize="none"
          onSubmitEditing={submit}
          returnKeyType="done"
        />
        <View style={mod.row}>
          <TouchableOpacity style={mod.btnCancel} onPress={onCancel}>
            <Text style={mod.btnCancelText}>İptal</Text>
          </TouchableOpacity>
          <TouchableOpacity style={mod.btnOk} onPress={submit}>
            <Text style={mod.btnOkText}>Oluştur</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({
  projects, activeProject, projectFiles, activeTabId,
  onSelectProject, onOpenFile, onNewFile, onNewProject,
}: {
  projects:        IProject[];
  activeProject:   IProject | null;
  projectFiles:    IFile[];
  activeTabId:     string | null;
  onSelectProject: (p: IProject) => void;
  onOpenFile:      (f: IFile) => void;
  onNewFile:       () => void;
  onNewProject:    () => void;
}) {
  const [projectsExpanded, setProjectsExpanded] = useState(true);

  return (
    <View style={sb.container}>
      {/* Sidebar header */}
      <View style={sb.header}>
        <Text style={sb.headerTitle}>EXPLORER</Text>
        <View style={sb.headerActions}>
          <TouchableOpacity style={sb.iconBtn} onPress={onNewFile} hitSlop={6}>
            <Text style={sb.iconBtnText}>+📄</Text>
          </TouchableOpacity>
          <TouchableOpacity style={sb.iconBtn} onPress={onNewProject} hitSlop={6}>
            <Text style={sb.iconBtnText}>+📁</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
        {/* Proje listesi */}
        <TouchableOpacity
          style={sb.sectionHeader}
          onPress={() => setProjectsExpanded(v => !v)}
        >
          <Text style={sb.sectionArrow}>{projectsExpanded ? '▾' : '▸'}</Text>
          <Text style={sb.sectionTitle}>PROJELER</Text>
        </TouchableOpacity>

        {projectsExpanded && projects.map(p => (
          <TouchableOpacity
            key={p.id}
            style={[sb.projectRow, activeProject?.id === p.id && sb.projectRowActive]}
            onPress={() => onSelectProject(p)}
          >
            <Text style={sb.projectIcon}>📁</Text>
            <Text style={sb.projectName} numberOfLines={1}>{p.name}</Text>
          </TouchableOpacity>
        ))}

        {projects.length === 0 && projectsExpanded && (
          <View style={sb.emptyHint}>
            <Text style={sb.emptyHintText}>Proje yok</Text>
            <Text style={sb.emptyHintSub}>+📁 ile oluşturun</Text>
          </View>
        )}

        {/* Aktif projenin dosyaları */}
        {activeProject && (
          <>
            <View style={sb.sectionHeader}>
              <Text style={sb.sectionArrow}>▾</Text>
              <Text style={sb.sectionTitle} numberOfLines={1}>
                {activeProject.name.toUpperCase()}
              </Text>
            </View>
            {projectFiles.map(f => (
              <TouchableOpacity
                key={f.id}
                style={[sb.fileRow, f.id === activeTabId && sb.fileRowActive]}
                onPress={() => onOpenFile(f)}
              >
                <Text style={sb.fileIcon}>{getFileIcon(f.name)}</Text>
                <Text
                  style={[sb.fileName, f.id === activeTabId && sb.fileNameActive]}
                  numberOfLines={1}
                >
                  {f.name}
                </Text>
              </TouchableOpacity>
            ))}
            {projectFiles.length === 0 && (
              <View style={sb.emptyHint}>
                <Text style={sb.emptyHintText}>Dosya yok</Text>
                <Text style={sb.emptyHintSub}>+📄 ile ekleyin</Text>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function getFileIcon(name: string): string {
  const ext = name.split('.').pop() ?? '';
  const map: Record<string, string> = {
    ts: '🔷', tsx: '⚛️', js: '🟨', jsx: '⚛️',
    json: '📋', md: '📝', css: '🎨', html: '🌐',
    py: '🐍', txt: '📄',
  };
  return map[ext] ?? '📄';
}

// ─── Toolbar ─────────────────────────────────────────────────────────────────

function Toolbar({
  isModified, canUndo, canRedo, mode, sidebarOpen,
  onSave, onUndo, onRedo, onToggleSidebar, onToggleMode,
}: {
  isModified:      boolean;
  canUndo:         boolean;
  canRedo:         boolean;
  mode:            EditorMode;
  sidebarOpen:     boolean;
  onSave:          () => void;
  onUndo:          () => void;
  onRedo:          () => void;
  onToggleSidebar: () => void;
  onToggleMode:    () => void;
}) {
  return (
    <View style={tb.container}>
      {/* Sol */}
      <View style={tb.group}>
        <TouchableOpacity style={[tb.btn, sidebarOpen && tb.btnActive]} onPress={onToggleSidebar}>
          <Text style={tb.btnText}>☰</Text>
        </TouchableOpacity>
      </View>

      {/* Orta */}
      <View style={tb.group}>
        <TouchableOpacity
          style={[tb.btn, !isModified && tb.btnDisabled]}
          onPress={onSave}
          disabled={!isModified}
        >
          <Text style={[tb.btnText, isModified && { color: C.modified }]}>💾</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[tb.btn, !canUndo && tb.btnDisabled]}
          onPress={onUndo}
          disabled={!canUndo}
        >
          <Text style={tb.btnText}>↩</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[tb.btn, !canRedo && tb.btnDisabled]}
          onPress={onRedo}
          disabled={!canRedo}
        >
          <Text style={tb.btnText}>↪</Text>
        </TouchableOpacity>
      </View>

      {/* Sağ */}
      <View style={tb.group}>
        <TouchableOpacity style={[tb.btn, mode !== EditorMode.EDIT && tb.btnActive]} onPress={onToggleMode}>
          <Text style={tb.btnText}>
            {mode === EditorMode.READONLY ? '🔒' : mode === EditorMode.VIM ? 'Vim' : '✏️'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── TabBar ───────────────────────────────────────────────────────────────────

function EditorTabBar({ tabs, onSelect, onClose }: {
  tabs: { id: string; title: string; isModified: boolean; isActive: boolean }[];
  onSelect: (id: string) => void;
  onClose:  (id: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={tab_.bar}
      contentContainerStyle={tab_.barContent}
    >
      {tabs.map(t => (
        <TouchableOpacity
          key={t.id}
          style={[tab_.tab, t.isActive && tab_.tabActive]}
          onPress={() => onSelect(t.id)}
        >
          <Text style={[tab_.title, t.isActive && tab_.titleActive]} numberOfLines={1}>
            {t.isModified ? '● ' : ''}{t.title}
          </Text>
          <TouchableOpacity
            style={tab_.closeBtn}
            onPress={() => onClose(t.id)}
            hitSlop={6}
          >
            <Text style={tab_.closeText}>✕</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

// ─── StatusBar ────────────────────────────────────────────────────────────────

function EditorStatusBar({ fileName, lines, isModified, mode, language }: {
  fileName: string; lines: number; isModified: boolean;
  mode: EditorMode; language: string;
}) {
  return (
    <View style={stb.bar}>
      <Text style={stb.text}>{mode.toUpperCase()}</Text>
      <View style={stb.sep} />
      <Text style={stb.text}>{fileName}</Text>
      {isModified && <Text style={[stb.text, { color: C.modified }]}> ●</Text>}
      <View style={{ flex: 1 }} />
      <Text style={stb.text}>{language}</Text>
      <View style={stb.sep} />
      <Text style={stb.text}>{lines} satır</Text>
    </View>
  );
}

// ─── EmptyState ───────────────────────────────────────────────────────────────

function EmptyState({ hasProjects, onNewProject, onNewFile }: {
  hasProjects: boolean;
  onNewProject: () => void;
  onNewFile: () => void;
}) {
  return (
    <View style={es.container}>
      <Text style={es.icon}>{ }</Text>
      <Text style={es.title}>Editör</Text>
      {hasProjects ? (
        <>
          <Text style={es.desc}>Soldaki panelden bir dosya seçin{'\n'}veya yeni dosya oluşturun.</Text>
          <TouchableOpacity style={es.btn} onPress={onNewFile}>
            <Text style={es.btnText}>+ Yeni Dosya</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Text style={es.desc}>Henüz proje yok.{'\n'}İlk projenizi oluşturun.</Text>
          <TouchableOpacity style={es.btn} onPress={onNewProject}>
            <Text style={es.btnText}>+ Yeni Proje</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

// ─── EditorScreen ─────────────────────────────────────────────────────────────

export const EditorScreen: React.FC = () => {
  const { top } = useSafeAreaInsets();
  const editor  = useEditorController();
  const editorRef = useRef<CodeEditorRef>(null);

  const [sidebarOpen,    setSidebarOpen]    = useState(true);
  const [showNewFile,    setShowNewFile]    = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);

  useEffect(() => {
    if (!editor.activeTab) return;
    const t = setTimeout(() => { editorRef.current?.focus(); }, 100);
    return () => clearTimeout(t);
  }, [editor.activeTab?.id]);

  const handleNewFile = useCallback(async (name: string) => {
    setShowNewFile(false);
    await editor.newFile(name);
  }, [editor]);

  const handleNewProject = useCallback(async (name: string) => {
    setShowNewProject(false);
    await editor.newProject(name);
  }, [editor]);

  const toggleMode = useCallback(() => {
    const modes = [EditorMode.EDIT, EditorMode.READONLY, EditorMode.VIM];
    const idx   = modes.indexOf(editor.mode);
    editor.setMode(modes[(idx + 1) % modes.length]);
  }, [editor]);

  const currentTab = editor.activeTab;
  const tabItems   = editor.tabs.map(t => ({
    id: t.id, title: getFileName(t.filePath),
    isModified: t.isModified, isActive: t.id === editor.activeTabId,
  }));

  const language = currentTab ? getLanguageFromFilePath(currentTab.filePath) : '';
  const lines    = currentTab ? getLineCount(currentTab.content) : 0;

  return (
    <View style={[s.root, { paddingTop: top }]}>
      {/* Toolbar */}
      <Toolbar
        isModified={currentTab?.isModified ?? false}
        canUndo={editor.canUndo}
        canRedo={editor.canRedo}
        mode={editor.mode}
        sidebarOpen={sidebarOpen}
        onSave={() => editor.saveTab()}
        onUndo={editor.undo}
        onRedo={editor.redo}
        onToggleSidebar={() => setSidebarOpen(v => !v)}
        onToggleMode={toggleMode}
      />

      {/* TabBar */}
      {tabItems.length > 0 && (
        <EditorTabBar
          tabs={tabItems}
          onSelect={editor.selectTab}
          onClose={editor.closeTab}
        />
      )}

      {/* Main area */}
      <View style={s.main}>
        {/* Sidebar */}
        {sidebarOpen && (
          <Sidebar
            projects={editor.projects}
            activeProject={editor.activeProject}
            projectFiles={editor.projectFiles}
            activeTabId={editor.activeTabId}
            onSelectProject={editor.openProject}
            onOpenFile={editor.openFile}
            onNewFile={() => setShowNewFile(true)}
            onNewProject={() => setShowNewProject(true)}
          />
        )}

        {/* Editor alanı */}
        <View style={s.editorArea}>
          {currentTab ? (
            <CodeEditor
              ref={editorRef}
              content={currentTab.content}
              language={language}
              theme={editor.theme}
              mode={editor.mode}
              onChange={c => editor.updateContent(currentTab.id, c)}
              readOnly={editor.mode === EditorMode.READONLY}
              autoFocus
            />
          ) : (
            <EmptyState
              hasProjects={editor.projects.length > 0}
              onNewProject={() => setShowNewProject(true)}
              onNewFile={() => setShowNewFile(true)}
            />
          )}
        </View>
      </View>

      {/* StatusBar */}
      {currentTab && (
        <EditorStatusBar
          fileName={getFileName(currentTab.filePath)}
          lines={lines}
          isModified={currentTab.isModified}
          mode={editor.mode}
          language={language}
        />
      )}

      {/* Modals */}
      <NewFileModal
        visible={showNewFile}
        onConfirm={handleNewFile}
        onCancel={() => setShowNewFile(false)}
      />
      <NewProjectModal
        visible={showNewProject}
        onConfirm={handleNewProject}
        onCancel={() => setShowNewProject(false)}
      />
    </View>
  );
};

// ─── Stiller ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:       { flex: 1, backgroundColor: C.bg },
  main:       { flex: 1, flexDirection: 'row' },
  editorArea: { flex: 1 },
});

const tb = StyleSheet.create({
  container:   { flexDirection: 'row', alignItems: 'center',
                 backgroundColor: C.toolbar, borderBottomWidth: 1,
                 borderBottomColor: C.border, paddingHorizontal: 6,
                 paddingVertical: 4, gap: 8 },
  group:       { flexDirection: 'row', gap: 2 },
  btn:         { padding: 6, borderRadius: 4 },
  btnActive:   { backgroundColor: 'rgba(255,255,255,0.1)' },
  btnDisabled: { opacity: 0.3 },
  btnText:     { fontSize: 16, color: C.text },
});

const tab_ = StyleSheet.create({
  bar:         { backgroundColor: C.tabBar, borderBottomWidth: 1, borderBottomColor: C.border,
                 maxHeight: 35 },
  barContent:  { flexDirection: 'row', alignItems: 'stretch' },
  tab:         { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
                 paddingVertical: 6, borderRightWidth: 1, borderRightColor: C.border,
                 minWidth: 80, maxWidth: 160, gap: 6 },
  tabActive:   { backgroundColor: C.active, borderBottomWidth: 2, borderBottomColor: C.accent },
  title:       { fontSize: 12, color: C.muted, fontFamily: MONO, flex: 1 },
  titleActive: { color: C.text },
  closeBtn:    { padding: 2 },
  closeText:   { fontSize: 10, color: C.muted },
});

const stb = StyleSheet.create({
  bar:  { flexDirection: 'row', alignItems: 'center', backgroundColor: C.statusBar,
          paddingHorizontal: 10, paddingVertical: 3, gap: 6 },
  text: { fontSize: 11, color: '#fff', fontFamily: MONO },
  sep:  { width: 1, height: 12, backgroundColor: 'rgba(255,255,255,0.3)' },
});

const sb = StyleSheet.create({
  container:        { width: SIDEBAR_W, backgroundColor: C.sidebar,
                      borderRightWidth: 1, borderRightColor: C.border },
  header:           { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                      paddingHorizontal: 10, paddingVertical: 8,
                      borderBottomWidth: 1, borderBottomColor: C.border },
  headerTitle:      { fontSize: 10, fontWeight: '700', color: C.muted,
                      fontFamily: MONO, letterSpacing: 1 },
  headerActions:    { flexDirection: 'row', gap: 4 },
  iconBtn:          { padding: 3 },
  iconBtnText:      { fontSize: 12 },
  sectionHeader:    { flexDirection: 'row', alignItems: 'center', gap: 4,
                      paddingHorizontal: 8, paddingVertical: 5 },
  sectionArrow:     { fontSize: 10, color: C.muted },
  sectionTitle:     { fontSize: 10, fontWeight: '700', color: C.muted,
                      fontFamily: MONO, letterSpacing: 0.8, flex: 1 },
  projectRow:       { flexDirection: 'row', alignItems: 'center', gap: 6,
                      paddingLeft: 16, paddingRight: 8, paddingVertical: 5 },
  projectRowActive: { backgroundColor: 'rgba(0,122,204,0.15)' },
  projectIcon:      { fontSize: 13 },
  projectName:      { fontSize: 12, color: C.text, fontFamily: MONO, flex: 1 },
  fileRow:          { flexDirection: 'row', alignItems: 'center', gap: 6,
                      paddingLeft: 24, paddingRight: 8, paddingVertical: 4 },
  fileRowActive:    { backgroundColor: 'rgba(255,255,255,0.08)' },
  fileIcon:         { fontSize: 12 },
  fileName:         { fontSize: 12, color: C.muted, fontFamily: MONO, flex: 1 },
  fileNameActive:   { color: C.text },
  emptyHint:        { paddingLeft: 24, paddingVertical: 8, gap: 2 },
  emptyHintText:    { fontSize: 11, color: C.muted, fontFamily: MONO },
  emptyHintSub:     { fontSize: 10, color: '#555', fontFamily: MONO },
});

const mod = StyleSheet.create({
  overlay:       { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  box:           { position: 'absolute', left: 40, right: 40,
                   top: '35%', backgroundColor: '#2d2d30',
                   borderRadius: 8, padding: 20, gap: 14,
                   borderWidth: 1, borderColor: '#555' },
  title:         { fontSize: 14, fontWeight: '700', color: C.text, fontFamily: MONO },
  input:         { backgroundColor: '#1e1e1e', borderWidth: 1, borderColor: '#555',
                   borderRadius: 4, padding: 10, fontSize: 13,
                   color: C.text, fontFamily: MONO },
  row:           { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  btnCancel:     { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 4,
                   backgroundColor: '#3e3e42' },
  btnCancelText: { color: C.text, fontSize: 12, fontFamily: MONO },
  btnOk:         { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 4,
                   backgroundColor: C.accent },
  btnOkText:     { color: '#fff', fontSize: 12, fontWeight: '700', fontFamily: MONO },
});

const es = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  icon:      { fontSize: 40 },
  title:     { fontSize: 16, fontWeight: '700', color: '#d4d4d4', fontFamily: MONO },
  desc:      { fontSize: 12, color: '#6e6e6e', fontFamily: MONO,
               textAlign: 'center', lineHeight: 20 },
  btn:       { marginTop: 8, paddingHorizontal: 20, paddingVertical: 10,
               backgroundColor: C.accent, borderRadius: 6 },
  btnText:   { color: '#fff', fontSize: 13, fontWeight: '600', fontFamily: MONO },
});
