/**
 * SettingsScreen.tsx — Ayarlar + API Key yönetimi
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
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppContext }              from "@/app/App";
import { appContainer }              from "@/app/AppContainer";
import {
  DEFAULT_SETTINGS,
  EditorTheme,
  KeyboardLayout,
  type ISettings,
} from "@/index";

export function SettingsScreen(): React.ReactElement {
  const insets       = useSafeAreaInsets();
  const { services } = useAppContext();
  const { settingsRepository } = services;

  const [settings,    setSettings]    = useState<ISettings>(DEFAULT_SETTINGS);
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey,    setOpenaiKey]    = useState("");
  const [keysSaved,    setKeysSaved]    = useState(false);
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void (async () => {
      const result = await settingsRepository.get();
      if (result.ok) setSettings(result.data);

      // Mevcut API key'leri yükle
      try {
        const ks = appContainer.keyStore;
        const ak = await ks.getKey("anthropic");
        const ok2 = await ks.getKey("openai");
        if (ak) setAnthropicKey(ak);
        if (ok2) setOpenaiKey(ok2);
      } catch { /* keyStore henüz hazır değilse atla */ }

      setLoading(false);
    })();
  }, [settingsRepository]);

  const save = useCallback(async (partial: Partial<ISettings>) => {
    setSettings(prev => ({ ...prev, ...partial }));
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
    saveDebounceRef.current = setTimeout(async () => {
      setSaving(true);
      const result = await settingsRepository.set(partial);
      if (!result.ok) {
        const fresh = await settingsRepository.get();
        if (fresh.ok) setSettings(fresh.data);
      }
      setSaving(false);
    }, 350);
  }, [settingsRepository]);

  const handleReset = useCallback(async () => {
    setSaving(true);
    const result = await settingsRepository.reset();
    if (result.ok) setSettings(DEFAULT_SETTINGS);
    setSaving(false);
  }, [settingsRepository]);

  const handleSaveKeys = useCallback(async () => {
    try {
      const ks = appContainer.keyStore;
      if (anthropicKey.trim()) {
        const r = await ks.setKey("anthropic", anthropicKey.trim());
        if (!r.ok) { 
          Alert.alert("Hata", `Anthropic key: ${r.error?.message ?? 'kaydedilemedi'}`); 
          return; 
        }
      }
      if (openaiKey.trim()) {
        const r = await ks.setKey("openai", openaiKey.trim());
        if (!r.ok) { 
          Alert.alert("Hata", `OpenAI key: ${r.error?.message ?? 'kaydedilemedi'}`); 
          return; 
        }
      }
      // Worker'a key'i gönder (foreground simulate)
      try { appContainer.appStateMgr.simulateStateChange('active'); } catch {}
      setKeysSaved(true);
      setTimeout(() => setKeysSaved(false), 2000);
    } catch (e) {
      Alert.alert("Hata", String(e));
    }
  }, [anthropicKey, openaiKey]);

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={COLORS.accent} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Ayarlar</Text>
        <View style={styles.headerRight}>
          {saving && <ActivityIndicator size="small" color={COLORS.accent} style={{ marginRight: 8 }} />}
          <TouchableOpacity onPress={handleReset}>
            <Text style={styles.resetText}>Sıfırla</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content}>

        {/* ── API Anahtarları ─────────────────────────────────────── */}
        <SettingsSection title="API Anahtarları">
          <View style={styles.apiRow}>
            <Text style={styles.rowLabel}>Anthropic (Claude)</Text>
            <TextInput
              style={styles.apiInput}
              value={anthropicKey}
              onChangeText={setAnthropicKey}
              placeholder="sk-ant-..."
              placeholderTextColor={COLORS.muted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <View style={styles.apiRow}>
            <Text style={styles.rowLabel}>OpenAI (GPT)</Text>
            <TextInput
              style={styles.apiInput}
              value={openaiKey}
              onChangeText={setOpenaiKey}
              placeholder="sk-..."
              placeholderTextColor={COLORS.muted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <TouchableOpacity style={styles.saveBtn} onPress={handleSaveKeys}>
            <Text style={styles.saveBtnText}>
              {keysSaved ? "✓ Kaydedildi" : "Kaydet"}
            </Text>
          </TouchableOpacity>
        </SettingsSection>

        {/* ── Editör ─────────────────────────────────────────────── */}
        <SettingsSection title="Editör">
          <StepperRow
            label="Font Boyutu" value={settings.fontSize}
            min={10} max={24} step={1} format={(v) => `${v}px`}
            onChange={(fontSize) => save({ fontSize })}
          />
          <StepperRow
            label="Satır Yüksekliği" value={settings.lineHeight}
            min={1.0} max={2.5} step={0.1} format={(v) => v.toFixed(1)}
            onChange={(lineHeight) => save({ lineHeight })}
          />
          <StepperRow
            label="Tab Boyutu" value={settings.tabSize}
            min={2} max={8} step={2} format={(v) => `${v} boşluk`}
            onChange={(tabSize) => save({ tabSize })}
          />
          <ToggleRow label="Boşluk Kullan" desc="Tab yerine boşluk karakteri"
            value={settings.insertSpaces} onChange={(insertSpaces) => save({ insertSpaces })} />
          <ToggleRow label="Kelime Kaydırma"
            value={settings.wordWrap} onChange={(wordWrap) => save({ wordWrap })} />
          <ToggleRow label="Satır Numaraları"
            value={settings.showLineNumbers} onChange={(showLineNumbers) => save({ showLineNumbers })} />
          <ToggleRow label="Minimap" desc="Küçük kod haritası (Phase 2)"
            value={settings.showMinimap} onChange={(showMinimap) => save({ showMinimap })} />
        </SettingsSection>

        {/* ── Görünüm ────────────────────────────────────────────── */}
        <SettingsSection title="Görünüm">
          <SegmentRow
            label="Tema"
            options={[
              { label: "Koyu",     value: EditorTheme.Dark },
              { label: "Açık",     value: EditorTheme.Light },
              { label: "Kontrast", value: EditorTheme.HighContrast },
            ]}
            value={settings.theme}
            onChange={(theme) => save({ theme: theme as ISettings["theme"] })}
          />
          <SegmentRow
            label="Klavye"
            options={[
              { label: "Varsayılan", value: KeyboardLayout.Default },
              { label: "Vim",        value: KeyboardLayout.Vim },
            ]}
            value={settings.keyboardLayout}
            onChange={(keyboardLayout) => save({ keyboardLayout: keyboardLayout as ISettings["keyboardLayout"] })}
          />
        </SettingsSection>

        {/* ── Performans ─────────────────────────────────────────── */}
        <SettingsSection title="Performans">
          <StepperRow
            label="Otomatik Kayıt" value={settings.autoSaveInterval / 1000}
            min={1} max={30} step={1} format={(v) => `${v}s`}
            onChange={(v) => save({ autoSaveInterval: v * 1000 })}
          />
          <StepperRow
            label="Maksimum Sekme" value={settings.maxTabs}
            min={2} max={20} step={1} format={(v) => `${v} sekme`}
            onChange={(maxTabs) => save({ maxTabs })}
          />
          <ToggleRow label="Otomatik Çalıştır" desc="Dosya kaydedilince terminal tetiklenir"
            value={settings.autoRun} onChange={(autoRun) => save({ autoRun })} />
        </SettingsSection>

        {/* ── Hakkında ───────────────────────────────────────────── */}
        <SettingsSection title="Hakkında">
          <InfoRow label="Sürüm"      value="0.2.0-alpha" />
          <InfoRow label="Mimari"     value="Offline-First" />
          <InfoRow label="Codexa"   value="Codexa" />
          <InfoRow label="Depolama"   value="SQLite" />
        </SettingsSection>

      </ScrollView>
    </View>
  );
}

