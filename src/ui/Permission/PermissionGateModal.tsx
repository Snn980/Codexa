/**
 * ui/permission/PermissionGateModal.tsx — İzin yükseltme modalı
 *
 * § 14.6 : usePermissionGate entegrasyonu
 *           isTransitioning UI guard, mountedRef unmount koruması, unsub() cleanup
 * § 3    : IEventBus unsub
 *
 * Akış: DISABLED → LOCAL_ONLY → CLOUD_ENABLED
 * Her adım ayrı onay ekranı — cloud için ek veri paylaşımı onayı
 */

import React, { useState, useRef, useCallback, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  Switch,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Pressable,
} from "react-native";

import type { IPermissionGate, PermissionStatus } from "../../permission/PermissionGate";
import type { IEventBus } from "../../core/EventBus";

// ─── Step tanımları ─────────────────────────────────────────────────────────

interface StepConfig {
  title: string;
  icon: string;
  description: string;
  bulletPoints: string[];
  consentLabel: string;
  actionLabel: string;
  targetStatus: PermissionStatus;
}

const STEPS: Record<string, StepConfig> = {
  // DISABLED → LOCAL_ONLY
  enableLocal: {
    title: "Offline AI'yı Etkinleştir",
    icon: "📱",
    description:
      "AI asistan cihazında yerel olarak çalışır. Kodun hiçbir zaman cihaz dışına çıkmaz.",
    bulletPoints: [
      "Tüm işlemler cihazında gerçekleşir",
      "İnternet bağlantısı gerekmez",
      "Model: CodeGemma 2B veya Phi-3 Mini",
      "Yanıt süresi: ~200ms",
    ],
    consentLabel: "Yerel AI özelliğini etkinleştirmeyi kabul ediyorum",
    actionLabel: "Offline AI'yı Etkinleştir",
    targetStatus: "LOCAL_ONLY",
  },
  // LOCAL_ONLY → CLOUD_ENABLED
  enableCloud: {
    title: "Cloud AI'yı Etkinleştir",
    icon: "☁️",
    description:
      "Daha güçlü modeller için kodun seçili dosyaları bulut API'ye gönderilir. Her oturumda ayrıca onay istenir.",
    bulletPoints: [
      "Seçili kod parçaları dışarıya gönderilir",
      ".env ve secret dosyalar otomatik hariç tutulur",
      "API anahtarın güvenli Keychain'de saklanır",
      "İstediğinde devre dışı bırakabilirsin",
    ],
    consentLabel: "Kod parçalarının cloud API'ye gönderilmesini kabul ediyorum",
    actionLabel: "Cloud AI'yı Etkinleştir",
    targetStatus: "CLOUD_ENABLED",
  },
};

// ─── PermissionStep ─────────────────────────────────────────────────────────

interface PermissionStepProps {
  config: StepConfig;
  isTransitioning: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const PermissionStep = ({ config, isTransitioning, onConfirm, onCancel }: PermissionStepProps) => {
  const [consented, setConsented] = useState(false);

  return (
    <View style={styles.stepContainer}>
      {/* İkon */}
      <Text style={styles.stepIcon}>{config.icon}</Text>

      {/* Başlık */}
      <Text style={styles.stepTitle}>{config.title}</Text>

      {/* Açıklama */}
      <Text style={styles.stepDescription}>{config.description}</Text>

      {/* Madde listesi */}
      <View style={styles.bulletList}>
        {config.bulletPoints.map((point, i) => (
          <View key={i} style={styles.bulletRow}>
            <Text style={styles.bulletDot}>•</Text>
            <Text style={styles.bulletText}>{point}</Text>
          </View>
        ))}
      </View>

      {/* Onay toggle */}
      <View style={styles.consentRow}>
        <Switch
          value={consented}
          onValueChange={setConsented}
          trackColor={{ false: "#313244", true: "#4f46e5" }}
          thumbColor={consented ? "#cdd6f4" : "#585868"}
          accessibilityLabel={config.consentLabel}
        />
        <Text style={styles.consentLabel}>{config.consentLabel}</Text>
      </View>

      {/* Butonlar */}
      <View style={styles.btnRow}>
        <TouchableOpacity
          style={styles.cancelBtn}
          onPress={onCancel}
          disabled={isTransitioning}
        >
          <Text style={styles.cancelBtnText}>İptal</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.confirmBtn,
            (!consented || isTransitioning) && styles.confirmBtnDisabled,
          ]}
          onPress={onConfirm}
          disabled={!consented || isTransitioning}
        >
          {isTransitioning ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.confirmBtnText}>{config.actionLabel}</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
};

