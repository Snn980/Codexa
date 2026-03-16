/**
 * ui/model/ModelSelector.tsx — Bottom sheet model seçici
 *
 * § 8  : React.memo, useRef
 * § 9  : React Navigation uyumlu (Modal over Stack)
 * Permission durumuna göre modeller gruplandırılır (offline / cloud)
 * Yetersiz izinli modeller → "İzin gerekli" rozetiyle gösterilir
 */

import React, { useCallback, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  FlatList,
  StyleSheet,
  Pressable,
  ListRenderItem,
} from "react-native";

import type { AIModel, AIModelId } from "../../ai/AIModels";
import { AIModelVariant } from "../../ai/AIModels";

// ─── Model öğesi ────────────────────────────────────────────────────────────

interface ModelItemProps {
  model: AIModel;
  isSelected: boolean;
  isAvailable: boolean;
  onSelect: (id: AIModelId) => void;
  onNeedPermission: () => void;
}

const ModelItem = React.memo(({
  model,
  isSelected,
  isAvailable,
  onSelect,
  onNeedPermission,
}: ModelItemProps) => {
  const isOffline = model.variant === AIModelVariant.OFFLINE;

  const handlePress = useCallback(() => {
    if (!isAvailable) {
      onNeedPermission();
    } else {
      onSelect(model.id);
    }
  }, [isAvailable, model.id, onSelect, onNeedPermission]);

  return (
    <TouchableOpacity
      style={[
        styles.modelItem,
        isSelected && styles.modelItemSelected,
        !isAvailable && styles.modelItemDisabled,
      ]}
      onPress={handlePress}
      accessibilityRole="radio"
      accessibilityState={{ checked: isSelected, disabled: !isAvailable }}
    >
      {/* İkon */}
      <View style={[styles.modelIcon, isOffline ? styles.iconOffline : styles.iconCloud]}>
        <Text style={styles.modelIconText}>{isOffline ? "📱" : "☁️"}</Text>
      </View>

      {/* Bilgi */}
      <View style={styles.modelInfo}>
        <View style={styles.modelTitleRow}>
          <Text style={[styles.modelName, !isAvailable && styles.modelNameDisabled]}>
            {model.displayName}
          </Text>
          {isSelected && (
            <View style={styles.selectedBadge}>
              <Text style={styles.selectedBadgeText}>Aktif</Text>
            </View>
          )}
          {!isAvailable && (
            <View style={styles.lockBadge}>
              <Text style={styles.lockBadgeText}>🔒 İzin gerekli</Text>
            </View>
          )}
        </View>
        <Text style={[styles.modelDesc, !isAvailable && styles.modelDescDisabled]}>
          {model.description}
        </Text>
        <Text style={styles.modelLatency}>{model.latencyHint}</Text>
      </View>

      {/* Seçim göstergesi */}
      <View style={[styles.radio, isSelected && styles.radioSelected]}>
        {isSelected && <View style={styles.radioDot} />}
      </View>
    </TouchableOpacity>
  );
});
ModelItem.displayName = "ModelItem";

// ─── Grup başlığı ────────────────────────────────────────────────────────────

const SectionHeader = ({ title }: { title: string }) => (
  <View style={styles.sectionHeader}>
    <Text style={styles.sectionHeaderText}>{title}</Text>
  </View>
);

// ─── ModelSelector ───────────────────────────────────────────────────────────

export interface ModelSelectorProps {
  visible: boolean;
  availableModels: readonly AIModel[];
  selectedModelId: AIModelId | null;
  permissionStatus: string;
  onSelect: (id: AIModelId) => void;
  onClose: () => void;
  onRequestPermissionUpgrade: () => void;
}

type ListItem =
  | { kind: "header"; title: string; key: string }
  | { kind: "model"; model: AIModel; key: string };