// ─── Bileşenler ───────────────────────────────────────────────────────────────

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

function ToggleRow({ label, desc, value, onChange }: { label: string; desc?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowLeft}>
        <Text style={styles.rowLabel}>{label}</Text>
        {desc && <Text style={styles.rowDesc}>{desc}</Text>}
      </View>
      <Switch value={value} onValueChange={onChange}
        trackColor={{ true: COLORS.accent, false: COLORS.border }}
        thumbColor={value ? "#fff" : COLORS.muted} />
    </View>
  );
}

function StepperRow({ label, value, min, max, step, format, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  format: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.stepper}>
        <TouchableOpacity onPress={() => { if (value - step >= min) onChange(parseFloat((value - step).toFixed(2))); }}
          style={styles.stepBtn} disabled={value <= min}>
          <Text style={[styles.stepBtnText, value <= min && styles.stepBtnDisabled]}>−</Text>
        </TouchableOpacity>
        <Text style={styles.stepValue}>{format(value)}</Text>
        <TouchableOpacity onPress={() => { if (value + step <= max) onChange(parseFloat((value + step).toFixed(2))); }}
          style={styles.stepBtn} disabled={value >= max}>
          <Text style={[styles.stepBtnText, value >= max && styles.stepBtnDisabled]}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function SegmentRow({ label, options, value, onChange }: {
  label: string; options: { label: string; value: string }[];
  value: string; onChange: (v: string) => void;
}) {
  return (
    <View style={styles.segmentRow}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.segmentControl}>
        {options.map((opt) => (
          <TouchableOpacity key={opt.value}
            style={[styles.segmentOption, opt.value === value && styles.segmentOptionActive]}
            onPress={() => onChange(opt.value)}>
            <Text style={[styles.segmentText, opt.value === value && styles.segmentTextActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

// ─── Renkler & Stiller ───────────────────────────────────────────────────────

const COLORS = {
  bg:      "#0a0e1a",
  surface: "#0d1117",
  border:  "rgba(255,255,255,0.06)",
  accent:  "#3b82f6",
  text:    "#f1f5f9",
  muted:   "#475569",
  subtle:  "#334155",
  success: "#22c55e",
} as const;

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

const styles = StyleSheet.create({
  container:           { flex: 1, backgroundColor: COLORS.bg },
  center:              { alignItems: "center", justifyContent: "center" },
  header:              { flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                          paddingHorizontal: 16, paddingVertical: 12,
                          borderBottomWidth: 1, borderBottomColor: COLORS.border },
  headerTitle:         { fontSize: 15, fontWeight: "700", color: COLORS.text, fontFamily: MONO },
  headerRight:         { flexDirection: "row", alignItems: "center" },
  resetText:           { fontSize: 12, color: COLORS.muted, fontFamily: MONO },
  content:             { padding: 12, gap: 16, paddingBottom: 40 },
  section:             { gap: 6 },
  sectionTitle:        { fontSize: 10, color: COLORS.muted, fontFamily: MONO,
                          letterSpacing: 0.8, textTransform: "uppercase", paddingLeft: 4 },
  sectionCard:         { backgroundColor: COLORS.surface, borderRadius: 10,
                          borderWidth: 1, borderColor: COLORS.border, overflow: "hidden" },
  row:                 { flexDirection: "row", alignItems: "center", justifyContent: "space-between",
                          paddingHorizontal: 14, paddingVertical: 12,
                          borderBottomWidth: 1, borderBottomColor: COLORS.border },
  rowLeft:             { flex: 1, gap: 2 },
  rowLabel:            { fontSize: 13, color: COLORS.text, fontFamily: MONO },
  rowDesc:             { fontSize: 10, color: COLORS.muted, fontFamily: MONO },
  infoValue:           { fontSize: 12, color: COLORS.muted, fontFamily: MONO },
  stepper:             { flexDirection: "row", alignItems: "center", gap: 8 },
  stepBtn:             { width: 28, height: 28, borderRadius: 6,
                          backgroundColor: "rgba(255,255,255,0.05)",
                          alignItems: "center", justifyContent: "center" },
  stepBtnText:         { fontSize: 16, color: COLORS.text, lineHeight: 20 },
  stepBtnDisabled:     { color: COLORS.subtle },
  stepValue:           { fontSize: 12, color: COLORS.text, fontFamily: MONO,
                          minWidth: 60, textAlign: "center" },
  segmentRow:          { paddingHorizontal: 14, paddingVertical: 10, gap: 8,
                          borderBottomWidth: 1, borderBottomColor: COLORS.border },
  segmentControl:      { flexDirection: "row", backgroundColor: "rgba(0,0,0,0.3)",
                          borderRadius: 8, padding: 3, gap: 2 },
  segmentOption:       { flex: 1, paddingVertical: 6, borderRadius: 6, alignItems: "center" },
  segmentOptionActive: { backgroundColor: COLORS.surface },
  segmentText:         { fontSize: 11, color: COLORS.muted, fontFamily: MONO },
  segmentTextActive:   { color: COLORS.text },
  apiRow:              { paddingHorizontal: 14, paddingVertical: 10, gap: 6,
                          borderBottomWidth: 1, borderBottomColor: COLORS.border },
  apiInput:            { backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 8,
                          borderWidth: 1, borderColor: COLORS.border,
                          paddingHorizontal: 10, paddingVertical: 8,
                          fontSize: 12, color: COLORS.text, fontFamily: MONO },
  saveBtn:             { margin: 14, backgroundColor: COLORS.accent, borderRadius: 8,
                          paddingVertical: 10, alignItems: "center" },
  saveBtnText:         { fontSize: 13, color: "#fff", fontWeight: "700", fontFamily: MONO },
});
