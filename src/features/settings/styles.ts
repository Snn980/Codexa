import { StyleSheet, Platform } from "react-native";

export const COLORS = {
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

export const styles = StyleSheet.create({
  container:           { flex: 1, backgroundColor: COLORS.bg },
  center:              { alignItems: "center", justifyContent: "center" },
  header:              { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  headerTitle:         { fontSize: 15, fontWeight: "700", color: COLORS.text, fontFamily: MONO },
  headerRight:         { flexDirection: "row", alignItems: "center" },
  resetText:           { fontSize: 12, color: COLORS.muted, fontFamily: MONO },
  content:             { padding: 12, gap: 16, paddingBottom: 40 },
  section:             { gap: 6 },
  sectionTitle:        { fontSize: 10, color: COLORS.muted, fontFamily: MONO, letterSpacing: 0.8, textTransform: "uppercase", paddingLeft: 4 },
  sectionCard:         { backgroundColor: COLORS.surface, borderRadius: 10, borderWidth: 1, borderColor: COLORS.border, overflow: "hidden" },
  row:                 { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  rowLeft:             { flex: 1, gap: 2 },
  rowLabel:            { fontSize: 13, color: COLORS.text, fontFamily: MONO },
  rowDesc:             { fontSize: 10, color: COLORS.muted, fontFamily: MONO },
  infoValue:           { fontSize: 12, color: COLORS.muted, fontFamily: MONO },
  stepper:             { flexDirection: "row", alignItems: "center", gap: 8 },
  stepBtn:             { width: 28, height: 28, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.05)", alignItems: "center", justifyContent: "center" },
  stepBtnText:         { fontSize: 16, color: COLORS.text, lineHeight: 20 },
  stepBtnDisabled:     { color: COLORS.subtle },
  stepValue:           { fontSize: 12, color: COLORS.text, fontFamily: MONO, minWidth: 60, textAlign: "center" },
  segmentRow:          { paddingHorizontal: 14, paddingVertical: 10, gap: 8, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  segmentControl:      { flexDirection: "row", backgroundColor: "rgba(0,0,0,0.3)", borderRadius: 8, padding: 3, gap: 2 },
  segmentOption:       { flex: 1, paddingVertical: 6, borderRadius: 6, alignItems: "center" },
  segmentOptionActive: { backgroundColor: COLORS.surface },
  segmentText:         { fontSize: 11, color: COLORS.muted, fontFamily: MONO },
  segmentTextActive:   { color: COLORS.text },
  apiRow:              { paddingHorizontal: 14, paddingVertical: 10, gap: 6, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  apiInput:            { backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 8, borderWidth: 1, borderColor: COLORS.border, paddingHorizontal: 10, paddingVertical: 8, fontSize: 12, color: COLORS.text, fontFamily: MONO },
  saveBtn:             { margin: 14, backgroundColor: COLORS.accent, borderRadius: 8, paddingVertical: 10, alignItems: "center" },
  saveBtnText:         { fontSize: 13, color: "#fff", fontWeight: "700", fontFamily: MONO },
});
