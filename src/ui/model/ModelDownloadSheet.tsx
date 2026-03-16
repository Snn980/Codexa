/**
 * ui/model/ModelDownloadSheet.tsx — Model indirme progress UI
 *
 * § 3  : IEventBus unsub cleanup
 * § 8  : React.memo, useRef
 *
 * DÜZELTMELER:
 *   ❗ EVENTBUS CLEANUP : useEffect unsub array'i düzgün temizleniyor.
 *      Önceki impl unsubs.forEach(u => u()) döndürüyordu ama deps eksikti;
 *      şimdi stable ref'ler + doğru dependency array.
 *   💡 GLOBAL STATE    : states, downloadManager'dan prop olarak alınmaz;
 *      component mount'ta getState() ile initialize edilir ve eventBus
 *      sayesinde reload'dan sonra da güncel kalır (manager ref stable).
 *   💡 VIRTUALIZATION  : 3 model (Gemma3-1B, Gemma3-4B, Phi-4 Mini) için
 *      virtualization gereksiz; liste sabit ve küçük. Yorum ile belgelenmiştir.
 */

import React, {
  useState, useEffect, useCallback, useRef, memo,
} from "react";
import {
  View, Text, TouchableOpacity, Modal, Pressable,
  StyleSheet, ActivityIndicator,
} from "react-native";

import type { ModelDownloadManager, DownloadState } from "../../download/ModelDownloadManager";
import type { IEventBus } from "../../core/EventBus";
import type { AIModelId, GGUFMeta } from "../../ai/AIModels";
import { AI_MODELS } from "../../ai/AIModels";

// ─── ProgressBar ──────────────────────────────────────────────────────────────

const ProgressBar = memo(({ percent }: { percent: number }) => (
  <View style={styles.progressTrack}>
    <View style={[styles.progressFill, { width: `${Math.min(100, percent)}%` }]} />
  </View>
));
ProgressBar.displayName = "ProgressBar";

// ─── DownloadRow ──────────────────────────────────────────────────────────────

interface DownloadRowProps {
  modelId: AIModelId;
  gguf: GGUFMeta;
  state: DownloadState;
  onStart: (id: AIModelId) => void;
  onCancel: (id: AIModelId) => void;
}

