import React from "react";
import { View, Text, ScrollView, ActivityIndicator, TouchableOpacity } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSettings } from "../hooks/useSettings";
import { SettingsSection } from '../components/SettingsSection';
import { ToggleRow }       from '../components/ToggleRow';
import { StepperRow }      from '../components/StepperRow';          import { SegmentRow }      from '../components/SegmentRow';
import { InfoRow }         from '../components/InfoRow';
import { styles, COLORS } from "../styles";

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const {
    settings,
    loading,
    saving,
    save,
    reset,
    anthropicKey,
    openaiKey,
    setAnthropicKey,
    setOpenaiKey,
    saveKeys,
    keysSaved,
  } = useSettings();

  if (loading) {
    return <ActivityIndicator />;
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Ayarlar</Text>
        <TouchableOpacity onPress={reset}>
          <Text style={styles.resetText}>Sıfırla</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <SettingsSection title="API Anahtarları">
          {/* inputs simplified */}
        </SettingsSection>

        <SettingsSection title="AI Provider"></SettingsSection>

        <SettingsSection title="Editör">
          <StepperRow
            label="Font"
            value={settings.fontSize}
            min={10}
            max={24}
            step={1}
            format={(v: any) => v}
            onChange={(v: any) => save({ fontSize: v })}
          />
          <ToggleRow
            label="Word Wrap"
            value={settings.wordWrap}
            onChange={(v: any) => save({ wordWrap: v })}
          />
        </SettingsSection>

        <SettingsSection title="Hakkında">
          <InfoRow label="Versiyon" value="0.2.0" />
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
