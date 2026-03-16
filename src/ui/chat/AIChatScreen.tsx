/**
 * ui/chat/AIChatScreen.tsx
 *
 * § 66 — Phase 18: AIChatScreenLegacy kaldırıldı.
 *         Router bileşen artık gerekli değil.
 *         AIChatScreen = AIChatScreenV2 (doğrudan).
 *
 * Geçiş tamamlandı (§ 59):
 *   Phase 16 → useOrchestrator default false
 *   Phase 17 → useOrchestrator default true, Legacy @deprecated
 *   Phase 18 ✓ Legacy silindi, useOrchestrator prop'u kaldırıldı
 *
 * Public API değişikliği:
 *   - AIChatScreenProps artık AIChatScreenV2Props ile aynı
 *   - useOrchestrator prop'u yok (V2 her zaman aktif)
 *   - otaIntervalMs prop'u yok (Legacy'ye özgüydü)
 *
 * § 56 : useAIOrchestrator
 * § 59 : AIChatScreen Orchestrator Migration — tamamlandı
 * § 66 : Legacy kaldırma
 */

export { AIChatScreenV2 as AIChatScreen }  from './AIChatScreenV2';
export type { AIChatScreenV2Props as AIChatScreenProps } from './AIChatScreenV2';

// § 66 — AIChatScreenLegacy artık mevcut değil.
// Doğrudan import edenler varsa AIChatScreenV2'ye geçmeli.
// export { AIChatScreenLegacy } — KALDIRILDI
