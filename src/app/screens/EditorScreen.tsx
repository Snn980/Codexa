/**
 * EditorScreen.tsx — Sidebar + Editör + Yeni Dosya/Proje
 */

import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import {
  Alert, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppContext }   from "@/app/App";
import { MobileKeyboard } from "@/app/components/MobileKeyboard";
import { StatusBar }      from "@/app/components/StatusBar";
import type { IFile, IProject, ITab, UUID } from "@/index";
import { ProjectLanguage, ProjectStatus } from "@/index";

// ─── EditorScreen ─────────────────────────────────────────────────────────────

export function EditorScreen(): React.ReactElement {
  const insets       = useSafeAreaInsets();
  const { services } = useAppContext();
  const { fileService, projectService, eventBus } = services;

  const [tabs,        setTabs]        = useState<ITab[]>([]);
  const [activeFile,  setActiveFile]  = useState<IFile | null>(null);
  const [content,     setContent]     = useState("");
  const [showSidebar, setShowSidebar] = useState(true);
  const [projects,    setProjects]    = useState<IProject[]>([]);
  const [activeProj,  setActiveProj]  = useState<IProject | null>(null);
  const [projFiles,   setProjFiles]   = useState<IFile[]>([]);
  const [showNewFile, setShowNewFile] = useState(false);
  const [showNewProj, setShowNewProj] = useState(false);

  const activeFileRef   = useRef<IFile | null>(activeFile);
  activeFileRef.current = activeFile;
  const emitTimeoutRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Projeleri yükle ──────────────────────────────────────────────
  const loadProjects = useCallback(async () => {
    const r = await projectService.getAllProjects();
    if (r.ok) {
      const active = r.data.filter((p: IProject) => p.status !== ProjectStatus.PendingGC);
      setProjects(active);
      if (!activeProj && active.length > 0) setActiveProj(active[0]);
    }
  }, [projectService, activeProj]);

  // ── Proje dosyalarını yükle ──────────────────────────────────────
  const loadFiles = useCallback(async (proj: IProject) => {
    const r = await fileService.getProjectFiles(proj.id);
    if (r.ok) setProjFiles(r.data);
  }, [fileService]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);

  useEffect(() => {
    if (activeProj) void loadFiles(activeProj);
  }, [activeProj, loadFiles]);

  // ── EventBus ────────────────────────────────────────────────────
  useEffect(() => {
    const u1 = eventBus.on("editor:tab:opened", async ({ file }) => {
      const result = await fileService.getFile(file.id);
      if (result.ok) { setActiveFile(result.data); setContent(result.data.content); }
      setTabs(prev => {
        const exists = prev.find(t => t.fileId === file.id);
        if (exists) return prev.map(t => ({ ...t, isActive: t.fileId === file.id }));
        const newTab: ITab = {
          id:       (file.id + "_tab") as UUID,
          fileId:   file.id as UUID,
          title:    file.name,
          isActive: true,
          isDirty:  false,
          openedAt: Date.now(),
        };
        return [...prev.map(t => ({ ...t, isActive: false })), newTab];
      });
    });
    const u2 = eventBus.on("editor:tab:closed", ({ fileId }) => {
      setTabs(prev => {
        const filtered = prev.filter(t => t.fileId !== fileId);
        const wasActive = prev.find(t => t.fileId === fileId)?.isActive ?? false;
        if (wasActive && filtered.length > 0) {
          return filtered.map((t, i) => ({ ...t, isActive: i === filtered.length - 1 }));
        }
        return filtered;
      });
      if (activeFileRef.current?.id === fileId) { setActiveFile(null); setContent(""); }
    });
    const u3 = eventBus.on("file:dirty",  ({ fileId, isDirty }) =>
      setTabs(prev => prev.map(t => t.fileId === fileId ? { ...t, isDirty } : t)));
    const u4 = eventBus.on("file:saved",  ({ file }) =>
      setTabs(prev => prev.map(t => t.fileId === file.id ? { ...t, isDirty: false } : t)));
    const u5 = eventBus.on("project:created", () => void loadProjects());

    return () => { u1(); u2(); u3(); u4(); u5();
      if (emitTimeoutRef.current) clearTimeout(emitTimeoutRef.current); };
  }, [eventBus, fileService, loadProjects]);

  // ── Dosya aç ────────────────────────────────────────────────────
  const openFile = useCallback(async (file: IFile) => {
    const result = await fileService.getFile(file.id);
    if (!result.ok) return;
    setActiveFile(result.data);
    setContent(result.data.content);
    setTabs(prev => {
      const exists = prev.find(t => t.fileId === file.id);
      if (exists) return prev.map(t => ({ ...t, isActive: t.fileId === file.id }));
      const newTab: ITab = {
        id: (file.id + "_tab") as UUID, fileId: file.id as UUID,
        title: file.name, isActive: true, isDirty: false, openedAt: Date.now(),
      };
      return [...prev.map(t => ({ ...t, isActive: false })), newTab];
    });
    eventBus.emit("editor:tab:opened", { file });
  }, [fileService, eventBus]);

  // ── İçerik değişimi ─────────────────────────────────────────────
  const handleContentChange = useCallback((text: string) => {
    setContent(text);
    if (!activeFile) return;
    if (emitTimeoutRef.current) clearTimeout(emitTimeoutRef.current);
    emitTimeoutRef.current = setTimeout(() => {
      eventBus.emit("editor:content:changed", {
        fileId: activeFile.id, content: text, cursor: { line: 0, column: 0 },
      });
    }, 300);
  }, [activeFile, eventBus]);

  const handleCloseTab = useCallback((fileId: UUID) =>
    eventBus.emit("editor:tab:closed", { fileId }), [eventBus]);

  const handleFocusTab = useCallback(async (tab: ITab) => {
    const result = await fileService.getFile(tab.fileId);
    if (result.ok) { setActiveFile(result.data); setContent(result.data.content); }
    setTabs(prev => prev.map(t => ({ ...t, isActive: t.fileId === tab.fileId })));
  }, [fileService]);

  const handleKeyboardToken = useCallback((token: string) =>
    setContent(prev => prev + token), []);

  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {/* Toolbar */}
      <View style={styles.toolbar}>
        <TouchableOpacity onPress={() => setShowSidebar(v => !v)} style={styles.toolBtn}>
          <Text style={styles.toolBtnText}>☰</Text>
        </TouchableOpacity>
        <Text style={styles.toolbarTitle}>
          {activeFile ? activeFile.name : "Editör"}
        </Text>
        <TouchableOpacity onPress={() => setShowNewFile(true)} style={styles.toolBtn}>
          <Text style={styles.toolBtnText}>＋</Text>
        </TouchableOpacity>
      </View>

      {/* Tab şeridi */}
      {tabs.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          style={styles.tabStrip} contentContainerStyle={styles.tabStripContent}>
          {tabs.map(tab => (
            <Pressable key={tab.id} onPress={() => handleFocusTab(tab)}
              style={[styles.tab, tab.isActive && styles.tabActive]}>
              {tab.isDirty && <View style={styles.dirtyDot} />}
              <Text style={[styles.tabTitle, tab.isActive && styles.tabTitleActive]}
                numberOfLines={1}>{tab.title}</Text>
              <Pressable onPress={() => handleCloseTab(tab.fileId)}
                style={styles.closeBtn} hitSlop={8}>
                <Text style={styles.closeBtnText}>×</Text>
              </Pressable>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <View style={styles.body}>
        {/* Sidebar */}
        {showSidebar && (
          <View style={styles.sidebar}>
            {/* Proje seçici */}
            <View style={styles.sidebarHeader}>
              <Text style={styles.sidebarTitle}>PROJELER</Text>
              <TouchableOpacity onPress={() => setShowNewProj(true)}>
                <Text style={styles.sidebarAction}>＋</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.projList}>
              {projects.map(p => (
                <TouchableOpacity key={p.id}
                  style={[styles.projItem, activeProj?.id === p.id && styles.projItemActive]}
                  onPress={() => setActiveProj(p)}>
                  <Text style={styles.projIcon}>📁</Text>
                  <Text style={[styles.projName, activeProj?.id === p.id && styles.projNameActive]}
                    numberOfLines={1}>{p.name}</Text>
                </TouchableOpacity>
              ))}
              {projects.length === 0 && (
                <Text style={styles.emptyHint}>Proje yok{"\n"}＋ ile ekle</Text>
              )}
            </ScrollView>

            {/* Dosya listesi */}
            {activeProj && (
              <>
                <View style={styles.sidebarHeader}>
                  <Text style={styles.sidebarTitle}>DOSYALAR</Text>
                  <TouchableOpacity onPress={() => setShowNewFile(true)}>
                    <Text style={styles.sidebarAction}>＋</Text>
                  </TouchableOpacity>
                </View>
                <ScrollView style={styles.fileList}>
                  {projFiles.map(f => (
                    <TouchableOpacity key={f.id} style={[styles.fileItem,
                      activeFile?.id === f.id && styles.fileItemActive]}
                      onPress={() => openFile(f)}>
                      <Text style={styles.fileIcon}>{fileIcon(f.type)}</Text>
                      <Text style={[styles.fileName,
                        activeFile?.id === f.id && styles.fileNameActive]}
                        numberOfLines={1}>{f.name}</Text>
                    </TouchableOpacity>
                  ))}
                  {projFiles.length === 0 && (
                    <Text style={styles.emptyHint}>Dosya yok{"\n"}＋ ile ekle</Text>
                  )}
                </ScrollView>
              </>
            )}
          </View>
        )}

        {/* Editör alanı */}
        <View style={styles.editorArea}>
          {activeFile ? (
            <CodeEditor content={content} onChange={handleContentChange} language={activeFile.type} />
          ) : (
            <EmptyEditor onNewFile={() => setShowNewFile(true)} onNewProj={() => setShowNewProj(true)} />
          )}
        </View>
      </View>

      {activeFile && <MobileKeyboard onToken={handleKeyboardToken} />}
      <StatusBar activeFile={activeFile} />

      {/* Yeni Dosya Modal */}
      <NewFileModal
        visible={showNewFile}
        project={activeProj}
        onClose={() => setShowNewFile(false)}
        onCreate={async (name, type) => {
          if (!activeProj) { Alert.alert("Hata", "Önce bir proje seçin"); return; }
          // type → FileType enum değeri ve uzantı
          const TYPE_MAP: Record<string, { ext: string; fileType: string }> = {
            typescript: { ext: "ts",  fileType: "typescript" },
            javascript: { ext: "js",  fileType: "javascript" },
            python:     { ext: "py",  fileType: "unknown" },
            markdown:   { ext: "md",  fileType: "md" },
            text:       { ext: "txt", fileType: "txt" },
            html:       { ext: "html",fileType: "html" },
            css:        { ext: "css", fileType: "css" },
            json:       { ext: "json",fileType: "json" },
          };
          const mapped = TYPE_MAP[type] ?? { ext: type, fileType: "unknown" };
          const ext = name.includes(".") ? "" : `.${mapped.ext}`;
          const finalName = name + ext;
          const ts = Date.now();
          const uniquePath = `/${activeProj.id.slice(0,8)}/${ts}_${finalName}`;
          const r = await fileService.createFile({
            projectId: activeProj.id as UUID,
            name: finalName,
            path: uniquePath,
            content: "",
            type: mapped.fileType as any,
          });
          if (!r.ok) { Alert.alert("Hata", r.error.message); return; }
          await loadFiles(activeProj);
          await openFile(r.data);
          setShowNewFile(false);
        }}
      />

      {/* Yeni Proje Modal */}
      <NewProjectModal
        visible={showNewProj}
        onClose={() => setShowNewProj(false)}
        onCreate={async (name) => {
          const r = await projectService.createProject({
            name, language: ProjectLanguage.TypeScript, description: "",
          });
          if (!r.ok) { Alert.alert("Hata", r.error.message); return; }
          eventBus.emit("project:created", { project: r.data });
          await loadProjects();
          setActiveProj(r.data);
          setShowNewProj(false);
        }}
      />
    </KeyboardAvoidingView>
  );
}

// ─── Yardımcı fonksiyon ───────────────────────────────────────────────────────

function fileIcon(type: string): string {
  if (type === "typescript" || type === "ts" || type === "tsx") return "📘";
  if (type === "javascript" || type === "js" || type === "jsx") return "📒";
  if (type === "python" || type === "py") return "🐍";
  if (type === "json") return "📋";
  if (type === "markdown" || type === "md") return "📝";
  if (type === "html") return "🌐";
  if (type === "css") return "🎨";
  return "📄";
}

// ─── CodeEditor ───────────────────────────────────────────────────────────────

function CodeEditor({ content, onChange, language }: {
  content: string; onChange: (t: string) => void; language: string;
}): React.ReactElement {
  const lines = useMemo(() => content.split("\n").length, [content]);
  return (
    <View style={styles.cm}>
      <View style={styles.gutter} pointerEvents="none">
        {Array.from({ length: Math.max(lines, 1) }, (_, i) => (
          <Text key={i} style={styles.lineNo}>{i + 1}</Text>
        ))}
      </View>
      <View style={styles.cmContent}>
        <View style={styles.cmBadge}>
          <Text style={styles.cmBadgeText}>{language.toUpperCase()}</Text>
        </View>
        <TextInput
          style={styles.cmInput} value={content} onChangeText={onChange}
          multiline autoCapitalize="none" autoCorrect={false} spellCheck={false}
          scrollEnabled={false} textAlignVertical="top" keyboardType="ascii-capable"
        />
      </View>
    </View>
  );
}

// ─── EmptyEditor ─────────────────────────────────────────────────────────────

function EmptyEditor({ onNewFile, onNewProj }: {
  onNewFile: () => void; onNewProj: () => void;
}): React.ReactElement {
  return (
    <View style={styles.emptyEditor}>
      <Text style={styles.emptyIcon}>◈</Text>
      <Text style={styles.emptyTitle}>Dosya Açık Değil</Text>
      <TouchableOpacity style={styles.emptyBtn} onPress={onNewProj}>
        <Text style={styles.emptyBtnText}>＋ Yeni Proje</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.emptyBtn} onPress={onNewFile}>
        <Text style={styles.emptyBtnText}>＋ Yeni Dosya</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── NewFileModal ─────────────────────────────────────────────────────────────

function NewFileModal({ visible, project, onClose, onCreate }: {
  visible: boolean; project: IProject | null;
  onClose: () => void; onCreate: (name: string, type: string) => void;
}): React.ReactElement {
  const [name, setName] = useState("");
  const [type, setType] = useState("typescript");
  const types = ["typescript","javascript","python","json","markdown","html","css","text"];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modal}>
          <Text style={styles.modalTitle}>Yeni Dosya</Text>
          {project && <Text style={styles.modalSub}>📁 {project.name}</Text>}
          <TextInput style={styles.modalInput} value={name} onChangeText={setName}
            placeholder="dosya-adı" placeholderTextColor={COLORS.muted}
            autoCapitalize="none" autoCorrect={false} autoFocus />
          <ScrollView horizontal showsHorizontalScrollIndicator={false}
            style={styles.typeList}>
            {types.map(t => (
              <TouchableOpacity key={t} style={[styles.typeBtn, type === t && styles.typeBtnActive]}
                onPress={() => setType(t)}>
                <Text style={[styles.typeBtnText, type === t && styles.typeBtnTextActive]}>{t}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.modalCancel} onPress={onClose}>
              <Text style={styles.modalCancelText}>İptal</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.modalOk}
              onPress={() => { if (name.trim()) onCreate(name.trim(), type); }}>
              <Text style={styles.modalOkText}>Oluştur</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── NewProjectModal ──────────────────────────────────────────────────────────

function NewProjectModal({ visible, onClose, onCreate }: {
  visible: boolean; onClose: () => void; onCreate: (name: string) => void;
}): React.ReactElement {
  const [name, setName] = useState("");
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modal}>
          <Text style={styles.modalTitle}>Yeni Proje</Text>
          <TextInput style={styles.modalInput} value={name} onChangeText={setName}
            placeholder="proje-adı" placeholderTextColor={COLORS.muted}
            autoCapitalize="none" autoCorrect={false} autoFocus />
          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.modalCancel} onPress={onClose}>
              <Text style={styles.modalCancelText}>İptal</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.modalOk}
              onPress={() => { if (name.trim()) onCreate(name.trim()); }}>
              <Text style={styles.modalOkText}>Oluştur</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Stiller ─────────────────────────────────────────────────────────────────

const COLORS = {
  bg:       "#0a0e1a", surface: "#0d1117", surface2: "#111827",
  border:   "rgba(255,255,255,0.06)", accent: "#3b82f6",
  text:     "#e2e8f0", muted: "#475569", dirty: "#fbbf24",
  tabActive:"#1e293b", lineNo: "#1e3a5f",
} as const;

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

const styles = StyleSheet.create({
  root:             { flex: 1, backgroundColor: COLORS.bg },
  toolbar:          { flexDirection: "row", alignItems: "center",
                       paddingHorizontal: 8, paddingVertical: 8,
                       borderBottomWidth: 1, borderBottomColor: COLORS.border,
                       backgroundColor: COLORS.surface },
  toolBtn:          { padding: 6, minWidth: 36, alignItems: "center" },
  toolBtnText:      { fontSize: 18, color: COLORS.text },
  toolbarTitle:     { flex: 1, fontSize: 13, color: COLORS.text, fontFamily: MONO,
                       textAlign: "center" },
  tabStrip:         { maxHeight: 36, backgroundColor: COLORS.surface,
                       borderBottomWidth: 1, borderBottomColor: COLORS.border },
  tabStripContent:  { alignItems: "stretch" },
  tab:              { flexDirection: "row", alignItems: "center", gap: 6,
                       paddingHorizontal: 12, paddingVertical: 8,
                       borderRightWidth: 1, borderRightColor: COLORS.border },
  tabActive:        { backgroundColor: COLORS.tabActive },
  tabTitle:         { fontSize: 11, color: COLORS.muted, fontFamily: MONO, maxWidth: 100 },
  tabTitleActive:   { color: COLORS.text },
  dirtyDot:         { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.dirty },
  closeBtn:         { padding: 2 },
  closeBtnText:     { fontSize: 14, color: COLORS.muted },
  body:             { flex: 1, flexDirection: "row" },
  sidebar:          { width: 160, backgroundColor: COLORS.surface,
                       borderRightWidth: 1, borderRightColor: COLORS.border },
  sidebarHeader:    { flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                       paddingHorizontal: 8, paddingVertical: 6,
                       borderBottomWidth: 1, borderBottomColor: COLORS.border },
  sidebarTitle:     { fontSize: 9, color: COLORS.muted, fontFamily: MONO,
                       letterSpacing: 0.8, textTransform: "uppercase" },
  sidebarAction:    { fontSize: 16, color: COLORS.accent },
  projList:         { maxHeight: 120 },
  fileList:         { flex: 1 },
  projItem:         { flexDirection: "row", alignItems: "center", gap: 6,
                       paddingHorizontal: 8, paddingVertical: 7 },
  projItemActive:   { backgroundColor: "rgba(59,130,246,0.1)" },
  projIcon:         { fontSize: 12 },
  projName:         { fontSize: 11, color: COLORS.muted, fontFamily: MONO, flex: 1 },
  projNameActive:   { color: COLORS.accent },
  fileItem:         { flexDirection: "row", alignItems: "center", gap: 6,
                       paddingHorizontal: 8, paddingVertical: 6 },
  fileItemActive:   { backgroundColor: "rgba(59,130,246,0.08)" },
  fileIcon:         { fontSize: 11 },
  fileName:         { fontSize: 11, color: COLORS.muted, fontFamily: MONO, flex: 1 },
  fileNameActive:   { color: COLORS.text },
  emptyHint:        { fontSize: 10, color: COLORS.muted, fontFamily: MONO,
                       textAlign: "center", padding: 12, lineHeight: 16 },
  editorArea:       { flex: 1 },
  cm:               { flex: 1, flexDirection: "row", backgroundColor: COLORS.bg },
  gutter:           { width: 40, backgroundColor: COLORS.surface, paddingTop: 8,
                       alignItems: "flex-end", paddingRight: 6,
                       borderRightWidth: 1, borderRightColor: COLORS.border },
  lineNo:           { fontSize: 11, color: COLORS.lineNo, fontFamily: MONO, lineHeight: 20 },
  cmContent:        { flex: 1 },
  cmBadge:          { paddingHorizontal: 8, paddingVertical: 3,
                       backgroundColor: "rgba(59,130,246,0.08)",
                       borderBottomWidth: 1, borderBottomColor: COLORS.border },
  cmBadgeText:      { fontSize: 9, color: COLORS.accent, fontFamily: MONO },
  cmInput:          { flex: 1, padding: 8, color: COLORS.text, fontFamily: MONO,
                       fontSize: 13, lineHeight: 20, backgroundColor: "transparent" },
  emptyEditor:      { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  emptyIcon:        { fontSize: 36, color: COLORS.muted },
  emptyTitle:       { fontSize: 14, fontWeight: "700", color: COLORS.muted, fontFamily: MONO },
  emptyBtn:         { paddingHorizontal: 20, paddingVertical: 10,
                       backgroundColor: COLORS.accent, borderRadius: 8 },
  emptyBtnText:     { fontSize: 13, color: "#fff", fontFamily: MONO },
  modalOverlay:     { flex: 1, backgroundColor: "rgba(0,0,0,0.7)",
                       justifyContent: "flex-end" },
  modal:            { backgroundColor: COLORS.surface2, borderTopLeftRadius: 16,
                       borderTopRightRadius: 16, padding: 20, gap: 12 },
  modalTitle:       { fontSize: 16, fontWeight: "700", color: COLORS.text, fontFamily: MONO },
  modalSub:         { fontSize: 12, color: COLORS.muted, fontFamily: MONO },
  modalInput:       { backgroundColor: COLORS.surface, borderRadius: 8,
                       borderWidth: 1, borderColor: COLORS.border,
                       paddingHorizontal: 12, paddingVertical: 10,
                       fontSize: 14, color: COLORS.text, fontFamily: MONO },
  typeList:         { maxHeight: 40 },
  typeBtn:          { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6,
                       backgroundColor: COLORS.surface, marginRight: 6,
                       borderWidth: 1, borderColor: COLORS.border },
  typeBtnActive:    { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  typeBtnText:      { fontSize: 11, color: COLORS.muted, fontFamily: MONO },
  typeBtnTextActive:{ color: "#fff" },
  modalActions:     { flexDirection: "row", gap: 10, paddingTop: 4 },
  modalCancel:      { flex: 1, paddingVertical: 12, borderRadius: 8,
                       backgroundColor: COLORS.surface, alignItems: "center" },
  modalCancelText:  { fontSize: 13, color: COLORS.muted, fontFamily: MONO },
  modalOk:          { flex: 1, paddingVertical: 12, borderRadius: 8,
                       backgroundColor: COLORS.accent, alignItems: "center" },
  modalOkText:      { fontSize: 13, color: "#fff", fontWeight: "700", fontFamily: MONO },
});
