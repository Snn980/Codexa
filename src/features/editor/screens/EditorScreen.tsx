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
 *
 * Tema güncellemesi:
 *   • Hardcoded `C` paleti kaldırıldı
 *   • makeStyles(colors) pattern — tema değişince tüm bileşenler güncellenir
 *   • Alt bileşenler `colors` prop alır, useTheme() root'ta çağrılır
 */

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, Platform,
  TouchableOpacity, TextInput,
  Modal, ScrollView, Pressable,
} from 'react-native';
import { useSafeAreaInsets }        from 'react-native-safe-area-context';
import { CodeEditor, CodeEditorRef }  from '../components/CodeEditor';
import { useEditorController }       from '../hooks/useEditorController';
import {
  getFileName, getLanguageFromFilePath, getLineCount,
  EditorMode,
} from '../domain/editor.logic';
import type { IProject, IFile } from '@/types/core';
import { useTheme }              from '@/theme';
import type { ThemeColors }      from '@/theme';

const MONO      = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const SIDEBAR_W = 220;

// ─── Stil fabrikası ───────────────────────────────────────────────────────────
//
// StyleSheet.create() statik — renkleri inline geçmek yerine
// memoize edilmiş makeStyles() çağrısı kullanılır.
// Tema değişince yalnızca colors referansı değişir → useMemo tetiklenir.