export const ModelSelector = ({
  visible,
  availableModels,
  selectedModelId,
  permissionStatus,
  onSelect,
  onClose,
  onRequestPermissionUpgrade,
}: ModelSelectorProps) => {

  // Tüm modelleri offline/cloud olarak grupla
  const listItems = useMemo((): ListItem[] => {
    const offlineModels = availableModels.filter(
      (m) => m.variant === AIModelVariant.OFFLINE,
    );
    const cloudModels = availableModels.filter(
      (m) => m.variant === AIModelVariant.CLOUD,
    );

    const items: ListItem[] = [];

    if (offlineModels.length > 0) {
      items.push({ kind: "header", title: "Offline Modeller", key: "h-offline" });
      offlineModels.forEach((m) =>
        items.push({ kind: "model", model: m, key: m.id }),
      );
    }

    if (cloudModels.length > 0) {
      items.push({ kind: "header", title: "Cloud Modeller", key: "h-cloud" });
      cloudModels.forEach((m) =>
        items.push({ kind: "model", model: m, key: m.id }),
      );
    }

    return items;
  }, [availableModels]);

  const renderItem: ListRenderItem<ListItem> = useCallback(
    ({ item }) => {
      if (item.kind === "header") {
        return <SectionHeader title={item.title} />;
      }
      return (
        <ModelItem
          model={item.model}
          isSelected={item.model.id === selectedModelId}
          isAvailable={true} // availableModels zaten filtreli
          onSelect={onSelect}
          onNeedPermission={onRequestPermissionUpgrade}
        />
      );
    },
    [selectedModelId, onSelect, onRequestPermissionUpgrade],
  );

  const keyExtractor = useCallback((item: ListItem) => item.key, []);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      {/* Backdrop */}
      <Pressable style={styles.backdrop} onPress={onClose} />

      {/* Sheet */}
      <View style={styles.sheet}>
        {/* Sürükleme çubuğu */}
        <View style={styles.handle} />

        {/* Başlık */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Model Seç</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityLabel="Kapat">
            <Text style={styles.closeBtnText}>✕</Text>
          </TouchableOpacity>
        </View>

        {/* Permission bilgisi */}
        <View style={styles.permissionInfo}>
          <Text style={styles.permissionInfoText}>
            {permissionStatus === "DISABLED" && "⛔ AI devre dışı — Ayarlardan etkinleştir"}
            {permissionStatus === "LOCAL_ONLY" && "📱 Offline mod aktif — Yalnızca cihaz modelleri"}
            {permissionStatus === "CLOUD_ENABLED" && "✅ Cloud modu etkin — Tüm modeller kullanılabilir"}
          </Text>
          {permissionStatus !== "CLOUD_ENABLED" && (
            <TouchableOpacity onPress={onRequestPermissionUpgrade} style={styles.upgradeBtn}>
              <Text style={styles.upgradeBtnText}>Yükselt →</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Model listesi */}
        {availableModels.length === 0 ? (
          <View style={styles.emptyModels}>
            <Text style={styles.emptyModelsText}>
              Kullanılabilir model yok.{"\n"}AI iznini etkinleştir.
            </Text>
          </View>
        ) : (
          <FlatList
            data={listItems}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            contentContainerStyle={styles.listContent}
          />
        )}
      </View>
    </Modal>
  );
};

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  sheet: {
    backgroundColor: "#1e1e2e",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "75%",
    paddingBottom: 32,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#45475a",
    alignSelf: "center",
    marginTop: 10,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#313244",
  },
  headerTitle: {
    color: "#cdd6f4",
    fontSize: 16,
    fontWeight: "600",
  },
  closeBtn: {
    padding: 4,
  },
  closeBtnText: {
    color: "#585868",
    fontSize: 18,
  },
  permissionInfo: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#181825",
    gap: 8,
  },
  permissionInfoText: {
    flex: 1,
    color: "#a6adc8",
    fontSize: 12,
  },
  upgradeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "#4f46e5",
    borderRadius: 8,
  },
  upgradeBtnText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
  listContent: { paddingVertical: 8 },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  sectionHeaderText: {
    color: "#585868",
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  modelItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  modelItemSelected: {
    backgroundColor: "#181825",
  },
  modelItemDisabled: {
    opacity: 0.5,
  },
  modelIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  iconOffline: { backgroundColor: "#1e3a5f" },
  iconCloud: { backgroundColor: "#2d1b5e" },
  modelIconText: { fontSize: 18 },
  modelInfo: { flex: 1 },
  modelTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  modelName: {
    color: "#cdd6f4",
    fontSize: 14,
    fontWeight: "500",
  },
  modelNameDisabled: { color: "#585868" },
  modelDesc: {
    color: "#585868",
    fontSize: 12,
    marginTop: 2,
  },
  modelDescDisabled: { color: "#313244" },
  modelLatency: {
    color: "#45475a",
    fontSize: 11,
    marginTop: 2,
    fontFamily: "monospace",
  },
  selectedBadge: {
    backgroundColor: "#1a3a2a",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  selectedBadgeText: {
    color: "#a6e3a1",
    fontSize: 10,
    fontWeight: "600",
  },
  lockBadge: {
    backgroundColor: "#2a1a1a",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  lockBadgeText: {
    color: "#f38ba8",
    fontSize: 10,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: "#45475a",
    alignItems: "center",
    justifyContent: "center",
  },
  radioSelected: {
    borderColor: "#4f46e5",
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#4f46e5",
  },
  emptyModels: {
    padding: 32,
    alignItems: "center",
  },
  emptyModelsText: {
    color: "#585868",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 22,
  },
});
