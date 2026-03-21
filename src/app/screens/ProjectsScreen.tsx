/**
 * @file     ProjectsScreen.tsx
 * @module   app/screens
 * @version  1.0.0
 * @since    Phase 1 — App Shell
 *
 * @description
 *   Proje listesi ekranı.
 *
 *   Özellikler:
 *     • RecentProjects.getAll()   — pin'liler + son açılanlar, birleşik liste
 *     • pin / unpin               — uzun basma → context menu
 *     • Yeni proje modal'ı        — isim + dil seçimi → ProjectService.create()
 *     • Proje silme               — swipe-to-delete (sağa kaydır)
 *     • EventBus reaktif          — "project:created/deleted/updated" dinlenir
 *
 *   Servis bağımlılıkları:
 *     ProjectService   — CRUD
 *     RecentProjects   — pin/unpin + sıralı liste (proje manager)
 *     EventBus         — reaktif güncelleme
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppContext }          from "@/app/App";
import {
  ProjectLanguage,
  ProjectStatus,
  type IProject,
  type CreateProjectDto,
} from "@/index";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. Proje satırı tipi — RecentProjects çıktısı (pinned bilgisi ek)
// ─────────────────────────────────────────────────────────────────────────────

interface ProjectRow {
  project: IProject;
  pinned:  boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. ProjectsScreen
// ─────────────────────────────────────────────────────────────────────────────

export function ProjectsScreen(): React.ReactElement {
  const insets          = useSafeAreaInsets();
  const { services }    = useAppContext();
  const { projectService, eventBus } = services;

  const [rows,        setRows]        = useState<ProjectRow[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [showNew,     setShowNew]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  // ── Proje listesini yükle ───────────────────────────────────────
  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);

    const result = await projectService.getAllProjects();
    if (!result.ok) {
      setError(result.error.message);
      setLoading(false);
      return;
    }

    // Aktif projeleri filtrele
    const active = result.data.filter((p: import('../../types/core').IProject) => p.status !== ProjectStatus.PendingGC);

    const mapped: ProjectRow[] = active.map((p: import('../../types/core').IProject) => ({
      project: p,
      pinned:  p.meta?.pinned === true,
    }));

    // Fix #13: tek pass — pin önceliği + updatedAt sıralaması birleştirildi
    mapped.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.project.updatedAt - a.project.updatedAt;
    });

    setRows(mapped);
    setLoading(false);
  }, [projectService]);

  // ── İlk yükleme ────────────────────────────────────────────────
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // ── EventBus — reaktif güncelleme ──────────────────────────────
  useEffect(() => {
    const u1 = eventBus.on("project:created", () => void loadProjects());
    const u2 = eventBus.on("project:updated", () => void loadProjects());
    const u3 = eventBus.on("project:deleted", () => void loadProjects());
    return () => { u1(); u2(); u3(); };
  }, [eventBus, loadProjects]);

  // ── Proje aç ───────────────────────────────────────────────────
  const handleOpen = useCallback(async (project: IProject) => {
    const result = await projectService.openProject(project.id);
    if (!result.ok) {
      Alert.alert("Hata", result.error.message);
    }
    // EventBus "project:opened" → AppNavigator Editor tab'ına geçer
  }, [projectService]);

  // ── Pin / unpin ─────────────────────────────────────────────────
  const handlePin = useCallback(async (project: IProject, pinned: boolean) => {
    const result = await projectService.updateProject(project.id, {
      meta: { ...project.meta, pinned: !pinned },
    });
    if (!result.ok) {
      Alert.alert("Hata", result.error.message);
    }
  }, [projectService]);

  // ── Sil ────────────────────────────────────────────────────────
  const handleDelete = useCallback((project: IProject) => {
    Alert.alert(
      "Projeyi Sil",
      `"${project.name}" kalıcı olarak silinecek.`,
      [
        { text: "İptal", style: "cancel" },
        {
          text: "Sil",
          style: "destructive",
          onPress: async () => {
            const result = await projectService.deleteProject(project.id);
            if (!result.ok) Alert.alert("Hata", result.error.message);
          },
        },
      ],
    );
  }, [projectService]);

  // ── Render ─────────────────────────────────────────────────────
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Projeler</Text>
        <TouchableOpacity
          style={styles.newButton}
          onPress={() => setShowNew(true)}
          accessibilityLabel="Yeni proje oluştur"
        >
          <Text style={styles.newButtonText}>+ Yeni</Text>
        </TouchableOpacity>
      </View>

      {/* Liste */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.accent} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={loadProjects}>
            <Text style={styles.retryText}>Tekrar Dene</Text>
          </TouchableOpacity>
        </View>
      ) : rows.length === 0 ? (
        <EmptyState onNew={() => setShowNew(true)} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.project.id}
          renderItem={({ item }) => (
            <ProjectItem
              row={item}
              onOpen={handleOpen}
              onPin={handlePin}
              onDelete={handleDelete}
            />
          )}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}

      {/* Yeni proje modal */}
      <NewProjectModal
        visible={showNew}
        onClose={() => setShowNew(false)}
        onCreate={async (dto) => {
          const result = await projectService.createProject(dto);
          if (!result.ok) {
            Alert.alert("Hata", result.error.message);
            return;
          }
          setShowNew(false);
        }}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. ProjectItem
