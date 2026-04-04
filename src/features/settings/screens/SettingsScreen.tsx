/**
 * features/settings/screens/SettingsScreen.tsx — Yeniden yazıldı
 *
 * Değişiklikler:
 *   • AI Provider seçici aktif (SegmentRow ile)
 *   • Key göster/gizle toggle
 *   • Kaydet butonu: başarı / hata feedback
 *   • Profesyonel IDE stili
 */

import React, { useState } from 'react';
import {
  View, Text, TextInput, ScrollView, Alert,
  ActivityIndicator, TouchableOpacity, Pressable,
  StyleSheet, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSettings }        from '../hooks/useSettings';
import { SettingsSection }    from '../components/SettingsSection';
import { ToggleRow }          from '../components/ToggleRow';
import { StepperRow }         from '../components/StepperRow';
import { SegmentRow }         from '../components/SegmentRow';
import { InfoRow }            from '../components/InfoRow';
import { AIProviderPreference } from '@/index';

// ─── Tema ─────────────────────────────────────────────────────────────────────

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const C = {
  bg:       '#0a0e1a',
  surface:  '#0d1117',
  surface2: '#111827',
  border:   'rgba(255,255,255,0.07)',
  accent:   '#3b82f6',
  success:  '#22c55e',
  error:    '#f87171',
  text:     '#f1f5f9',
  muted:    '#475569',
  subtle:   '#1e293b',
} as const;

// ─── API Key satırı ───────────────────────────────────────────────────────────

