/**
 * features/editor/screens/EditorScreen.tsx
 *
 * Profesyonel IDE layout:
 *   ┌─ Toolbar ─────────────────────────────────────────┐
 *   ├─ Sidebar ──────────────┬─ TabBar ─────────────────┤
 *   │  [EXPLORER]  +📄+📁+🗂️ │ sekme1  sekme2  ...      │
 *   │  ▾ PROJELER            ├──────────────────────────┤
 *   │    🗂️ proje-adı ⋯      │                          │
 *   │  ▾ PROJE-ADI           │     CodeMirror 6         │
 *   │    📁 klasör/ ⋯        │     Syntax Highlight     │
 *   │      📄 dosya.ts ⋯     │                          │
 *   │    📄 index.ts ⋯       │                          │
 *   └────────────────────────┴──────────────────────────┘
 *   └─ MobileKeyboard ───────────────────────────────────┘
 *   └─ StatusBar ────────────────────────────────────────┘
 *
 * Yeni özellikler (bu sürüm):
 *   • Dosya / Klasör / Proje context menu (uzun basış ⋯ butonu)
 *     → Yeniden Adlandır / Taşı / Kopyala / Sil
 *   • Proje context menu → Yeniden Adlandır / Sil
 *   • Klasör context menu → Sil (tüm içeriğiyle)
 *   • Cursor satır:kolon → StatusBar entegrasyonu (CM6)
 *   • Kaydedilmemiş değişiklik → sekmeyi kapatırken uyarı
 */

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  Alert, KeyboardAvoidingView, Modal, Platform,
  Pressable, ScrollView, StyleSheet, Text,
  TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets }        from 'react-native-safe-area-context';
import { MobileKeyboard }           from '@/app/components/MobileKeyboard';
import { CodeEditor, CodeEditorRef } from '../components/CodeEditor';
import { useEditorController }       from '../hooks/useEditorController';
import {
  getFileName, getLanguageFromFilePath,
  EditorMode,
} from '../domain/editor.logic';
import type { IProject, IFile } from '@/types/core';
import { useTheme }             from '@/theme';
import type { ThemeColors }     from '@/theme';

const MONO      = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const SIDEBAR_W = 220;

// ─── Stil fabrikası ───────────────────────────────────────────────────────────

