/**
 * features/settings/screens/SettingsScreen.tsx
 *
 * Değişiklikler (Tema güncellemesi):
 *   • useTheme() entegrasyonu — hardcoded renkler kaldırıldı
 *   • Görünüm bölümü eklendi: Dark / Light / High Contrast tema seçici
 *   • Tema seçimi anında tüm uygulamaya yansır (ThemeContext üzerinden)
 */

import React, { useState } from 'react';
import {
  View, Text, TextInput, ScrollView, Alert,
  ActivityIndicator, TouchableOpacity, Pressable,
  StyleSheet, Platform,
} from 'react-native';
import { useSafeAreaInsets }   from 'react-native-safe-area-context';
import { useSettings }          from '../hooks/useSettings';
import { SettingsSection }      from '../components/SettingsSection';
import { ToggleRow }            from '../components/ToggleRow';
import { StepperRow }           from '../components/StepperRow';
import { SegmentRow }           from '../components/SegmentRow';
import { InfoRow }              from '../components/InfoRow';
import { AIProviderPreference } from '@/index';
import { useTheme }             from '@/theme';

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// ─── API Key satırı ───────────────────────────────────────────────────────────

function APIKeyRow({
  label, value, placeholder, onChange, hasKey, colors,
}: {
  label: string; value: string; placeholder: string;
  onChange: (v: string) => void; hasKey: boolean;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const [visible, setVisible] = useState(false);
  return (
    <View style={[s.apiRow, { borderBottomColor: colors.separator }]}>
      <View style={s.apiLabelRow}>
        <Text style={[s.rowLabel, { color: colors.text }]}>{label}</Text>
        <View style={[s.keyBadge, { backgroundColor: hasKey ? `${colors.success}20` : `${colors.error}18` }]}>
          <Text style={[s.keyBadgeText, { color: hasKey ? colors.success : colors.error }]}>
            {hasKey ? '● Kayıtlı' : '○ Eksik'}
          </Text>
        </View>
      </View>
      <View style={s.apiInputRow}>
        <TextInput
          style={[s.apiInput, {
            backgroundColor: colors.surface2,
            borderColor: colors.border,
            color: colors.text,
          }]}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
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

// ─── Tema Seçici ──────────────────────────────────────────────────────────────

const THEME_OPTIONS = [
  { label: '🌙 Karanlık',    value: 'dark'           },
  { label: '☀️ Aydınlık',    value: 'light'          },
  { label: '⬛ Y. Kontrast', value: 'high-contrast'  },
] as const;

// ─── SettingsScreen ──────────────────────────────────────────────────────────

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { colors, theme, setTheme } = useTheme();
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
      <View style={[s.center, { flex: 1, backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const providerOptions = [
    { label: 'Otomatik', value: AIProviderPreference.Auto },
    { label: 'Cloud',    value: AIProviderPreference.CloudFirst },
    { label: 'Offline',  value: AIProviderPreference.OfflineFirst },
  ];

  return (
    <View style={[s.container, { backgroundColor: colors.bg, paddingTop: insets.top }]}>

      {/* ── Header ── */}
      <View style={[s.header, { backgroundColor: colors.toolbar, borderBottomColor: colors.border }]}>
        <Text style={[s.headerTitle, { color: colors.text }]}>⚙ Ayarlar</Text>
        <View style={s.headerRight}>
          {saving && (
            <ActivityIndicator size="small" color={colors.muted} style={{ marginRight: 10 }} />
          )}
          <TouchableOpacity onPress={reset} hitSlop={8}>
            <Text style={[s.resetText, { color: colors.muted }]}>Sıfırla</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
      >

        {/* ── Görünüm (Tema) ── */}
        <SettingsSection title="Görünüm">
          <View style={[s.themeRow, { borderBottomColor: colors.separator }]}>
            <Text style={[s.themeLabel, { color: colors.textSecondary }]}>Tema</Text>
            <View style={s.themeOptions}>
              {THEME_OPTIONS.map((opt) => {
                const isActive = theme === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    style={[
                      s.themeBtn,
                      {
                        backgroundColor: isActive ? colors.accent : colors.surface2,
                        borderColor: isActive ? colors.accent : colors.border,
                      },
                    ]}
                    onPress={() => {
                      setTheme(opt.value);
                      save({ theme: opt.value });
                    }}
                    activeOpacity={0.75}
                  >
                    <Text style={[
                      s.themeBtnText,
                      { color: isActive ? '#ffffff' : colors.textSecondary },
                    ]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </SettingsSection>

        {/* ── API Anahtarları ── */}
        <SettingsSection title="API Anahtarları">
          <APIKeyRow
            colors={colors}
            label="Anthropic (Claude)"
            value={anthropicKey}
            placeholder="sk-ant-api03-..."
            onChange={setAnthropicKey}
            hasKey={hasAnthropic}
          />
          <APIKeyRow
            colors={colors}
            label="OpenAI (GPT)"
            value={openaiKey}
            placeholder="sk-proj-..."
            onChange={setOpenaiKey}
            hasKey={hasOpenAI}
          />
          <TouchableOpacity
            style={[
              s.saveBtn,
              { backgroundColor: keysSaved ? colors.success : colors.accent },
            ]}
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
          <View style={[s.providerStatus, { borderTopColor: colors.separator }]}>
            <View style={s.providerItem}>
              <View style={[s.providerDot, { backgroundColor: hasAnthropic ? colors.success : colors.error }]} />
              <Text style={[s.providerLabel, { color: colors.muted }]}>Claude API</Text>
            </View>
            <View style={s.providerItem}>
              <View style={[s.providerDot, { backgroundColor: hasOpenAI ? colors.success : colors.error }]} />
              <Text style={[s.providerLabel, { color: colors.muted }]}>OpenAI API</Text>
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
          <ToggleRow
            label="Otomatik Çalıştır"
            value={settings.autoRun}
            onChange={(v: boolean) => save({ autoRun: v })}
          />
        </SettingsSection>

        {/* ── Hakkında ── */}
        <SettingsSection title="Hakkında">
          <InfoRow label="Versiyon" value="0.2.0" />
          <InfoRow label="Platform" value={Platform.OS === 'ios' ? 'iOS' : 'Android'} />
          <InfoRow label="Expo SDK"  value="55" />
          <InfoRow label="Tema"      value={theme} />
        </SettingsSection>

      </ScrollView>
    </View>
  );
}

// ─── Stiller ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container:     { flex: 1 },
  center:        { alignItems: 'center', justifyContent: 'center' },

  header:        {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitle:   { fontSize: 14, fontWeight: '700', fontFamily: MONO },
  headerRight:   { flexDirection: 'row', alignItems: 'center' },
  resetText:     { fontSize: 12, fontFamily: MONO },

  content:       { padding: 14, gap: 18, paddingBottom: 60 },

  // Tema seçici
  themeRow:      { paddingHorizontal: 14, paddingVertical: 14, gap: 10, borderBottomWidth: 1 },
  themeLabel:    { fontSize: 11, fontFamily: MONO, letterSpacing: 0.3 },
  themeOptions:  { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  themeBtn:      {
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 8, borderWidth: 1,
  },
  themeBtnText:  { fontSize: 12, fontFamily: MONO, fontWeight: '600' },

  // API key
  apiRow:        { paddingHorizontal: 14, paddingVertical: 12, gap: 8, borderBottomWidth: 1 },
  apiLabelRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowLabel:      { fontSize: 12, fontFamily: MONO },
  keyBadge:      { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  keyBadgeText:  { fontSize: 10, fontFamily: MONO, fontWeight: '600' },
  apiInputRow:   { flexDirection: 'row', alignItems: 'center', gap: 8 },
  apiInput:      {
    flex: 1, borderRadius: 8, borderWidth: 1,
    paddingHorizontal: 10, paddingVertical: 8,
    fontSize: 11, fontFamily: MONO,
  },
  eyeBtn:        { padding: 8 },
  eyeText:       { fontSize: 14 },
  saveBtn:       {
    margin: 12, borderRadius: 8,
    paddingVertical: 11, alignItems: 'center',
  },
  saveBtnText:   { fontSize: 13, color: '#fff', fontWeight: '700', fontFamily: MONO },

  // Provider status
  providerStatus: { flexDirection: 'row', paddingHorizontal: 14, paddingVertical: 10, gap: 20, borderTopWidth: 1 },
  providerItem:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  providerDot:    { width: 8, height: 8, borderRadius: 4 },
  providerLabel:  { fontSize: 11, fontFamily: MONO },
});

// ─── SettingsSection sarmalayıcı (renkli) ─────────────────────────────────────

// Not: SettingsSection ve alt bileşenler (ToggleRow, StepperRow vb.)
// kendi stillerinde de tema renklerini kullanması gerekecek.
// Bu dosyada mevcut bileşenler kullanılmaya devam ediyor;
// o bileşenlerin temalı versiyonları ayrı adımda güncellenecek.