function makeStyles(C: ThemeColors) {
  return {
    root: { flex: 1, backgroundColor: C.bg } as const,
    main: { flex: 1, flexDirection: 'row' as const },
    editorArea: { flex: 1 } as const,

    // Toolbar
    tb: {
      container:   {
        flexDirection: 'row' as const, alignItems: 'center' as const,
        backgroundColor: C.toolbar, borderBottomWidth: 1,
        borderBottomColor: C.border, paddingHorizontal: 6,
        paddingVertical: 4, gap: 8,
      },
      group:       { flexDirection: 'row' as const, gap: 2 },
      btn:         { padding: 6, borderRadius: 4 },
      btnActive:   { backgroundColor: C.accentMuted },
      btnDisabled: { opacity: 0.3 },
      btnText:     { fontSize: 16, color: C.text },
      modifiedText:{ fontSize: 16, color: C.warning },
    },

    // TabBar
    tabBar: {
      bar:         {
        backgroundColor: C.surface,
        borderBottomWidth: 1, borderBottomColor: C.border, maxHeight: 35,
      },
      barContent:  { flexDirection: 'row' as const, alignItems: 'stretch' as const },
      tab:         {
        flexDirection: 'row' as const, alignItems: 'center' as const,
        paddingHorizontal: 12, paddingVertical: 6,
        borderRightWidth: 1, borderRightColor: C.border,
        minWidth: 80, maxWidth: 160, gap: 6,
      },
      tabActive:   {
        backgroundColor: C.editor.activeLine,
        borderBottomWidth: 2, borderBottomColor: C.accent,
      },
      title:       { fontSize: 12, color: C.muted, fontFamily: MONO, flex: 1 },
      titleActive: { color: C.text },
      closeBtn:    { padding: 2 },
      closeText:   { fontSize: 10, color: C.muted },
    },

    // StatusBar
    stb: {
      bar:  {
        flexDirection: 'row' as const, alignItems: 'center' as const,
        backgroundColor: C.accent,
        paddingHorizontal: 10, paddingVertical: 3, gap: 6,
      },
      text: { fontSize: 11, color: '#fff', fontFamily: MONO },
      sep:  { width: 1, height: 12, backgroundColor: 'rgba(255,255,255,0.35)' },
    },

    // Sidebar
    sb: {
      container:        { width: SIDEBAR_W, backgroundColor: C.surface, borderRightWidth: 1, borderRightColor: C.border },
      header:           { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border },
      headerTitle:      { fontSize: 10, fontWeight: '700' as const, color: C.muted, fontFamily: MONO, letterSpacing: 1 },
      headerActions:    { flexDirection: 'row' as const, gap: 4 },
      iconBtn:          { padding: 3 },
      iconBtnText:      { fontSize: 12 },
      sectionHeader:    { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4, paddingHorizontal: 8, paddingVertical: 5 },
      sectionArrow:     { fontSize: 10, color: C.muted },
      sectionTitle:     { fontSize: 10, fontWeight: '700' as const, color: C.muted, fontFamily: MONO, letterSpacing: 0.8, flex: 1 },
      projectRow:       { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, paddingLeft: 16, paddingRight: 8, paddingVertical: 5 },
      projectRowActive: { backgroundColor: C.accentMuted },
      projectIcon:      { fontSize: 13 },
      projectName:      { fontSize: 12, color: C.text, fontFamily: MONO, flex: 1 },
      fileRow:          { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, paddingLeft: 24, paddingRight: 8, paddingVertical: 4 },
      fileRowActive:    { backgroundColor: C.surface2 },
      fileIcon:         { fontSize: 12 },
      fileName:         { fontSize: 12, color: C.muted, fontFamily: MONO, flex: 1 },
      fileNameActive:   { color: C.text },
      emptyHint:        { paddingLeft: 24, paddingVertical: 8, gap: 2 },
      emptyHintText:    { fontSize: 11, color: C.muted, fontFamily: MONO },
      emptyHintSub:     { fontSize: 10, color: C.muted, fontFamily: MONO, opacity: 0.6 },
    },

    // Modal
    mod: {
      overlay:       { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.65)' },
      box:           { position: 'absolute' as const, left: 40, right: 40, top: '35%' as any, backgroundColor: C.surface, borderRadius: 10, padding: 20, gap: 14, borderWidth: 1, borderColor: C.border },
      title:         { fontSize: 14, fontWeight: '700' as const, color: C.text, fontFamily: MONO },
      input:         { backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border, borderRadius: 6, padding: 10, fontSize: 13, color: C.text, fontFamily: MONO },
      row:           { flexDirection: 'row' as const, justifyContent: 'flex-end' as const, gap: 10 },
      btnCancel:     { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 6, backgroundColor: C.surface2 },
      btnCancelText: { color: C.textSecondary, fontSize: 12, fontFamily: MONO },
      btnOk:         { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 6, backgroundColor: C.accent },
      btnOkText:     { color: '#fff', fontSize: 12, fontWeight: '700' as const, fontFamily: MONO },
    },

    // EmptyState
    es: {
      container: { flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 12, padding: 32 },
      icon:      { fontSize: 40 },
      title:     { fontSize: 16, fontWeight: '700' as const, color: C.text, fontFamily: MONO },
      desc:      { fontSize: 12, color: C.textSecondary, fontFamily: MONO, textAlign: 'center' as const, lineHeight: 20 },
      btn:       { marginTop: 8, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: C.accent, borderRadius: 6 },
      btnText:   { color: '#fff', fontSize: 13, fontWeight: '600' as const, fontFamily: MONO },
    },
  };
}

// ─── Dosya ikonu ─────────────────────────────────────────────────────────────

function getFileIcon(name: string): string {
  const ext = name.split('.').pop() ?? '';
  const map: Record<string, string> = {
    ts: '🔷', tsx: '⚛️', js: '🟨', jsx: '⚛️',
    json: '📋', md: '📝', css: '🎨', html: '🌐',
    py: '🐍', txt: '📄',
  };
  return map[ext] ?? '📄';
}

// ─── Modal ───────────────────────────────────────────────────────────────────

