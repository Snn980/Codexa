/**
 * @file     EditorScreen.tsx
 * @module   app/screens
 * @version  1.0.0
 * @since    Phase 1 — App Shell
 *
 * @description
 *   Editör ekranı — TabManager entegrasyonu + CodeMirror 6 placeholder.
 *
 *   Mimari:
 *     ┌─────────────────────────────────────────┐
 *     │  EditorScreen                           │
 *     │  ├── TabStrip (yatay tab listesi)       │
 *     │  ├── EditorPane (CM6 placeholder)       │
 *     │  ├── MobileKeyboard (özel klavye)       │
 *     │  └── StatusBar (dirty/cursor/dil)       │
 *     └─────────────────────────────────────────┘
 *
 *   CodeMirror 6 entegrasyon stratejisi (TODO — Phase 1 tamamlandığında):
 *     Seçenek A: react-native-webview + CM6 HTML bundle
 *       • WebView içinde tam CM6 kurulumu
 *       • postMessage ile iki yönlü iletişim (content, cursor, events)
 *       • Avantaj: CM6'nın tüm özellikleri (extensions, themes)
 *       • Dezavantaj: WebView overhead, keyboard hizalama zorluğu
 *
 *     Seçenek B: Expo DOM Components (Expo SDK 52+)
 *       • <div> gibi native DOM bileşenleri React Native içinde
 *       • CM6 doğrudan DOM'a mount edilir, WebView olmadan
 *       • Avantaj: Daha az bridge, daha iyi performans
 *       • Dezavantaj: Experimental, Expo bağımlılığı
 *
 *     Mevcut durum: CodeMirrorPlaceholder — stateless textarea
 *     Phase 2 başında gerçek entegrasyon yapılacak.
 *
 *   EventBus entegrasyonu:
 *     emit "editor:tab:opened"    → TabStrip güncellenir
 *     emit "editor:tab:closed"    → TabStrip güncellenir
 *     emit "editor:tab:focused"   → aktif tab değişir
 *     emit "editor:content:changed" → FileService debounce tetiklenir
 *     emit "file:dirty"           → tab dirty flag
 *     emit "file:saved"           → tab dirty flag temizlenir
 *
 *   TabManager sorumlulukları:
 *     openTab(fileId)   — varsa fokus, yoksa yeni tab + LRU eviction
 *     closeTab(fileId)  — tab kaldırılır, bir sonraki fokus alır
 *     focusTab(fileId)  — aktif tab değişir
 *     getTabs()         — mevcut tab listesi
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppContext }   from "@/app/App";
import { MobileKeyboard } from "@/app/components/MobileKeyboard";
import { StatusBar }      from "@/app/components/StatusBar";
import type { IFile, ITab, UUID } from "@/index";

// ─────────────────────────────────────────────────────────────────────────────
// § 1. EditorScreen
// ─────────────────────────────────────────────────────────────────────────────

export function EditorScreen(): React.ReactElement {
  const insets       = useSafeAreaInsets();
  const { services } = useAppContext();
  const { fileService, eventBus } = services;

  const [tabs,       setTabs]       = useState<ITab[]>([]);
  const [activeFile, setActiveFile] = useState<IFile | null>(null);
  const [content,    setContent]    = useState("");

  // Fix #12: activeFile ref — effect'i yeniden mount etmeden güncel dosyaya erişim
  const activeFileRef   = useRef<IFile | null>(activeFile);
  activeFileRef.current = activeFile;

  // Content'i EventBus'a emit etmek için debounce ref
  const emitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Tab listesini EventBus'tan yönet ───────────────────────────
  // Not: TabManager servis olarak export edilmediği için
  // şimdilik in-memory state ile çalışıyoruz.
  // Phase 2'de TabManager.getTabs() + reaktif EventBus entegrasyonu gelecek.

  useEffect(() => {
    const u1 = eventBus.on("editor:tab:opened", async ({ file }) => {
      // Dosya içeriğini yükle
      const result = await fileService.getFile(file.id);
      if (result.ok) {
        setActiveFile(result.data);
        setContent(result.data.content);
      }

      setTabs(prev => {
        const exists = prev.find(t => t.fileId === file.id);
        if (exists) {
          // Fokus değiştir
          return prev.map(t => ({ ...t, isActive: t.fileId === file.id }));
        }
        // Yeni tab ekle
        const newTab: ITab = {
          id:       (file.id + "_tab") as import("../../types/core").UUID,
          fileId:   file.id as import("../../types/core").UUID,
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
        const filtered  = prev.filter(t => t.fileId !== fileId);
        // Kapatılan aktif tab ise bir öncekini aktif yap
        const wasActive = prev.find(t => t.fileId === fileId)?.isActive ?? false;
        if (wasActive && filtered.length > 0) {
          const last = filtered.length - 1;
          return filtered.map((t, i) => ({ ...t, isActive: i === last }));
        }
        return filtered;
      });
      if (activeFileRef.current?.id === fileId) {
        setActiveFile(null);
        setContent("");
      }
    });

    const u3 = eventBus.on("file:dirty", ({ fileId, isDirty }) => {
      setTabs(prev => prev.map(t =>
        t.fileId === fileId ? { ...t, isDirty } : t,
      ));
    });

    const u4 = eventBus.on("file:saved", ({ file }) => {
      setTabs(prev => prev.map(t =>
        t.fileId === file.id ? { ...t, isDirty: false } : t,
      ));
    });

    return () => {
      u1(); u2(); u3(); u4();
      // Fix #3: activeFile değişince bekleyen emit iptal edilir — stale event önlenir
      if (emitTimeoutRef.current) clearTimeout(emitTimeoutRef.current);
    };
    // Fix #12: activeFile?.id deps'ten çıkarıldı — ref üzerinden erişim yeterli
    // subscription boşluğu (detach+reattach arası) riski ortadan kalkar
  }, [eventBus, fileService]);

  // ── İçerik değişimi → FileService + EventBus ───────────────────
  const handleContentChange = useCallback((text: string) => {
    setContent(text);

    if (!activeFile) return;

    // Debounce emit — 300ms sonra EventBus'a bildir
    // FileService kendi debounce'unu yapacak; biz sadece event gönderiyoruz
    if (emitTimeoutRef.current) clearTimeout(emitTimeoutRef.current);
    emitTimeoutRef.current = setTimeout(() => {
      eventBus.emit("editor:content:changed", {
        fileId:  activeFile.id,
        content: text,
        cursor:  { line: 0, column: 0 }, // Placeholder — CM6 gerçek cursor verecek
      });
    }, 300);
  }, [activeFile, eventBus]);

  // ── Tab kapat ───────────────────────────────────────────────────
  const handleCloseTab = useCallback((fileId: UUID) => {
    eventBus.emit("editor:tab:closed", { fileId });
  }, [eventBus]);

  // ── Tab odaklan ─────────────────────────────────────────────────
  const handleFocusTab = useCallback(async (tab: ITab) => {
    const result = await fileService.getFile(tab.fileId);
    if (result.ok) {
      setActiveFile(result.data);
      setContent(result.data.content);
    }
    setTabs(prev => prev.map(t => ({ ...t, isActive: t.fileId === tab.fileId })));
    eventBus.emit("editor:tab:focused", { fileId: tab.fileId });
  }, [fileService, eventBus]);

  // ── MobileKeyboard token enjeksiyonu ───────────────────────────
  const handleKeyboardToken = useCallback((token: string) => {
    setContent(prev => prev + token);
    // Gerçek CM6 entegrasyonunda cursor pozisyonuna insert yapılacak
  }, []);

  // ─────────────────────────────────────────────────────────────────
  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={0}
    >
      {/* Tab şeridi */}
      {tabs.length > 0 && (
        <TabStrip
          tabs={tabs}
          onFocus={handleFocusTab}
          onClose={handleCloseTab}
        />
      )}

      {/* Editör alanı */}
      <View style={styles.editorArea}>
        {activeFile ? (
          <CodeMirrorPlaceholder
            content={content}
            onChange={handleContentChange}
            language={activeFile.type}
          />
        ) : (
          <EmptyEditor />
        )}
      </View>

      {/* Özel mobil klavye */}
      {activeFile && (
        <MobileKeyboard onToken={handleKeyboardToken} />
      )}

      {/* Durum çubuğu */}
      <StatusBar activeFile={activeFile} />
    </KeyboardAvoidingView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2. TabStrip