const DownloadRow = memo(({ modelId, gguf, state, onStart, onCancel }: DownloadRowProps) => {
  const model      = AI_MODELS.find((m) => m.id === modelId);
  const handleStart  = useCallback(() => onStart(modelId),  [modelId, onStart]);
  const handleCancel = useCallback(() => onCancel(modelId), [modelId, onCancel]);
  const sizeLbl    = gguf.sizeMB >= 1000
    ? `${(gguf.sizeMB / 1024).toFixed(1)} GB`
    : `${gguf.sizeMB} MB`;

  return (
    <View style={styles.downloadRow}>
      <View style={styles.rowInfo}>
        <Text style={styles.modelName}>{model?.displayName ?? modelId}</Text>
        <Text style={styles.modelMeta}>{sizeLbl} · {gguf.quantization}</Text>
      </View>

      <View style={styles.rowStatus}>
        {(state.status === "idle" || state.status === "cancelled") && (
          <TouchableOpacity style={styles.downloadBtn} onPress={handleStart}>
            <Text style={styles.downloadBtnText}>
              {state.status === "cancelled" ? "Yeniden İndir" : "İndir"}
            </Text>
          </TouchableOpacity>
        )}

        {state.status === "checking" && (
          <ActivityIndicator size="small" color="#7c7cff" />
        )}

        {(state.status === "downloading" || state.status === "verifying") && (
          <View style={styles.downloadingBox}>
            <ProgressBar percent={state.percent} />
            <View style={styles.downloadingMeta}>
              <Text style={styles.progressText}>
                {state.status === "verifying"
                  ? "Doğrulanıyor…"
                  : `${state.receivedMB.toFixed(1)} / ${state.totalMB.toFixed(1)} MB (${state.percent}%)`}
                {state.resumable ? " ↺" : ""}
              </Text>
              {state.status === "downloading" && (
                <TouchableOpacity onPress={handleCancel}>
                  <Text style={styles.cancelText}>İptal</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {state.status === "complete" && (
          <View style={styles.completeBadge}>
            <Text style={styles.completeBadgeText}>✓ Hazır</Text>
          </View>
        )}

        {state.status === "error" && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText} numberOfLines={2}>
              ⚠ {state.errorMessage ?? state.errorCode}
            </Text>
            <TouchableOpacity onPress={handleStart}>
              <Text style={styles.retryText}>Tekrar Dene</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
});
DownloadRow.displayName = "DownloadRow";

// ─── ModelDownloadSheet ───────────────────────────────────────────────────────

export interface ModelDownloadSheetProps {
  visible: boolean;
  downloadManager: ModelDownloadManager;
  eventBus: IEventBus;
  onClose: () => void;
}

const PROGRESS_EVENTS = [
  "model:download:start",
  "model:download:progress",
  "model:download:complete",
  "model:download:error",
  "model:download:cancel",
] as const;

export const ModelDownloadSheet = ({
  visible,
  downloadManager,
  eventBus,
  onClose,
}: ModelDownloadSheetProps) => {
  const offlineModels = AI_MODELS.filter((m) => m.gguf != null);

  // 💡 GLOBAL STATE: manager ref sabit; mount'ta initialize, eventBus ile güncellenir
  const [states, setStates] = useState<Map<AIModelId, DownloadState>>(() =>
    new Map(offlineModels.map((m) => [m.id, downloadManager.getState(m.id)])),
  );

  // ❗ EVENTBUS CLEANUP: stable handler ref
  const downloadManagerRef = useRef(downloadManager);
  downloadManagerRef.current = downloadManager;

  useEffect(() => {
    // Component görünür olduğunda güncel state'i çek (reload sonrası)
    setStates(new Map(offlineModels.map((m) => [m.id, downloadManagerRef.current.getState(m.id)])));

    const handler = (payload: unknown) => {
      const { modelId } = payload as { modelId: AIModelId };
      setStates((prev) => {
        const next = new Map(prev);
        next.set(modelId, downloadManagerRef.current.getState(modelId));
        return next;
      });
    };

    // ❗ EVENTBUS CLEANUP: tüm eventler için tek handler, temiz unsub array
    const unsubs = PROGRESS_EVENTS.map((event) => eventBus.on(event, handler));
    return () => {
      for (const unsub of unsubs) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, eventBus]); // visible değişince state yenilenir

  const handleStart = useCallback(async (modelId: AIModelId) => {
    await downloadManagerRef.current.startDownload(modelId);
  }, []);

  const handleCancel = useCallback((modelId: AIModelId) => {
    downloadManagerRef.current.cancelDownload(modelId);
  }, []);

  // 💡 VIRTUALIZATION: liste 3 model — FlatList overhead gereksiz;
  // model sayısı N > 10 olursa FlashList (Shopify) önerilir.
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Offline Modeller</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>✕</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.infoBox}>
          <Text style={styles.infoText}>
            Modeller cihazınıza indirilir. İnternetsiz kullanılabilir.
          </Text>
        </View>
        <View style={styles.modelList}>
          {offlineModels.map((model) => (
            <DownloadRow
              key={model.id}
              modelId={model.id}
              gguf={model.gguf!}
              state={states.get(model.id) ?? downloadManagerRef.current.getState(model.id)}
              onStart={handleStart}
              onCancel={handleCancel}
            />
          ))}
        </View>
      </View>
    </Modal>
  );
};

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop:         { flex: 1, backgroundColor: "rgba(0,0,0,0.6)" },
  sheet:            { backgroundColor: "#1e1e2e", borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 40 },
  handle:           { width: 36, height: 4, borderRadius: 2, backgroundColor: "#45475a", alignSelf: "center", marginTop: 10 },
  header:           { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "#313244" },
  headerTitle:      { color: "#cdd6f4", fontSize: 16, fontWeight: "600" },
  closeBtn:         { padding: 4 },
  closeBtnText:     { color: "#585868", fontSize: 18 },
  infoBox:          { paddingHorizontal: 20, paddingVertical: 10, backgroundColor: "#181825" },
  infoText:         { color: "#585868", fontSize: 12, lineHeight: 18 },
  modelList:        { paddingHorizontal: 16, paddingTop: 8, gap: 4 },
  downloadRow:      { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#1e1e2e", gap: 10 },
  rowInfo:          { gap: 2 },
  modelName:        { color: "#cdd6f4", fontSize: 14, fontWeight: "500" },
  modelMeta:        { color: "#585868", fontSize: 12, fontFamily: "monospace" },
  rowStatus:        {},
  downloadBtn:      { alignSelf: "flex-start", backgroundColor: "#4f46e5", paddingHorizontal: 16, paddingVertical: 6, borderRadius: 8 },
  downloadBtnText:  { color: "#fff", fontSize: 13, fontWeight: "600" },
  downloadingBox:   { gap: 6 },
  progressTrack:    { height: 4, backgroundColor: "#313244", borderRadius: 2, overflow: "hidden" },
  progressFill:     { height: 4, backgroundColor: "#4f46e5", borderRadius: 2 },
  downloadingMeta:  { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  progressText:     { color: "#585868", fontSize: 11, fontFamily: "monospace" },
  cancelText:       { color: "#f38ba8", fontSize: 12 },
  completeBadge:    { alignSelf: "flex-start", backgroundColor: "#1a3a2a", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  completeBadgeText:{ color: "#a6e3a1", fontSize: 12, fontWeight: "600" },
  errorBox:         { gap: 4 },
  errorText:        { color: "#f38ba8", fontSize: 12, lineHeight: 18 },
  retryText:        { color: "#7c7cff", fontSize: 12 },
});