// ─── PermissionGateModal ────────────────────────────────────────────────────

export interface PermissionGateModalProps {
  visible: boolean;
  permissionGate: IPermissionGate;
  eventBus: IEventBus;
  /** Hangi seviyeye yükseltmek isteniyor */
  targetStatus?: PermissionStatus;
  onClose: () => void;
  onSuccess: (newStatus: PermissionStatus) => void;
}

export const PermissionGateModal = ({
  visible,
  permissionGate,
  eventBus,
  targetStatus,
  onClose,
  onSuccess,
}: PermissionGateModalProps) => {
  const [currentStatus, setCurrentStatus] = useState<PermissionStatus>(
    () => permissionGate.getStatus(),
  );
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // ─── Unmount guard (§ 14.6) ───────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ─── Permission event dinle ───────────────────────────────────────────

  useEffect(() => {
    const unsub = eventBus.on(
      "permission:status:changed",
      (payload: { status: PermissionStatus }) => {
        if (mountedRef.current) setCurrentStatus(payload.status);
      },
    );
    return () => unsub();
  }, [eventBus]);

  // ─── Hangi step? ──────────────────────────────────────────────────────

  const stepKey: string | null = (() => {
    if (currentStatus === "DISABLED") return "enableLocal";
    if (currentStatus === "LOCAL_ONLY" && targetStatus === "CLOUD_ENABLED") return "enableCloud";
    return null;
  })();

  const stepConfig = stepKey ? STEPS[stepKey] : null;

  // ─── Geçiş ────────────────────────────────────────────────────────────

  const handleConfirm = useCallback(async () => {
    if (!stepConfig) return;
    if (isTransitioning) return;

    setIsTransitioning(true);
    setErrorMessage(null);

    const result = await permissionGate.transition(stepConfig.targetStatus);

    if (!mountedRef.current) return;

    setIsTransitioning(false);

    if (!result.ok) {
      setErrorMessage(result.message ?? "Geçiş başarısız.");
      return;
    }

    setCurrentStatus(stepConfig.targetStatus);
    onSuccess(stepConfig.targetStatus);
    onClose();
  }, [stepConfig, isTransitioning, permissionGate, onSuccess, onClose]);

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={isTransitioning ? undefined : onClose} />

      <View style={styles.dialog}>
        <ScrollView contentContainerStyle={styles.scrollContent} bounces={false}>
          {/* Mevcut durum göstergesi */}
          <View style={styles.statusBar}>
            <StatusStep label="Devre Dışı" active={currentStatus === "DISABLED"} done={currentStatus !== "DISABLED"} />
            <View style={styles.statusLine} />
            <StatusStep label="Offline" active={currentStatus === "LOCAL_ONLY"} done={currentStatus === "CLOUD_ENABLED"} />
            <View style={styles.statusLine} />
            <StatusStep label="Cloud" active={currentStatus === "CLOUD_ENABLED"} done={false} />
          </View>

          {/* İçerik */}
          {stepConfig ? (
            <PermissionStep
              config={stepConfig}
              isTransitioning={isTransitioning}
              onConfirm={handleConfirm}
              onCancel={onClose}
            />
          ) : (
            <AlreadyActiveState status={currentStatus} onClose={onClose} />
          )}

          {/* Hata mesajı */}
          {errorMessage && (
            <View style={styles.errorBox}>
              <Text style={styles.errorBoxText}>⚠ {errorMessage}</Text>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
};

// ─── StatusStep ─────────────────────────────────────────────────────────────

const StatusStep = ({ label, active, done }: { label: string; active: boolean; done: boolean }) => (
  <View style={styles.statusStep}>
    <View style={[styles.statusDot, active && styles.statusDotActive, done && styles.statusDotDone]}>
      <Text style={styles.statusDotText}>{done ? "✓" : ""}</Text>
    </View>
    <Text style={[styles.statusLabel, active && styles.statusLabelActive]}>{label}</Text>
  </View>
);

// ─── AlreadyActive ───────────────────────────────────────────────────────────

const AlreadyActiveState = ({ status, onClose }: { status: PermissionStatus; onClose: () => void }) => (
  <View style={styles.alreadyActive}>
    <Text style={styles.alreadyActiveIcon}>✅</Text>
    <Text style={styles.alreadyActiveTitle}>
      {status === "CLOUD_ENABLED" ? "Cloud AI Etkin" : "Offline AI Etkin"}
    </Text>
    <Text style={styles.alreadyActiveDesc}>
      {status === "CLOUD_ENABLED"
        ? "Tüm modeller kullanılabilir."
        : "Offline modeller aktif. Cloud için yükselt."}
    </Text>
    <TouchableOpacity style={styles.doneBtn} onPress={onClose}>
      <Text style={styles.doneBtnText}>Tamam</Text>
    </TouchableOpacity>
  </View>
);

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.7)",
  },
  dialog: {
    position: "absolute",
    left: 20,
    right: 20,
    top: "15%",
    backgroundColor: "#1e1e2e",
    borderRadius: 16,
    overflow: "hidden",
    maxHeight: "75%",
  },
  scrollContent: { paddingBottom: 24 },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#313244",
    gap: 4,
  },
  statusLine: {
    flex: 1,
    height: 2,
    backgroundColor: "#313244",
    marginHorizontal: 4,
  },
  statusStep: { alignItems: "center", gap: 4 },
  statusDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#313244",
    alignItems: "center",
    justifyContent: "center",
  },
  statusDotActive: { backgroundColor: "#4f46e5" },
  statusDotDone: { backgroundColor: "#40a02b" },
  statusDotText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  statusLabel: { color: "#585868", fontSize: 10 },
  statusLabelActive: { color: "#cdd6f4" },
  stepContainer: { padding: 24 },
  stepIcon: { fontSize: 40, textAlign: "center", marginBottom: 12 },
  stepTitle: {
    color: "#cdd6f4",
    fontSize: 18,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 10,
  },
  stepDescription: {
    color: "#a6adc8",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginBottom: 16,
  },
  bulletList: {
    backgroundColor: "#181825",
    borderRadius: 10,
    padding: 14,
    gap: 8,
    marginBottom: 20,
  },
  bulletRow: { flexDirection: "row", gap: 8 },
  bulletDot: { color: "#4f46e5", fontSize: 14, lineHeight: 20 },
  bulletText: { flex: 1, color: "#a6adc8", fontSize: 13, lineHeight: 20 },
  consentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 20,
    paddingHorizontal: 4,
  },
  consentLabel: {
    flex: 1,
    color: "#cdd6f4",
    fontSize: 13,
    lineHeight: 18,
  },
  btnRow: {
    flexDirection: "row",
    gap: 12,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "#313244",
    alignItems: "center",
  },
  cancelBtnText: { color: "#a6adc8", fontSize: 14, fontWeight: "600" },
  confirmBtn: {
    flex: 2,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "#4f46e5",
    alignItems: "center",
  },
  confirmBtnDisabled: { backgroundColor: "#2e2e3e" },
  confirmBtnText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  errorBox: {
    marginHorizontal: 24,
    padding: 12,
    backgroundColor: "#450a0a",
    borderRadius: 8,
  },
  errorBoxText: { color: "#fca5a5", fontSize: 13 },
  alreadyActive: { padding: 32, alignItems: "center" },
  alreadyActiveIcon: { fontSize: 40, marginBottom: 12 },
  alreadyActiveTitle: {
    color: "#cdd6f4",
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 8,
  },
  alreadyActiveDesc: {
    color: "#a6adc8",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 24,
  },
  doneBtn: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    backgroundColor: "#4f46e5",
    borderRadius: 10,
  },
  doneBtnText: { color: "#fff", fontSize: 14, fontWeight: "700" },
});