// ─────────────────────────────────────────────────────────────────────────────

interface TabStripProps {
  tabs:    ITab[];
  onFocus: (tab: ITab) => void;
  onClose: (fileId: UUID) => void;
}

function TabStrip({ tabs, onFocus, onClose }: TabStripProps): React.ReactElement {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.tabStrip}
      contentContainerStyle={styles.tabStripContent}
      bounces={false}
    >
      {tabs.map(tab => (
        <Pressable
          key={tab.id}
          onPress={() => onFocus(tab)}
          style={[styles.tab, tab.isActive && styles.tabActive]}
          accessibilityRole="tab"
          accessibilityState={{ selected: tab.isActive }}
        >
          {/* Dirty nokta */}
          {tab.isDirty && <View style={styles.dirtyDot} />}

          <Text
            style={[styles.tabTitle, tab.isActive && styles.tabTitleActive]}
            numberOfLines={1}
          >
            {tab.title}
          </Text>

          {/* Kapat butonu */}
          <Pressable
            onPress={(e) => { e.stopPropagation?.(); onClose(tab.fileId); }}
            style={styles.closeBtn}
            hitSlop={8}
            accessibilityLabel={`${tab.title} sekmesini kapat`}
          >
            <Text style={styles.closeBtnText}>×</Text>
          </Pressable>
        </Pressable>
      ))}
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3. CodeMirrorPlaceholder
// ─────────────────────────────────────────────────────────────────────────────
// TODO: Phase 2 — react-native-webview + CM6 bundle ile değiştirilecek.
//       Şimdilik: satır numaralı TextInput wrapper.