function makeStyles(C: ThemeColors) {
  return {
    root:       { flex: 1, backgroundColor: C.bg } as const,
    main:       { flex: 1, flexDirection: 'row' as const },
    editorArea: { flex: 1 } as const,

    tb: {
      container:    { flexDirection: 'row' as const, alignItems: 'center' as const, backgroundColor: C.toolbar, borderBottomWidth: 1, borderBottomColor: C.border, paddingHorizontal: 6, paddingVertical: 4, gap: 8 },
      group:        { flexDirection: 'row' as const, gap: 2 },
      btn:          { padding: 6, borderRadius: 4 },
      btnActive:    { backgroundColor: C.accentMuted },
      btnDisabled:  { opacity: 0.3 },
      btnText:      { fontSize: 16, color: C.text },
      modifiedText: { fontSize: 16, color: C.warning },
    },

    tabBar: {
      bar:         { backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.border, maxHeight: 35 },
      barContent:  { flexDirection: 'row' as const, alignItems: 'stretch' as const },
      tab:         { flexDirection: 'row' as const, alignItems: 'center' as const, paddingHorizontal: 12, paddingVertical: 6, borderRightWidth: 1, borderRightColor: C.border, minWidth: 80, maxWidth: 160, gap: 6 },
      tabActive:   { backgroundColor: C.editor.activeLine, borderBottomWidth: 2, borderBottomColor: C.accent },
      title:       { fontSize: 12, color: C.muted, fontFamily: MONO, flex: 1 },
      titleActive: { color: C.text },
      closeBtn:    { padding: 2 },
      closeText:   { fontSize: 10, color: C.muted },
    },

    stb: {
      bar:  { flexDirection: 'row' as const, alignItems: 'center' as const, backgroundColor: C.accent, paddingHorizontal: 10, paddingVertical: 3, gap: 6 },
      text: { fontSize: 11, color: '#fff', fontFamily: MONO },
      sep:  { width: 1, height: 12, backgroundColor: 'rgba(255,255,255,0.35)' },
    },

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
      menuBtn:          { padding: 4 },
      menuBtnText:      { fontSize: 11, color: C.muted },
      projectRow:       { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, paddingLeft: 16, paddingRight: 4, paddingVertical: 5 },
      projectRowActive: { backgroundColor: C.accentMuted },
      projectIcon:      { fontSize: 13 },
      projectName:      { fontSize: 12, color: C.text, fontFamily: MONO, flex: 1 },
      fileRow:          { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, paddingLeft: 24, paddingRight: 4, paddingVertical: 4 },
      fileRowActive:    { backgroundColor: C.surface2 },
      fileIcon:         { fontSize: 12 },
      fileName:         { fontSize: 12, color: C.muted, fontFamily: MONO, flex: 1 },
      fileNameActive:   { color: C.text },
      emptyHint:        { paddingLeft: 24, paddingVertical: 8, gap: 2 },
      emptyHintText:    { fontSize: 11, color: C.muted, fontFamily: MONO },
      emptyHintSub:     { fontSize: 10, color: C.muted, fontFamily: MONO, opacity: 0.6 },
    },

    // Girdi modali (yeniden adlandır / kopyala / taşı / yeni)
    mod: {
      overlay:       { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.65)' },
      box:           { position: 'absolute' as const, left: 32, right: 32, top: '30%' as any, backgroundColor: C.surface, borderRadius: 10, padding: 20, gap: 14, borderWidth: 1, borderColor: C.border },
      title:         { fontSize: 14, fontWeight: '700' as const, color: C.text, fontFamily: MONO },
      subtitle:      { fontSize: 11, color: C.muted, fontFamily: MONO, marginTop: -8 },
      input:         { backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border, borderRadius: 6, padding: 10, fontSize: 13, color: C.text, fontFamily: MONO },
      row:           { flexDirection: 'row' as const, justifyContent: 'flex-end' as const, gap: 10 },
      btnCancel:     { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 6, backgroundColor: C.surface2 },
      btnCancelText: { color: C.muted, fontSize: 12, fontFamily: MONO },
      btnOk:         { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 6, backgroundColor: C.accent },
      btnOkText:     { color: '#fff', fontSize: 12, fontWeight: '700' as const, fontFamily: MONO },
      btnDanger:     { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 6, backgroundColor: '#b91c1c' },
    },

    // Context menu
    ctx: {
      overlay:   { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
      menu:      { position: 'absolute' as const, minWidth: 180, backgroundColor: C.surface, borderRadius: 8, borderWidth: 1, borderColor: C.border, overflow: 'hidden' as const, elevation: 8, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
      item:      { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
      itemBorder:{ borderTopWidth: 1, borderTopColor: C.border },
      itemIcon:  { fontSize: 14, width: 20, textAlign: 'center' as const },
      itemText:  { fontSize: 13, color: C.text, fontFamily: MONO },
      itemDanger:{ fontSize: 13, color: '#f87171', fontFamily: MONO },
      sep:       { height: 1, backgroundColor: C.border },
    },

    es: {
      container: { flex: 1, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 12, padding: 32 },
      icon:      { fontSize: 40 },
      title:     { fontSize: 16, fontWeight: '700' as const, color: C.text, fontFamily: MONO },
      desc:      { fontSize: 12, color: C.muted, fontFamily: MONO, textAlign: 'center' as const, lineHeight: 20 },
      btn:       { marginTop: 8, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: C.accent, borderRadius: 6 },
      btnText:   { color: '#fff', fontSize: 13, fontWeight: '600' as const, fontFamily: MONO },
    },
  };
}

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

function getFileIcon(name: string): string {
  const ext = name.split('.').pop() ?? '';
  const map: Record<string, string> = {
    ts: '🔷', tsx: '⚛️', js: '🟨', jsx: '⚛️',
    json: '📋', md: '📝', css: '🎨', html: '🌐',
    py: '🐍', txt: '📄', gitkeep: '👁',
  };
  return map[ext] ?? '📄';
}

// ─── Dosya ağacı ──────────────────────────────────────────────────────────────

interface FolderNode { name: string; path: string; files: IFile[] }

function buildFileTree(files: IFile[]) {
  const rootFiles: IFile[] = [];
  const folderMap = new Map<string, FolderNode>();

  for (const file of files) {
    if (file.name === '.gitkeep') {
      const fp = file.path.replace('/.gitkeep', '');
      if (!folderMap.has(fp)) folderMap.set(fp, { name: fp.split('/').pop() ?? fp, path: fp, files: [] });
      continue;
    }
    const segs = file.path.split('/');
    if (segs.length === 1) {
      rootFiles.push(file);
    } else {
      const fp = segs.slice(0, -1).join('/');
      if (!folderMap.has(fp)) folderMap.set(fp, { name: segs[0] ?? fp, path: fp, files: [] });
      folderMap.get(fp)!.files.push(file);
    }
  }
  return { rootFiles, folders: Array.from(folderMap.values()).sort((a, b) => a.name.localeCompare(b.name)) };
}

// ─── Context Menu ─────────────────────────────────────────────────────────────

interface CtxItem { icon: string; label: string; danger?: boolean; onPress: () => void }

function ContextMenu({
  visible, x, y, items, onClose, S,
}: {
  visible: boolean; x: number; y: number;
  items: CtxItem[]; onClose: () => void;
  S: ReturnType<typeof makeStyles>;
}) {
  if (!visible) return null;
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <Pressable style={S.ctx.overlay} onPress={onClose} />
      <View style={[S.ctx.menu, { top: y, left: Math.min(x, 200) }]}>
        {items.map((item, i) => (
          <TouchableOpacity
            key={i}
            style={[S.ctx.item, i > 0 && S.ctx.itemBorder]}
            onPress={() => { onClose(); item.onPress(); }}
          >
            <Text style={S.ctx.itemIcon}>{item.icon}</Text>
            <Text style={item.danger ? S.ctx.itemDanger : S.ctx.itemText}>{item.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </Modal>
  );
}

// ─── Girdi Modali (çok amaçlı) ───────────────────────────────────────────────

function InputModal({
  visible, title, subtitle, placeholder, initialValue,
  confirmLabel = 'Tamam', danger = false,
  onConfirm, onCancel, S,
}: {
  visible: boolean; title: string; subtitle?: string;
  placeholder: string; initialValue?: string;
  confirmLabel?: string; danger?: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
  S: ReturnType<typeof makeStyles>;
}) {
  const [value, setValue] = useState(initialValue ?? '');
  useEffect(() => { if (visible) setValue(initialValue ?? ''); }, [visible, initialValue]);

  const submit = () => { if (value.trim()) { onConfirm(value.trim()); } };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={S.mod.overlay} onPress={onCancel} />
      <View style={S.mod.box}>
        <Text style={S.mod.title}>{title}</Text>
        {subtitle ? <Text style={S.mod.subtitle}>{subtitle}</Text> : null}
        <TextInput
          style={S.mod.input}
          value={value}
          onChangeText={setValue}
          placeholder={placeholder}
          placeholderTextColor="#555"
          autoFocus
          autoCapitalize="none"
          selectTextOnFocus
          onSubmitEditing={submit}
          returnKeyType="done"
        />
        <View style={S.mod.row}>
          <TouchableOpacity style={S.mod.btnCancel} onPress={onCancel}>
            <Text style={S.mod.btnCancelText}>İptal</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={danger ? S.mod.btnDanger : S.mod.btnOk}
            onPress={submit}
          >
            <Text style={S.mod.btnOkText}>{confirmLabel}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── Klasör satırı ───────────────────────────────────────────────────────────

function FolderRow({
  folder, activeTabId, onOpenFile, onFolderMenu, onFileMenu, sb,
}: {
  folder: FolderNode; activeTabId: string | null;
  onOpenFile: (f: IFile) => void;
  onFolderMenu: (folder: FolderNode, px: number, py: number) => void;
  onFileMenu: (f: IFile, px: number, py: number) => void;
  sb: ReturnType<typeof makeStyles>['sb'];
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <TouchableOpacity style={[sb.sectionHeader, { flex: 1 }]} onPress={() => setExpanded(v => !v)}>
          <Text style={sb.sectionArrow}>{expanded ? '▾' : '▸'}</Text>
          <Text style={[sb.fileIcon, { marginRight: 2 }]}>📁</Text>
          <Text style={[sb.sectionTitle, { letterSpacing: 0, textTransform: 'none' }]} numberOfLines={1}>
            {folder.name}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={sb.menuBtn}
          hitSlop={8}
          onPress={(e) => {
            const { pageX, pageY } = e.nativeEvent;
            onFolderMenu(folder, pageX, pageY);
          }}
        >
          <Text style={sb.menuBtnText}>⋯</Text>
        </TouchableOpacity>
      </View>
      {expanded && folder.files.map(f => (
        <View key={f.id} style={{ flexDirection: 'row', alignItems: 'center' }}>
          <TouchableOpacity
            style={[sb.fileRow, { paddingLeft: 32, flex: 1 }, f.id === activeTabId && sb.fileRowActive]}
            onPress={() => onOpenFile(f)}
          >
            <Text style={sb.fileIcon}>{getFileIcon(f.name)}</Text>
            <Text style={[sb.fileName, f.id === activeTabId && sb.fileNameActive]} numberOfLines={1}>
              {f.name}
            </Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={sb.menuBtn}
            hitSlop={8}
            onPress={(e) => {
              const { pageX, pageY } = e.nativeEvent;
              onFileMenu(f, pageX, pageY);
            }}
          >
            <Text style={sb.menuBtnText}>⋯</Text>
          </TouchableOpacity>
        </View>
      ))}
      {expanded && folder.files.length === 0 && (
        <View style={[sb.emptyHint, { paddingLeft: 32 }]}>
          <Text style={sb.emptyHintSub}>Boş klasör</Text>
        </View>
      )}
    </>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

function Sidebar({
  projects, activeProject, projectFiles, activeTabId,
  onSelectProject, onOpenFile, onNewFile, onNewProject, onNewFolder,
  onFileMenu, onFolderMenu, onProjectMenu, S,
}: {
  projects: IProject[]; activeProject: IProject | null;
  projectFiles: IFile[]; activeTabId: string | null;
  onSelectProject: (p: IProject) => void;
  onOpenFile: (f: IFile) => void;
  onNewFile: () => void; onNewProject: () => void; onNewFolder: () => void;
  onFileMenu: (f: IFile, px: number, py: number) => void;
  onFolderMenu: (folder: FolderNode, px: number, py: number) => void;
  onProjectMenu: (p: IProject, px: number, py: number) => void;
  S: ReturnType<typeof makeStyles>;
}) {
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const sb = S.sb;
  const { rootFiles, folders } = buildFileTree(projectFiles);
  const hasContent = rootFiles.length > 0 || folders.length > 0;

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
        {/* Projeler bölümü */}
        <TouchableOpacity style={sb.sectionHeader} onPress={() => setProjectsExpanded(v => !v)}>
          <Text style={sb.sectionArrow}>{projectsExpanded ? '▾' : '▸'}</Text>
          <Text style={sb.sectionTitle}>PROJELER</Text>
        </TouchableOpacity>

        {projectsExpanded && projects.map(p => (
          <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TouchableOpacity
              style={[sb.projectRow, { flex: 1 }, activeProject?.id === p.id && sb.projectRowActive]}
              onPress={() => onSelectProject(p)}
            >
              <Text style={sb.projectIcon}>🗂️</Text>
              <Text style={sb.projectName} numberOfLines={1}>{p.name}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={sb.menuBtn}
              hitSlop={8}
              onPress={(e) => {
                const { pageX, pageY } = e.nativeEvent;
                onProjectMenu(p, pageX, pageY);
              }}
            >
              <Text style={sb.menuBtnText}>⋯</Text>
            </TouchableOpacity>
          </View>
        ))}

        {projects.length === 0 && projectsExpanded && (
          <View style={sb.emptyHint}>
            <Text style={sb.emptyHintText}>Proje yok</Text>
            <Text style={sb.emptyHintSub}>+🗂️ ile oluşturun</Text>
          </View>
        )}

        {/* Aktif proje dosya ağacı */}
        {activeProject && (
          <>
            <View style={sb.sectionHeader}>
              <Text style={sb.sectionArrow}>▾</Text>
              <Text style={sb.sectionTitle} numberOfLines={1}>
                {activeProject.name.toUpperCase()}
              </Text>
            </View>

            {folders.map(folder => (
              <FolderRow
                key={folder.path}
                folder={folder}
                activeTabId={activeTabId}
                onOpenFile={onOpenFile}
                onFolderMenu={onFolderMenu}
                onFileMenu={onFileMenu}
                sb={sb}
              />
            ))}

            {rootFiles.map(f => (
              <View key={f.id} style={{ flexDirection: 'row', alignItems: 'center' }}>
                <TouchableOpacity
                  style={[sb.fileRow, { flex: 1 }, f.id === activeTabId && sb.fileRowActive]}
                  onPress={() => onOpenFile(f)}
                >
                  <Text style={sb.fileIcon}>{getFileIcon(f.name)}</Text>
                  <Text style={[sb.fileName, f.id === activeTabId && sb.fileNameActive]} numberOfLines={1}>
                    {f.name}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={sb.menuBtn}
                  hitSlop={8}
                  onPress={(e) => {
                    const { pageX, pageY } = e.nativeEvent;
                    onFileMenu(f, pageX, pageY);
                  }}
                >
                  <Text style={sb.menuBtnText}>⋯</Text>
                </TouchableOpacity>
              </View>
            ))}

            {!hasContent && (
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
  isModified: boolean; canUndo: boolean; canRedo: boolean;
  mode: EditorMode; sidebarOpen: boolean;
  onSave: () => void; onUndo: () => void; onRedo: () => void;
  onToggleSidebar: () => void; onToggleMode: () => void;
  S: ReturnType<typeof makeStyles>;
}) {
  const tb = S.tb;
  return (
    <View style={tb.container}>
      <View style={tb.group}>
        <TouchableOpacity style={[tb.btn, sidebarOpen && tb.btnActive]} onPress={onToggleSidebar}>
          <Text style={tb.btnText}>☰</Text>
        </TouchableOpacity>
      </View>
      <View style={tb.group}>
        <TouchableOpacity style={[tb.btn, !isModified && tb.btnDisabled]} onPress={onSave} disabled={!isModified}>
          <Text style={isModified ? tb.modifiedText : tb.btnText}>💾</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[tb.btn, !canUndo && tb.btnDisabled]} onPress={onUndo} disabled={!canUndo}>
          <Text style={tb.btnText}>↩</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[tb.btn, !canRedo && tb.btnDisabled]} onPress={onRedo} disabled={!canRedo}>
          <Text style={tb.btnText}>↪</Text>
        </TouchableOpacity>
      </View>
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

function EditorTabBar({
  tabs, onSelect, onClose, S,
}: {
  tabs: { id: string; title: string; isModified: boolean; isActive: boolean }[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  S: ReturnType<typeof makeStyles>;
}) {
  const t_ = S.tabBar;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={t_.bar} contentContainerStyle={t_.barContent}>
      {tabs.map(t => (
        <TouchableOpacity key={t.id} style={[t_.tab, t.isActive && t_.tabActive]} onPress={() => onSelect(t.id)}>
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
  fileName, isModified, mode, language, line, col, S,
}: {
  fileName: string; isModified: boolean;
  mode: EditorMode; language: string;
  line: number; col: number;
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
      <Text style={stb.text}>Ln {line} Col {col}</Text>
    </View>
  );
}

// ─── EmptyState ───────────────────────────────────────────────────────────────

function EmptyState({ hasProjects, onNewProject, onNewFile, S }: {
  hasProjects: boolean; onNewProject: () => void; onNewFile: () => void;
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

// ─── Modal durum tipleri ──────────────────────────────────────────────────────

type ModalKind =
  | 'newFile' | 'newProject' | 'newFolder'
  | 'renameFile' | 'copyFile' | 'moveFile'
  | 'renameProject' | 'renameFolder';

interface ModalState {
  kind: ModalKind;
  target?: IFile | IProject | FolderNode;
}

// ─── Context menu hedef tipleri ───────────────────────────────────────────────

interface CtxState {
  visible: boolean;
  x: number; y: number;
  items: CtxItem[];
}

const CTX_CLOSED: CtxState = { visible: false, x: 0, y: 0, items: [] };

// ─── EditorScreen ─────────────────────────────────────────────────────────────

export const EditorScreen: React.FC = () => {
  const { top }    = useSafeAreaInsets();
  const { colors } = useTheme();
  const editor     = useEditorController();
  const editorRef  = useRef<CodeEditorRef>(null);

  const S = useMemo(() => makeStyles(colors), [colors]);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [modal,       setModal]       = useState<ModalState | null>(null);
  const [ctx,         setCtx]         = useState<CtxState>(CTX_CLOSED);

  // Cursor pozisyonu (CM6'dan gelir)
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorCol,  setCursorCol]  = useState(1);

  // ── Context menu açıcılar ─────────────────────────────────────────────────

  const openFileMenu = useCallback((file: IFile, px: number, py: number) => {
    setCtx({
      visible: true, x: px, y: py,
      items: [
        {
          icon: '✏️', label: 'Yeniden Adlandır',
          onPress: () => setModal({ kind: 'renameFile', target: file }),
        },
        {
          icon: '📋', label: 'Kopyala',
          onPress: () => setModal({ kind: 'copyFile', target: file }),
        },
        {
          icon: '📂', label: 'Taşı',
          onPress: () => setModal({ kind: 'moveFile', target: file }),
        },
        {
          icon: '🗑️', label: 'Sil', danger: true,
          onPress: () => {
            Alert.alert('Dosyayı Sil', `"${file.name}" silinsin mi?`, [
              { text: 'İptal', style: 'cancel' },
              { text: 'Sil', style: 'destructive', onPress: () => editor.deleteFile(file) },
            ]);
          },
        },
      ],
    });
  }, [editor]);

  const openFolderMenu = useCallback((folder: FolderNode, px: number, py: number) => {
    setCtx({
      visible: true, x: px, y: py,
      items: [
        {
          icon: '✏️', label: 'Yeniden Adlandır',
          onPress: () => setModal({ kind: 'renameFolder', target: folder }),
        },
        {
          icon: '🗑️', label: 'Klasörü Sil', danger: true,
          onPress: () => {
            Alert.alert(
              'Klasörü Sil',
              `"${folder.name}" ve içindeki tüm dosyalar silinsin mi?`,
              [
                { text: 'İptal', style: 'cancel' },
                { text: 'Sil', style: 'destructive', onPress: () => editor.deleteFolder(folder.path) },
              ],
            );
          },
        },
      ],
    });
  }, [editor]);

  const openProjectMenu = useCallback((project: IProject, px: number, py: number) => {
    setCtx({
      visible: true, x: px, y: py,
      items: [
        {
          icon: '✏️', label: 'Yeniden Adlandır',
          onPress: () => setModal({ kind: 'renameProject', target: project }),
        },
        {
          icon: '🗑️', label: 'Projeyi Sil', danger: true,
          onPress: () => {
            Alert.alert(
              'Projeyi Sil',
              `"${project.name}" ve tüm dosyaları kalıcı olarak silinsin mi?`,
              [
                { text: 'İptal', style: 'cancel' },
                { text: 'Sil', style: 'destructive', onPress: () => editor.deleteProject(project) },
              ],
            );
          },
        },
      ],
    });
  }, [editor]);

  // ── Modal onay işleyicileri ───────────────────────────────────────────────

  const handleModalConfirm = useCallback(async (value: string) => {
    if (!modal) return;
    setModal(null);
    const { kind, target } = modal;

    if (kind === 'newFile')      { await editor.newFile(value); return; }
    if (kind === 'newProject')   { await editor.newProject(value); return; }
    if (kind === 'newFolder')    { await editor.newFolder(value); return; }

    if (kind === 'renameFile'   && target) { await editor.renameFile(target as IFile, value); return; }
    if (kind === 'copyFile'     && target) { await editor.copyFile(target as IFile, value); return; }
    if (kind === 'moveFile'     && target) { await editor.moveFile(target as IFile, value); return; }
    if (kind === 'renameProject'&& target) { await editor.renameProject(target as IProject, value); return; }
    if (kind === 'renameFolder' && target) { await editor.renameFolder((target as FolderNode).path, value); return; }
  }, [modal, editor]);

  // ── Sekme kapatma — değişiklik uyarısı ───────────────────────────────────

  const handleCloseTab = useCallback((tabId: string) => {
    const tab = editor.tabs.find(t => t.id === tabId);
    if (tab?.isModified) {
      Alert.alert('Kaydedilmemiş Değişiklik', `"${getFileName(tab.filePath)}" kaydedilmeden kapatılsın mı?`, [
        { text: 'İptal', style: 'cancel' },
        { text: 'Kaydet ve Kapat', onPress: async () => { await editor.saveTab(); editor.closeTab(tabId); } },
        { text: 'Kapat', style: 'destructive', onPress: () => editor.closeTab(tabId) },
      ]);
      return;
    }
    editor.closeTab(tabId);
  }, [editor]);

  // ── MobileKeyboard ────────────────────────────────────────────────────────

  const handleToken  = useCallback((t: string) => editorRef.current?.insertAtCursor(t), []);
  const handleAction = useCallback((a: string) => {
    editorRef.current?.moveCursor(a.replace('cursor-', '') as any);
  }, []);

  // ── Editor mode toggle ────────────────────────────────────────────────────

  const toggleMode = useCallback(() => {
    const modes = [EditorMode.EDIT, EditorMode.READONLY, EditorMode.VIM];
    const idx   = modes.indexOf(editor.mode);
    editor.setMode(modes[(idx + 1) % modes.length]);
  }, [editor]);

  // ── Modal meta hesaplama ──────────────────────────────────────────────────

  const modalMeta = useMemo((): {
    title: string; subtitle?: string; placeholder: string;
    initialValue?: string; confirmLabel?: string; danger?: boolean;
  } | null => {
    if (!modal) return null;
    const { kind, target } = modal;
    switch (kind) {
      case 'newFile':       return { title: 'Yeni Dosya', placeholder: 'index.ts' };
      case 'newProject':    return { title: 'Yeni Proje', placeholder: 'my-project' };
      case 'newFolder':     return { title: 'Yeni Klasör', placeholder: 'utils' };
      case 'renameFile':    return { title: 'Yeniden Adlandır', subtitle: (target as IFile)?.name, placeholder: 'yeni-ad.ts', initialValue: (target as IFile)?.name, confirmLabel: 'Yeniden Adlandır' };
      case 'copyFile':      return { title: 'Kopyala', subtitle: (target as IFile)?.name, placeholder: 'kopya.ts', initialValue: `kopya_${(target as IFile)?.name}`, confirmLabel: 'Kopyala' };
      case 'moveFile':      return { title: 'Klasöre Taşı', subtitle: 'Hedef klasör adı (boş → kök)', placeholder: 'utils', confirmLabel: 'Taşı' };
      case 'renameProject': return { title: 'Projeyi Yeniden Adlandır', placeholder: 'yeni-ad', initialValue: (target as IProject)?.name, confirmLabel: 'Yeniden Adlandır' };
      case 'renameFolder':  return { title: 'Klasörü Yeniden Adlandır', placeholder: 'yeni-klasor', initialValue: (target as FolderNode)?.name, confirmLabel: 'Yeniden Adlandır' };
      default: return null;
    }
  }, [modal]);

  const currentTab = editor.activeTab;
  const language   = currentTab ? getLanguageFromFilePath(currentTab.filePath) : '';
  const tabItems   = editor.tabs.map(t => ({
    id: t.id, title: getFileName(t.filePath),
    isModified: t.isModified, isActive: t.id === editor.activeTabId,
  }));

  return (
    <View style={[S.root, { paddingTop: top }]}>

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

      {tabItems.length > 0 && (
        <EditorTabBar S={S} tabs={tabItems} onSelect={editor.selectTab} onClose={handleCloseTab} />
      )}

      <View style={S.main}>
        {sidebarOpen && (
          <Sidebar
            S={S}
            projects={editor.projects}
            activeProject={editor.activeProject}
            projectFiles={editor.projectFiles}
            activeTabId={editor.activeTabId}
            onSelectProject={editor.openProject}
            onOpenFile={editor.openFile}
            onNewFile={() => setModal({ kind: 'newFile' })}
            onNewProject={() => setModal({ kind: 'newProject' })}
            onNewFolder={() => setModal({ kind: 'newFolder' })}
            onFileMenu={openFileMenu}
            onFolderMenu={openFolderMenu}
            onProjectMenu={openProjectMenu}
          />
        )}

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
              onFocus={() => {}}
              onBlur={() => {}}
              onCursorChange={(l, c) => { setCursorLine(l); setCursorCol(c); }}
            />
          ) : (
            <EmptyState
              S={S}
              hasProjects={editor.projects.length > 0}
              onNewProject={() => setModal({ kind: 'newProject' })}
              onNewFile={() => setModal({ kind: 'newFile' })}
            />
          )}
        </View>
      </View>

      {currentTab && editor.mode !== EditorMode.READONLY && (
        <MobileKeyboard onToken={handleToken} onAction={handleAction} />
      )}

      {currentTab && (
        <EditorStatusBar
          S={S}
          fileName={getFileName(currentTab.filePath)}
          isModified={currentTab.isModified}
          mode={editor.mode}
          language={language}
          line={cursorLine}
          col={cursorCol}
        />
      )}

      {/* Girdi modali */}
      {modalMeta && (
        <InputModal
          S={S}
          visible={!!modal}
          title={modalMeta.title}
          subtitle={modalMeta.subtitle}
          placeholder={modalMeta.placeholder}
          initialValue={modalMeta.initialValue}
          confirmLabel={modalMeta.confirmLabel}
          danger={modalMeta.danger}
          onConfirm={handleModalConfirm}
          onCancel={() => setModal(null)}
        />
      )}

      {/* Context menu */}
      <ContextMenu
        S={S}
        visible={ctx.visible}
        x={ctx.x}
        y={ctx.y}
        items={ctx.items}
        onClose={() => setCtx(CTX_CLOSED)}
      />
    </View>
  );
};