function APIKeyRow({
  label, value, placeholder, onChange, hasKey,
}: {
  label: string; value: string; placeholder: string;
  onChange: (v: string) => void; hasKey: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <View style={s.apiRow}>
      <View style={s.apiLabelRow}>
        <Text style={s.rowLabel}>{label}</Text>
        <View style={[s.keyBadge, hasKey ? s.keyBadgeOk : s.keyBadgeMissing]}>
          <Text style={[s.keyBadgeText, hasKey ? s.keyBadgeTextOk : s.keyBadgeTextMissing]}>
            {hasKey ? '● Kayıtlı' : '○ Eksik'}
          </Text>
        </View>
      </View>
      <View style={s.apiInputRow}>
        <TextInput
          style={s.apiInput}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={C.muted}
          secureTextEntry={!visible}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable style={s.eyeBtn} onPress={() => setVisible(v => !v)}>
          <Text style={s.eyeText}>{visible ? '🙈' : '👁'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─── SettingsScreen ──────────────────────────────────────────────────────────

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const {
    settings, loading, saving,
    save, reset,
    anthropicKey, openaiKey,
    setAnthropicKey, setOpenaiKey,
    saveKeys, keysSaved,
    setProviderPreference,
  } = useSettings();

  const hasAnthropic = anthropicKey.trim().length > 0;
  const hasOpenAI    = openaiKey.trim().length > 0;

  if (loading) {
    return (
      <View style={[s.container, s.center]}>
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }

  const providerOptions = [
    { label: 'Otomatik', value: AIProviderPreference.Auto },
    { label: 'Cloud',    value: AIProviderPreference.CloudFirst },
    { label: 'Offline',  value: AIProviderPreference.OfflineFirst },
  ];

  return (
    <View style={[s.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.headerTitle}>⚙ Ayarlar</Text>
        <View style={s.headerRight}>
          {saving && <ActivityIndicator size="small" color={C.muted} style={{ marginRight: 10 }} />}
          <TouchableOpacity onPress={reset} hitSlop={8}>
            <Text style={s.resetText}>Sıfırla</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>

        {/* ── API Anahtarları ── */}
        <SettingsSection title="API Anahtarları">
          <APIKeyRow
            label="Anthropic (Claude)"
            value={anthropicKey}
            placeholder="sk-ant-api03-..."
            onChange={setAnthropicKey}
            hasKey={hasAnthropic}
          />
          <APIKeyRow
            label="OpenAI (GPT)"
            value={openaiKey}
            placeholder="sk-proj-..."
            onChange={setOpenaiKey}
            hasKey={hasOpenAI}
          />
          <TouchableOpacity
            style={[s.saveBtn, keysSaved && s.saveBtnSuccess]}
            onPress={async () => {
              try { await saveKeys(); }
              catch (e) { Alert.alert('Hata', String(e)); }
            }}
          >
            <Text style={s.saveBtnText}>
              {keysSaved ? '✓ Kaydedildi' : 'Anahtarları Kaydet'}
            </Text>
          </TouchableOpacity>
        </SettingsSection>

        {/* ── AI Provider ── */}
        <SettingsSection title="AI Provider">
          <SegmentRow
            label="Mod"
            options={providerOptions}
            value={settings.providerPreference}
            onChange={(v) => setProviderPreference(v as typeof settings.providerPreference)}
          />
          <View style={s.providerStatus}>
            <View style={s.providerItem}>
              <View style={[s.providerDot, hasAnthropic ? s.dotGreen : s.dotRed]} />
              <Text style={s.providerLabel}>Claude API</Text>
            </View>
            <View style={s.providerItem}>
              <View style={[s.providerDot, hasOpenAI ? s.dotGreen : s.dotRed]} />
              <Text style={s.providerLabel}>OpenAI API</Text>
            </View>
          </View>
        </SettingsSection>

        {/* ── Editör ── */}
        <SettingsSection title="Editör">
          <StepperRow
            label="Font Boyutu"
            value={settings.fontSize}
            min={10}
            max={24}
            step={1}
            format={(v: number) => `${v}px`}
            onChange={(v: number) => save({ fontSize: v })}
          />
          <ToggleRow
            label="Satır Kaydır (Word Wrap)"
            value={settings.wordWrap}
            onChange={(v: boolean) => save({ wordWrap: v })}
          />
        </SettingsSection>

        {/* ── Hakkında ── */}
        <SettingsSection title="Hakkında">
          <InfoRow label="Versiyon" value="0.2.0" />
          <InfoRow label="Platform" value={Platform.OS === 'ios' ? 'iOS' : 'Android'} />
          <InfoRow label="Expo SDK" value="55" />
        </SettingsSection>

      </ScrollView>
    </View>
  );
}

// ─── Stiller ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container:          { flex: 1, backgroundColor: C.bg },
  center:             { alignItems: 'center', justifyContent: 'center' },
  header:             { flexDirection: 'row', alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingHorizontal: 16, paddingVertical: 12,
                        borderBottomWidth: 1, borderBottomColor: C.border,
                        backgroundColor: C.surface },
  headerTitle:        { fontSize: 14, fontWeight: '700', color: C.text, fontFamily: MONO },
  headerRight:        { flexDirection: 'row', alignItems: 'center' },
  resetText:          { fontSize: 12, color: C.muted, fontFamily: MONO },
  content:            { padding: 14, gap: 18, paddingBottom: 50 },

  // API key
  apiRow:             { paddingHorizontal: 14, paddingVertical: 12,
                        gap: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  apiLabelRow:        { flexDirection: 'row', alignItems: 'center',
                        justifyContent: 'space-between' },
  rowLabel:           { fontSize: 12, color: C.text, fontFamily: MONO },
  keyBadge:           { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  keyBadgeOk:         { backgroundColor: 'rgba(34,197,94,0.12)' },
  keyBadgeMissing:    { backgroundColor: 'rgba(248,113,113,0.1)' },
  keyBadgeText:       { fontSize: 10, fontFamily: MONO, fontWeight: '600' },
  keyBadgeTextOk:     { color: '#22c55e' },
  keyBadgeTextMissing:{ color: '#f87171' },
  apiInputRow:        { flexDirection: 'row', alignItems: 'center', gap: 8 },
  apiInput:           { flex: 1, backgroundColor: 'rgba(255,255,255,0.04)',
                        borderRadius: 8, borderWidth: 1, borderColor: C.border,
                        paddingHorizontal: 10, paddingVertical: 8,
                        fontSize: 11, color: C.text, fontFamily: MONO },
  eyeBtn:             { padding: 8 },
  eyeText:            { fontSize: 14 },
  saveBtn:            { margin: 12, backgroundColor: C.accent, borderRadius: 8,
                        paddingVertical: 11, alignItems: 'center' },
  saveBtnSuccess:     { backgroundColor: '#16a34a' },
  saveBtnText:        { fontSize: 13, color: '#fff', fontWeight: '700', fontFamily: MONO },

  // Provider status
  providerStatus:     { flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 10, gap: 20 },
  providerItem:       { flexDirection: 'row', alignItems: 'center', gap: 6 },
  providerDot:        { width: 8, height: 8, borderRadius: 4 },
  dotGreen:           { backgroundColor: '#22c55e' },
  dotRed:             { backgroundColor: '#f87171' },
  providerLabel:      { fontSize: 11, color: C.muted, fontFamily: MONO },
});