interface CMPlaceholderProps {
  content:  string;
  onChange: (text: string) => void;
  language: string;
}

function CodeMirrorPlaceholder({ content, onChange, language }: CMPlaceholderProps): React.ReactElement {
  const lines = useMemo(() => content.split("\n").length, [content]);

  return (
    <View style={styles.cm}>
      {/* Satır numaraları */}
      <View style={styles.gutter} pointerEvents="none">
        {Array.from({ length: Math.max(lines, 1) }, (_, i) => (
          <Text key={i} style={styles.lineNo}>{i + 1}</Text>
        ))}
      </View>

      {/* Editör alanı */}
      <View style={styles.cmContent}>
        {/* Dil badge */}
        <View style={styles.cmBadge}>
          <Text style={styles.cmBadgeText}>{language.toUpperCase()} · CM6 Placeholder</Text>
        </View>

        <TextInput
          style={styles.cmInput}
          value={content}
          onChangeText={onChange}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          scrollEnabled={false}
          textAlignVertical="top"
          keyboardType="ascii-capable"
          returnKeyType="default"
        />
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4. EmptyEditor
// ─────────────────────────────────────────────────────────────────────────────

function EmptyEditor(): React.ReactElement {
  return (
    <View style={styles.emptyEditor}>
      <Text style={styles.emptyEditorIcon}>◈</Text>
      <Text style={styles.emptyEditorTitle}>Dosya Açık Değil</Text>
      <Text style={styles.emptyEditorDesc}>
        Projeler sekmesinden bir proje açın{"\n"}veya yeni dosya oluşturun
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5. Stiller
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = {
  bg:        "#0a0e1a",
  surface:   "#0d1117",
  surface2:  "#111827",
  border:    "rgba(255,255,255,0.06)",
  accent:    "#3b82f6",
  text:      "#e2e8f0",
  muted:     "#475569",
  dirty:     "#fbbf24",
  tabActive: "#1e293b",
  lineNo:    "#1e3a5f",
  badge:     "rgba(59,130,246,0.1)",
} as const;

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

const styles = StyleSheet.create({
  container:        { flex: 1, backgroundColor: COLORS.bg },

  // Tab şeridi
  tabStrip:         { maxHeight: 36, backgroundColor: COLORS.surface,
                       borderBottomWidth: 1, borderBottomColor: COLORS.border },
  tabStripContent:  { alignItems: "stretch" },
  tab:              { flexDirection: "row", alignItems: "center", gap: 6,
                       paddingHorizontal: 12, paddingVertical: 8,
                       borderRightWidth: 1, borderRightColor: COLORS.border },
  tabActive:        { backgroundColor: COLORS.tabActive },
  tabTitle:         { fontSize: 11, color: COLORS.muted, fontFamily: MONO, maxWidth: 120 },
  tabTitleActive:   { color: COLORS.text },
  dirtyDot:         { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.dirty },
  closeBtn:         { padding: 2 },
  closeBtnText:     { fontSize: 14, color: COLORS.muted, lineHeight: 16 },

  // Editör
  editorArea:       { flex: 1 },
  cm:               { flex: 1, flexDirection: "row", backgroundColor: COLORS.bg },
  gutter:           { width: 44, backgroundColor: COLORS.surface, paddingTop: 8,
                       alignItems: "flex-end", paddingRight: 8,
                       borderRightWidth: 1, borderRightColor: COLORS.border },
  lineNo:           { fontSize: 11, color: COLORS.lineNo, fontFamily: MONO,
                       lineHeight: 20, paddingVertical: 0 },
  cmContent:        { flex: 1 },
  cmBadge:          { paddingHorizontal: 8, paddingVertical: 3,
                       backgroundColor: COLORS.badge,
                       borderBottomWidth: 1, borderBottomColor: COLORS.border },
  cmBadgeText:      { fontSize: 9, color: COLORS.accent, fontFamily: MONO },
  cmInput:          { flex: 1, padding: 8, color: COLORS.text, fontFamily: MONO,
                       fontSize: 13, lineHeight: 20, backgroundColor: "transparent" },

  // Boş durum
  emptyEditor:      { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  emptyEditorIcon:  { fontSize: 36, color: COLORS.muted },
  emptyEditorTitle: { fontSize: 14, fontWeight: "700", color: COLORS.muted, fontFamily: MONO },
  emptyEditorDesc:  { fontSize: 11, color: COLORS.lineNo, fontFamily: MONO,
                       textAlign: "center", lineHeight: 18 },
});