// ─────────────────────────────────────────────────────────────────────────────

interface ProjectItemProps {
  row:      ProjectRow;
  onOpen:   (p: IProject) => void;
  onPin:    (p: IProject, pinned: boolean) => void;
  onDelete: (p: IProject) => void;
}

function ProjectItem({ row, onOpen, onPin, onDelete }: ProjectItemProps): React.ReactElement {
  const { project, pinned } = row;

  const langColor = LANG_COLORS[project.language] ?? COLORS.muted;
  const updatedAt = formatRelative(project.updatedAt);

  return (
    <Pressable
      onPress={() => onOpen(project)}
      onLongPress={() => {
        Alert.alert(
          project.name,
          "",
          [
            {
              text: pinned ? "📌 Pin'i Kaldır" : "📌 Sabitle",
              onPress: () => onPin(project, pinned),
            },
            {
              text: "🗑 Sil",
              style: "destructive",
              onPress: () => onDelete(project),
            },
            { text: "İptal", style: "cancel" },
          ],
        );
      }}
      style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
      accessibilityRole="button"
      accessibilityLabel={`${project.name} projesini aç`}
    >
      {/* Sol kenar — dil rengi */}
      <View style={[styles.langBar, { backgroundColor: langColor }]} />

      {/* İçerik */}
      <View style={styles.itemContent}>
        <View style={styles.itemTop}>
          <Text style={styles.itemName} numberOfLines={1}>{project.name}</Text>
          <View style={styles.itemBadges}>
            {pinned && <Text style={styles.pinIcon}>📌</Text>}
            <Text style={[styles.langBadge, { color: langColor }]}>
              {project.language.toUpperCase()}
            </Text>
          </View>
        </View>

        {project.description ? (
          <Text style={styles.itemDesc} numberOfLines={1}>{project.description}</Text>
        ) : null}

        <Text style={styles.itemMeta}>{updatedAt}</Text>
      </View>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. EmptyState
// ─────────────────────────────────────────────────────────────────────────────

function EmptyState({ onNew }: { onNew: () => void }): React.ReactElement {
  return (
    <View style={styles.center}>
      <Text style={styles.emptyIcon}>◈</Text>
      <Text style={styles.emptyTitle}>Henüz proje yok</Text>
      <Text style={styles.emptyDesc}>İlk projenizi oluşturun</Text>
      <TouchableOpacity style={styles.emptyButton} onPress={onNew}>
        <Text style={styles.emptyButtonText}>+ Yeni Proje</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. NewProjectModal
// ─────────────────────────────────────────────────────────────────────────────

interface NewProjectModalProps {
  visible:  boolean;
  onClose:  () => void;
  onCreate: (dto: CreateProjectDto) => Promise<void>;
}

function NewProjectModal({ visible, onClose, onCreate }: NewProjectModalProps): React.ReactElement {
  const [name,     setName]     = useState("");
  const [desc,     setDesc]     = useState("");
  const [lang,     setLang]     = useState<typeof ProjectLanguage[keyof typeof ProjectLanguage]>(ProjectLanguage.JavaScript);
  const [busy,     setBusy]     = useState(false);
  const nameRef = useRef<TextInput>(null);

  // Fix #10: useCallback — alt bileşenlere prop geçildiğinde gereksiz re-render önlenir
  const handleCreate = useCallback(async (): Promise<void> => {
    if (!name.trim()) {
      Alert.alert("Hata", "Proje adı boş olamaz.");
      return;
    }
    setBusy(true);
    await onCreate({ name: name.trim(), language: lang, description: desc.trim(), meta: {} });
    setBusy(false);
    setName(""); setDesc(""); setLang(ProjectLanguage.JavaScript);
  }, [name, lang, desc, onCreate]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.modalOverlay}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>Yeni Proje</Text>

          {/* Ad */}
          <Text style={styles.fieldLabel}>Proje Adı</Text>
          <TextInput
            ref={nameRef}
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="my-project"
            placeholderTextColor={COLORS.placeholder}
            autoFocus
            maxLength={80}
            returnKeyType="next"
          />

          {/* Açıklama */}
          <Text style={styles.fieldLabel}>Açıklama (opsiyonel)</Text>
          <TextInput
            style={styles.input}
            value={desc}
            onChangeText={setDesc}
            placeholder="Kısa açıklama…"
            placeholderTextColor={COLORS.placeholder}
            maxLength={300}
          />

          {/* Dil seçimi */}
          <Text style={styles.fieldLabel}>Dil</Text>
          <View style={styles.langRow}>
            {Object.values(ProjectLanguage).map((l) => (
              <TouchableOpacity
                key={l}
                style={[styles.langOption, lang === l && styles.langOptionActive]}
                onPress={() => setLang(l)}
              >
                <Text style={[styles.langOptionText, lang === l && styles.langOptionTextActive]}>
                  {l.toUpperCase()}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Aksiyon butonları */}
          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.cancelButton} onPress={onClose} disabled={busy}>
              <Text style={styles.cancelText}>İptal</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.createButton, busy && styles.createButtonBusy]}
              onPress={handleCreate}
              disabled={busy}
            >
              {busy
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.createText}>Oluştur</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 6. Yardımcılar
// ─────────────────────────────────────────────────────────────────────────────

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000)           return "Az önce";
  if (diff < 3_600_000)        return `${Math.floor(diff / 60_000)} dk önce`;
  if (diff < 86_400_000)       return `${Math.floor(diff / 3_600_000)} sa önce`;
  return new Date(ts).toLocaleDateString("tr-TR");
}

const LANG_COLORS: Partial<Record<string, string>> = {
  javascript: "#facc15",
  typescript: "#3b82f6",
  jsx:        "#61dafb",
  tsx:        "#7c3aed",
};

// ─────────────────────────────────────────────────────────────────────────────
// § 7. Stiller
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = {
  bg:          "#0a0e1a",
  surface:     "#0d1117",
  surface2:    "#111827",
  border:      "rgba(255,255,255,0.06)",
  accent:      "#3b82f6",
  text:        "#f1f5f9",
  muted:       "#475569",
  error:       "#f87171",
  placeholder: "#334155",
  pressed:     "rgba(255,255,255,0.03)",
} as const;

const styles = StyleSheet.create({
  container:      { flex: 1, backgroundColor: COLORS.bg },
  center:         { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  header:         { flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                    paddingHorizontal: 16, paddingVertical: 12,
                    borderBottomWidth: 1, borderBottomColor: COLORS.border },
  headerTitle:    { fontSize: 15, fontWeight: "700", color: COLORS.text, fontFamily: "monospace" },
  newButton:      { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: COLORS.accent,
                    borderRadius: 6 },
  newButtonText:  { fontSize: 12, color: "#fff", fontWeight: "600", fontFamily: "monospace" },

  list:           { padding: 8 },
  separator:      { height: 1, backgroundColor: COLORS.border, marginHorizontal: 8 },

  item:           { flexDirection: "row", alignItems: "stretch",
                    backgroundColor: COLORS.surface, borderRadius: 8, overflow: "hidden" },
  itemPressed:    { backgroundColor: COLORS.pressed },
  langBar:        { width: 3 },
  itemContent:    { flex: 1, padding: 12, gap: 3 },
  itemTop:        { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  itemName:       { fontSize: 13, fontWeight: "600", color: COLORS.text, fontFamily: "monospace", flex: 1 },
  itemBadges:     { flexDirection: "row", alignItems: "center", gap: 6 },
  pinIcon:        { fontSize: 10 },
  langBadge:      { fontSize: 9, fontFamily: "monospace", fontWeight: "700" },
  itemDesc:       { fontSize: 10, color: COLORS.muted, fontFamily: "monospace" },
  itemMeta:       { fontSize: 9, color: COLORS.placeholder, fontFamily: "monospace" },

  errorText:      { color: COLORS.error, fontFamily: "monospace", fontSize: 12, textAlign: "center" },
  retryText:      { color: COLORS.accent, fontFamily: "monospace", fontSize: 12 },

  emptyIcon:      { fontSize: 32, color: COLORS.muted },
  emptyTitle:     { fontSize: 14, fontWeight: "700", color: COLORS.muted, fontFamily: "monospace" },
  emptyDesc:      { fontSize: 12, color: COLORS.placeholder, fontFamily: "monospace" },
  emptyButton:    { marginTop: 8, paddingHorizontal: 20, paddingVertical: 10,
                    backgroundColor: COLORS.accent, borderRadius: 8 },
  emptyButtonText:{ fontSize: 13, color: "#fff", fontWeight: "600", fontFamily: "monospace" },

  // Modal
  modalOverlay:   { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.6)" },
  modalSheet:     { backgroundColor: COLORS.surface2, borderTopLeftRadius: 16, borderTopRightRadius: 16,
                    padding: 20, gap: 10 },
  modalTitle:     { fontSize: 15, fontWeight: "700", color: COLORS.text, fontFamily: "monospace",
                    marginBottom: 4 },
  fieldLabel:     { fontSize: 10, color: COLORS.muted, fontFamily: "monospace", marginTop: 4 },
  input:          { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border,
                    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
                    color: COLORS.text, fontFamily: "monospace", fontSize: 13 },
  langRow:        { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  langOption:     { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6,
                    borderWidth: 1, borderColor: COLORS.border },
  langOptionActive:     { backgroundColor: "rgba(59,130,246,0.15)", borderColor: "rgba(59,130,246,0.5)" },
  langOptionText:       { fontSize: 11, color: COLORS.muted, fontFamily: "monospace" },
  langOptionTextActive: { color: COLORS.accent },
  modalActions:   { flexDirection: "row", gap: 10, marginTop: 8 },
  cancelButton:   { flex: 1, paddingVertical: 12, borderRadius: 8,
                    borderWidth: 1, borderColor: COLORS.border, alignItems: "center" },
  cancelText:     { color: COLORS.muted, fontFamily: "monospace", fontSize: 13 },
  createButton:   { flex: 1, paddingVertical: 12, borderRadius: 8,
                    backgroundColor: COLORS.accent, alignItems: "center" },
  createButtonBusy: { opacity: 0.6 },
  createText:     { color: "#fff", fontFamily: "monospace", fontSize: 13, fontWeight: "600" },
});