function FileModal({
  visible, title, placeholder, onConfirm, onCancel, S,
}: {
  visible: boolean;
  title: string;
  placeholder: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
  S: ReturnType<typeof makeStyles>;
}) {
  const [name, setName] = useState('');
  const submit = () => {
    if (!name.trim()) return;
    onConfirm(name.trim());
    setName('');
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={S.mod.overlay} onPress={onCancel} />
      <View style={S.mod.box}>
        <Text style={S.mod.title}>{title}</Text>
        <TextInput
          style={S.mod.input}
          value={name}
          onChangeText={setName}
          placeholder={placeholder}
          placeholderTextColor="#666"
          autoFocus
          autoCapitalize="none"
          onSubmitEditing={submit}
          returnKeyType="done"
        />
        <View style={S.mod.row}>
          <TouchableOpacity style={S.mod.btnCancel} onPress={onCancel}>
            <Text style={S.mod.btnCancelText}>İptal</Text>
          </TouchableOpacity>
          <TouchableOpacity style={S.mod.btnOk} onPress={submit}>
            <Text style={S.mod.btnOkText}>Oluştur</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

function Sidebar({
  projects, activeProject, projectFiles, activeTabId,
  onSelectProject, onOpenFile, onNewFile, onNewProject, onNewFolder, S,
}: {
  projects:        IProject[];
  activeProject:   IProject | null;
  projectFiles:    IFile[];
  activeTabId:     string | null;
  onSelectProject: (p: IProject) => void;
  onOpenFile:      (f: IFile) => void;
  onNewFile:       () => void;
  onNewProject:    () => void;
  onNewFolder:     () => void;
  S: ReturnType<typeof makeStyles>;
}) {
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const sb = S.sb;

  return (
    <View style={sb.container}>
      <View style={sb.header}>
        <Text style={sb.headerTitle}>EXPLORER</Text>
        <View style={sb.headerActions}>
          <TouchableOpacity style={sb.iconBtn} onPress={onNewFile} hitSlop={6}>
            <Text style={sb.iconBtnText}>+📄</Text>
          </TouchableOpacity>
          <TouchableOpacity style={sb.iconBtn} onPress={onNewFolder} hitSlop={6}>
            <Text style={sb.iconBtnText}>+📁</Text>
          </TouchableOpacity>
          <TouchableOpacity style={sb.iconBtn} onPress={onNewProject} hitSlop={6}>
            <Text style={sb.iconBtnText}>+🗂️</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
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

// ─── Toolbar ─────────────────────────────────────────────────────────────────

function Toolbar({
  isModified, canUndo, canRedo, mode, sidebarOpen,
  onSave, onUndo, onRedo, onToggleSidebar, onToggleMode, S,
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
  S: ReturnType<typeof makeStyles>;
}) {
  const tb = S.tb;
  return (
    <View style={tb.container}>
      <View style={tb.group}>
        <TouchableOpacity
          style={[tb.btn, sidebarOpen && tb.btnActive]}
          onPress={onToggleSidebar}
        >
          <Text style={tb.btnText}>☰</Text>
        </TouchableOpacity>
      </View>

      <View style={tb.group}>
        <TouchableOpacity
          style={[tb.btn, !isModified && tb.btnDisabled]}
          onPress={onSave}
          disabled={!isModified}
        >
          <Text style={isModified ? tb.modifiedText : tb.btnText}>💾</Text>
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

      <View style={tb.group}>
        <TouchableOpacity
          style={[tb.btn, mode !== EditorMode.EDIT && tb.btnActive]}
          onPress={onToggleMode}
        >
          <Text style={tb.btnText}>
            {mode === EditorMode.READONLY ? '🔒' : mode === EditorMode.VIM ? 'Vim' : '✏️'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── EditorTabBar ─────────────────────────────────────────────────────────────

function EditorTabBar({
  tabs, onSelect, onClose, S,
}: {
  tabs: { id: string; title: string; isModified: boolean; isActive: boolean }[];
  onSelect: (id: string) => void;
  onClose:  (id: string) => void;
  S: ReturnType<typeof makeStyles>;
}) {
  const t_ = S.tabBar;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={t_.bar}
      contentContainerStyle={t_.barContent}
    >
      {tabs.map(t => (
        <TouchableOpacity
          key={t.id}
          style={[t_.tab, t.isActive && t_.tabActive]}
          onPress={() => onSelect(t.id)}
        >
          <Text style={[t_.title, t.isActive && t_.titleActive]} numberOfLines={1}>
            {t.isModified ? '● ' : ''}{t.title}
          </Text>
          <TouchableOpacity style={t_.closeBtn} onPress={() => onClose(t.id)} hitSlop={6}>
            <Text style={t_.closeText}>✕</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

// ─── StatusBar ────────────────────────────────────────────────────────────────

function EditorStatusBar({
  fileName, lines, isModified, mode, language, S,
}: {
  fileName: string; lines: number; isModified: boolean;
  mode: EditorMode; language: string;
  S: ReturnType<typeof makeStyles>;
}) {
  const stb = S.stb;
  return (
    <View style={stb.bar}>
      <Text style={stb.text}>{mode.toUpperCase()}</Text>
      <View style={stb.sep} />
      <Text style={stb.text}>{fileName}{isModified ? ' ●' : ''}</Text>
      <View style={{ flex: 1 }} />
      <Text style={stb.text}>{language}</Text>
      <View style={stb.sep} />
      <Text style={stb.text}>{lines} satır</Text>
    </View>
  );
}

// ─── EmptyState ───────────────────────────────────────────────────────────────

function EmptyState({
  hasProjects, onNewProject, onNewFile, S,
}: {
  hasProjects: boolean;
  onNewProject: () => void;
  onNewFile: () => void;
  S: ReturnType<typeof makeStyles>;
}) {
  const es = S.es;
  return (
    <View style={es.container}>
      <Text style={es.icon}>🖥️</Text>
      <Text style={es.title}>Editör</Text>
      {hasProjects ? (
        <>
          <Text style={es.desc}>{'Soldaki panelden bir dosya seçin\nveya yeni dosya oluşturun.'}</Text>
          <TouchableOpacity style={es.btn} onPress={onNewFile}>
            <Text style={es.btnText}>+ Yeni Dosya</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Text style={es.desc}>{'Henüz proje yok.\nİlk projenizi oluşturun.'}</Text>
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
  const { top }            = useSafeAreaInsets();
  const { colors }         = useTheme();
  const editor             = useEditorController();
  const editorRef          = useRef<CodeEditorRef>(null);

  // Tema değişince stiller yeniden hesaplanır
  const S = useMemo(() => makeStyles(colors), [colors]);

  const [sidebarOpen,    setSidebarOpen]    = useState(true);
  const [showNewFile,    setShowNewFile]    = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewFolder,  setShowNewFolder]  = useState(false);

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

  const handleNewFolder = useCallback(async (name: string) => {
    setShowNewFolder(false);
    await editor.newFolder(name);
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
    <View style={[S.root, { paddingTop: top }]}>

      {/* Toolbar */}
      <Toolbar
        S={S}
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
          S={S}
          tabs={tabItems}
          onSelect={editor.selectTab}
          onClose={editor.closeTab}
        />
      )}

      {/* Ana alan */}
      <View style={S.main}>

        {/* Sidebar */}
        {sidebarOpen && (
          <Sidebar
            S={S}
            projects={editor.projects}
            activeProject={editor.activeProject}
            projectFiles={editor.projectFiles}
            activeTabId={editor.activeTabId}
            onSelectProject={editor.openProject}
            onOpenFile={editor.openFile}
            onNewFile={() => setShowNewFile(true)}
            onNewProject={() => setShowNewProject(true)}
            onNewFolder={() => setShowNewFolder(true)}
          />
        )}

        {/* Kod editörü */}
        <View style={S.editorArea}>
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
              S={S}
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
          S={S}
          fileName={getFileName(currentTab.filePath)}
          lines={lines}
          isModified={currentTab.isModified}
          mode={editor.mode}
          language={language}
        />
      )}

      {/* Modals */}
      <FileModal
        S={S}
        visible={showNewFile}
        title="Yeni Dosya"
        placeholder="index.ts"
        onConfirm={handleNewFile}
        onCancel={() => setShowNewFile(false)}
      />
      <FileModal
        S={S}
        visible={showNewProject}
        title="Yeni Proje"
        placeholder="my-project"
        onConfirm={handleNewProject}
        onCancel={() => setShowNewProject(false)}
      />
      <FileModal
        S={S}
        visible={showNewFolder}
        title="Yeni Klasör"
        placeholder="utils"
        onConfirm={handleNewFolder}
        onCancel={() => setShowNewFolder(false)}
      />
    </View>
  );
};
