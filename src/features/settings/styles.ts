import { StyleSheet, Platform } from "react-native";

export const COLORS = { bg: "#0a0e1a", surface: "#0d1117", border: "rgba(255,255,255,0.06)", accent: "#3b82f6", text: "#f1f5f9", muted: "#475569", subtle: "#334155", };

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

export const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: COLORS.bg }, header: { flexDirection: "row", justifyContent: "space-between", padding: 16 }, headerTitle: { color: COLORS.text, fontFamily: MONO }, resetText: { color: COLORS.muted }, content: { padding: 12 }, section: { marginBottom: 12 }, sectionTitle: { color: COLORS.muted }, sectionCard: { backgroundColor: COLORS.surface }, row: { flexDirection: "row", justifyContent: "space-between", padding: 12 }, rowLeft: { flex: 1 }, rowLabel: { color: COLORS.text }, rowDesc: { color: COLORS.muted }, infoValue: { color: COLORS.muted }, stepper: { flexDirection: "row" }, stepBtn: { padding: 6 }, stepBtnText: { color: COLORS.text }, stepValue: { color: COLORS.text }, segmentRow: { padding: 12 }, segmentControl: { flexDirection: "row" }, segmentOption: { flex: 1 }, segmentOptionActive: {}, segmentText: { color: COLORS.muted }, segmentTextActive: { color: COLORS.text }, });
